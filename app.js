import * as YD from "./yandex-disk.js";

const $ = id => document.getElementById(id);
const STORE = "inotes-notes-v2";
const DELETED_STORE = "inotes-deleted-v2";

let notes = JSON.parse(localStorage.getItem(STORE) || "null");
if (!notes) {
  notes = JSON.parse(localStorage.getItem("inotes-notes-v1") || "[]");
}
let deletedIds = new Set(JSON.parse(localStorage.getItem(DELETED_STORE) || "[]"));
let selectedId = null;
let activeFolder = "all";
let searchTerm = "";
let isSyncing = false;
let syncTimer = null;
let toastTimer = null;
let currentToken = null;
let currentUser = null;

// Аудиозапись
let mediaRecorder = null;
let audioChunks = [];
let recordTimer = null;
let recordSeconds = 0;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function escapeHTML(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function plainText(html = "") {
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.innerText || d.textContent || "").trim();
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 Б";
  const k = 1024, sizes = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Форматирование дат в стиле Apple Notes (Сегодня, 24.02.2026 и т.д.)
function formatNoteDate(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  const isYesterday = new Date(now.setDate(now.getDate() - 1)).toDateString() === d.toDateString();
  if (isYesterday) {
    return "Вчера";
  }
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDetailDate(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) +
    ", " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function persistLocally() {
  localStorage.setItem(STORE, JSON.stringify(notes));
  localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedIds]));
  renderList();
  scheduleCloudSync();
}

// -------------------------------------------------------------
// Синхронизация с Яндекс Диском
// -------------------------------------------------------------
function setSyncStatus(state) {
  const dot = $("syncDot");
  const title = $("syncTitle");
  const subtitle = $("syncSubtitle");

  if (state === "syncing") {
    dot.className = "sync-dot syncing";
    $("saveState").textContent = "Синхронизация…";
    title.textContent = "Синхронизация…";
    subtitle.textContent = "Обновление заметок на Диске";
  } else if (state === "online") {
    dot.className = "sync-dot online";
    $("saveState").textContent = "Сохранено";
    title.textContent = "Яндекс Диск подключён";
    subtitle.textContent = currentUser ? (currentUser.default_email || currentUser.display_name) : "Облако активно";
  } else {
    dot.className = "sync-dot";
    $("saveState").textContent = "Локально";
    title.textContent = "Только на этом устройстве";
    subtitle.textContent = "Нажмите для синхронизации";
  }
}

async function runTwoWaySync() {
  if (!currentToken || isSyncing) return;
  isSyncing = true;
  setSyncStatus("syncing");

  try {
    const remoteData = await YD.fetchRemoteNotes(currentToken);
    const remoteNotes = (remoteData && remoteData.notes) ? remoteData.notes : [];
    const remoteDeleted = new Set((remoteData && remoteData.deletedIds) ? remoteData.deletedIds : []);

    for (const id of remoteDeleted) {
      deletedIds.add(id);
    }
    notes = notes.filter(n => !deletedIds.has(n.id));

    const localMap = new Map(notes.map(n => [n.id, n]));
    const mergedMap = new Map();

    for (const r of remoteNotes) {
      if (deletedIds.has(r.id)) continue;
      const l = localMap.get(r.id);
      if (!l) {
        mergedMap.set(r.id, r);
      } else {
        mergedMap.set(r.id, (r.updated || 0) > (l.updated || 0) ? r : l);
      }
    }

    for (const [id, l] of localMap.entries()) {
      if (!mergedMap.has(id) && !deletedIds.has(id)) {
        mergedMap.set(id, l);
      }
    }

    notes = Array.from(mergedMap.values());
    localStorage.setItem(STORE, JSON.stringify(notes));
    localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedIds]));

    await YD.saveRemoteNotes(currentToken, {
      notes,
      deletedIds: [...deletedIds],
      updatedAt: Date.now()
    });

    renderList();
    if (selectedId && notes.some(n => n.id === selectedId)) {
      renderAttachments(notes.find(n => n.id === selectedId));
    }

    setSyncStatus("online");
  } catch (err) {
    console.error("Sync error:", err);
    setSyncStatus("online");
  } finally {
    isSyncing = false;
  }
}

function scheduleCloudSync(debounceMs = 1500) {
  if (!currentToken) return;
  $("saveState").textContent = "Ожидает отправки…";
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runTwoWaySync, debounceMs);
}

// -------------------------------------------------------------
// Группировка заметок по разделам Apple Notes (Screenshot 2)
// -------------------------------------------------------------
function groupNotesByDate(noteList) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sevenDaysAgo = startOfToday - 7 * 86400000;
  const thirtyDaysAgo = startOfToday - 30 * 86400000;

  const groups = {
    pinned: [],
    today: [],
    sevenDays: [],
    thirtyDays: [],
    older: []
  };

  for (const n of noteList) {
    if (n.pinned && activeFolder !== "trash") {
      groups.pinned.push(n);
      continue;
    }
    const t = n.updated || n.trashedAt || Date.now();
    if (t >= startOfToday) {
      groups.today.push(n);
    } else if (t >= sevenDaysAgo) {
      groups.sevenDays.push(n);
    } else if (t >= thirtyDaysAgo) {
      groups.thirtyDays.push(n);
    } else {
      groups.older.push(n);
    }
  }

  return groups;
}

// -------------------------------------------------------------
// Рендер списка заметок (Apple Notes List View)
// -------------------------------------------------------------
function renderList() {
  const inTrash = activeFolder === "trash";

  const filtered = notes.filter(n => {
    if (inTrash) {
      if (!n.trashed) return false;
    } else {
      if (n.trashed) return false;
      if (activeFolder !== "all" && n.folder !== activeFolder) return false;
    }

    const q = searchTerm.toLowerCase();
    if (q) {
      const match = (n.title || "").toLowerCase().includes(q) || plainText(n.body).toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (b.updated || 0) - (a.updated || 0));

  const activeNotes = notes.filter(n => !n.trashed);
  const trashNotes = notes.filter(n => n.trashed);

  $("allCount").textContent = activeNotes.length;
  $("personalCount").textContent = activeNotes.filter(n => n.folder === "personal").length;
  $("workCount").textContent = activeNotes.filter(n => n.folder === "work").length;
  $("trashCount").textContent = trashNotes.length;

  // Заголовок верхней панели
  if (inTrash) {
    $("folderTitle").textContent = "Недавно удалённые";
    $("emptyTrashBtn").style.display = trashNotes.length ? "flex" : "none";
    $("backBtnText").textContent = "Корзина";
  } else {
    $("folderTitle").textContent = ({ all: "Все заметки", personal: "Личные", work: "Работа" })[activeFolder] || "Заметки";
    $("emptyTrashBtn").style.display = "none";
    $("backBtnText").textContent = "Заметки";
  }

  $("notesCount").textContent = `${filtered.length} ${filtered.length === 1 ? "заметка" : "заметок"}`;

  if (filtered.length === 0) {
    $("notesList").innerHTML = "";
    $("emptyState").classList.add("show");
    if (inTrash) {
      $("emptyIcon").textContent = "🗑️";
      $("emptyTitle").textContent = "Корзина пуста";
      $("emptyText").textContent = "Удалённые заметки будут отображаться здесь.";
    } else {
      $("emptyIcon").textContent = "✎";
      $("emptyTitle").textContent = "Пока нет заметок";
      $("emptyText").textContent = "Нажмите значок 📝 внизу для создания первой заметки.";
    }
    return;
  }

  $("emptyState").classList.remove("show");

  // Разбиваем заметки на группы в стиле Apple Notes (Screenshot 2)
  const groups = groupNotesByDate(filtered);
  const sectionConfigs = [
    { key: "pinned", title: "Закреплено" },
    { key: "today", title: "Сегодня" },
    { key: "sevenDays", title: "Предыдущие 7 дней" },
    { key: "thirtyDays", title: "Предыдущие 30 дней" },
    { key: "older", title: "Ранее" }
  ];

  let html = "";
  for (const s of sectionConfigs) {
    const list = groups[s.key];
    if (!list || list.length === 0) continue;

    html += `
      <div class="section-group">
        <div class="section-header-title">${s.title}</div>
        <div class="grouped-card">
          ${list.map(n => renderNoteRow(n)).join("")}
        </div>
      </div>
    `;
  }

  $("notesList").innerHTML = html;
  document.querySelectorAll(".folder").forEach(b => b.classList.toggle("active", b.dataset.folder === activeFolder));
}

// Рендер строки заметки (как в Screenshot 2: заголовок, дата, текст и превью справа)
function renderNoteRow(n) {
  const title = escapeHTML(n.title || "Без названия");
  const dateStr = formatNoteDate(n.updated);
  const bodySnippet = plainText(n.body) || "Нет текста";

  // Проверяем наличие фото/скана для правого мини-превью
  const firstMedia = (n.attachments || []).find(a => a.category === "photo" && a.url);
  const thumbHtml = firstMedia
    ? `<img class="note-item-thumb" src="${escapeHTML(firstMedia.url)}" alt="превью" loading="lazy">`
    : "";

  let snippetText = escapeHTML(bodySnippet);
  const attCount = (n.attachments || []).length;
  if (attCount > 0 && !bodySnippet) {
    snippetText = `${attCount} вложенных файлов`;
  }

  const folderName = n.folder === "work" ? "Работа" : "Заметки";

  return `
    <div class="note-item-row ${n.id === selectedId ? "selected" : ""}" data-id="${escapeHTML(n.id)}">
      <div class="note-item-left">
        <div class="note-item-title">${title}</div>
        <div class="note-item-subline">
          <span class="note-item-date">${dateStr}</span>
          <span class="note-item-snippet">${snippetText}</span>
        </div>
        <div class="note-item-folder">📁 ${folderName}</div>
      </div>
      ${thumbHtml}
    </div>
  `;
}

// -------------------------------------------------------------
// Открытие заметки и отображение контента (Apple Notes Flow)
// -------------------------------------------------------------
function openNote(id) {
  selectedId = id;
  const n = notes.find(x => x.id === id);
  if (!n) return;

  $("noteTitle").value = n.title || "";
  $("noteBody").innerHTML = n.body || "";
  $("noteMeta").textContent = formatDetailDate(n.updated);
  $("pinBtn").classList.toggle("active", !!n.pinned);
  $("pinIcon").textContent = n.pinned ? "★" : "⌑";

  if (n.trashed) {
    $("normalActions").style.display = "none";
    $("trashActions").style.display = "flex";
    $("editorBottomBar").style.display = "none";
    $("noteTitle").disabled = true;
    $("noteBody").contentEditable = "false";
  } else {
    $("normalActions").style.display = "flex";
    $("trashActions").style.display = "none";
    $("editorBottomBar").style.display = "flex";
    $("noteTitle").disabled = false;
    $("noteBody").contentEditable = "true";
  }

  // Обновляем вложения прямо в потоке документа
  renderAttachments(n);

  $("editorPane").classList.add("mobile-open");
  renderList();

  // Прокручиваем редактор наверх при открытии новой заметки
  $("editorScrollArea").scrollTop = 0;
}

function closeEditor() {
  $("editorPane").classList.remove("mobile-open");
}

function createNote() {
  if (activeFolder === "trash") {
    activeFolder = "all";
  }
  const n = {
    id: uid(),
    title: "",
    body: "",
    folder: activeFolder === "work" ? "work" : "personal",
    pinned: false,
    trashed: false,
    attachments: [],
    updated: Date.now()
  };
  notes.unshift(n);
  selectedId = n.id;
  persistLocally();
  openNote(n.id);
  $("noteTitle").focus();
}

function updateSelected(patch) {
  const n = notes.find(x => x.id === selectedId);
  if (!n || n.trashed) return;
  Object.assign(n, patch, { updated: Date.now() });
  $("noteMeta").textContent = formatDetailDate(n.updated);
  persistLocally();
}

// Удаление в корзину
function moveToTrash() {
  if (!selectedId) return;
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  n.trashed = true;
  n.trashedAt = Date.now();
  n.pinned = false;
  persistLocally();

  const next = notes.find(x => !x.trashed);
  selectedId = next?.id || null;
  if (selectedId) {
    openNote(selectedId);
  } else {
    $("noteTitle").value = "";
    $("noteBody").innerHTML = "";
    $("noteAttachments").innerHTML = "";
    closeEditor();
  }
  toast("Заметка перемещена в корзину");
}

// Восстановление
function restoreFromTrash() {
  if (!selectedId) return;
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  n.trashed = false;
  delete n.trashedAt;
  n.updated = Date.now();
  persistLocally();

  activeFolder = "all";
  renderList();
  openNote(n.id);
  toast("Заметка восстановлена!");
}

// Удаление навсегда
function deletePermanently() {
  if (!selectedId) return;
  if (!confirm("Удалить заметку навсегда? Это действие нельзя отменить.")) return;

  const id = selectedId;
  const n = notes.find(x => x.id === id);
  if (n && n.attachments && currentToken) {
    for (const a of n.attachments) {
      if (a.path) YD.deleteRemoteFile(currentToken, a.path);
    }
  }

  deletedIds.add(id);
  notes = notes.filter(x => x.id !== id);
  selectedId = notes.find(x => x.trashed)?.id || notes[0]?.id || null;
  persistLocally();

  if (selectedId) openNote(selectedId);
  else closeEditor();
  toast("Заметка удалена навсегда");
}

function emptyTrash() {
  const count = notes.filter(n => n.trashed).length;
  if (!count) return;
  if (!confirm(`Очистить корзину (${count} заметок)? Все они будут удалены навсегда.`)) return;

  for (const n of notes.filter(n => n.trashed)) {
    deletedIds.add(n.id);
    if (n.attachments && currentToken) {
      for (const a of n.attachments) {
        if (a.path) YD.deleteRemoteFile(currentToken, a.path);
      }
    }
  }

  notes = notes.filter(n => !n.trashed);
  selectedId = notes[0]?.id || null;
  persistLocally();
  if (selectedId) openNote(selectedId);
  else closeEditor();
  toast("Корзина очищена");
}

// -------------------------------------------------------------
// Рендер вложений прямо в потоке документа (Screenshot 3)
// -------------------------------------------------------------
async function renderAttachments(note) {
  const container = $("noteAttachments");
  if (!note || !note.attachments || note.attachments.length === 0) {
    container.innerHTML = "";
    return;
  }

  // Обновляем ссылки на скачивание, если они истекли
  if (currentToken) {
    for (const att of note.attachments) {
      if (!att.url || (att.urlExpires && att.urlExpires < Date.now() + 60000)) {
        YD.getFileDownloadUrl(currentToken, att.path).then(freshUrl => {
          if (freshUrl) {
            att.url = freshUrl;
            att.urlExpires = Date.now() + 3 * 3600 * 1000;
            const el = container.querySelector(`[data-att-id="${att.id}"] img, [data-att-id="${att.id}"] video, [data-att-id="${att.id}"] a`);
            if (el) {
              if (el.tagName === "IMG" || el.tagName === "VIDEO") el.src = freshUrl;
              if (el.tagName === "A") el.href = freshUrl;
            }
          }
        });
      }
    }
  }

  container.innerHTML = note.attachments.map(att => renderAttachmentItem(att, !!note.trashed)).join("");
}

function renderAttachmentItem(att, isNoteTrashed) {
  const id = escapeHTML(att.id);
  const name = escapeHTML(att.name || "Файл");
  const size = formatBytes(att.size);
  const safeUrl = escapeHTML(att.url || "#");
  const delBtn = isNoteTrashed ? "" : `<button class="att-del" onclick="window.__inotesDeleteAtt('${id}')" title="Удалить файл">✕</button>`;

  // 1. Фото / Скан (Screenshot 3 — фото во всю ширину, закруглённые углы)
  if (att.category === "photo") {
    return `
      <div class="attachment-media-card" data-att-id="${id}">
        <img class="att-image-preview" src="${safeUrl}" alt="${name}" loading="lazy" onclick="window.__inotesOpenLightbox('${safeUrl}')">
        <div class="attachment-media-bar">
          <div>
            <div style="font-size:13px;font-weight:600;">${name}</div>
            <div style="font-size:11px;color:var(--text-muted);">${size} · Фото</div>
          </div>
          <div class="att-actions">
            <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
            ${delBtn}
          </div>
        </div>
      </div>
    `;
  }

  // 2. Видео
  if (att.category === "video") {
    return `
      <div class="attachment-media-card" data-att-id="${id}">
        <video class="att-video-preview" src="${safeUrl}" controls preload="metadata"></video>
        <div class="attachment-media-bar">
          <div>
            <div style="font-size:13px;font-weight:600;">${name}</div>
            <div style="font-size:11px;color:var(--text-muted);">${size} · Видео</div>
          </div>
          <div class="att-actions">
            <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
            ${delBtn}
          </div>
        </div>
      </div>
    `;
  }

  // 3. Аудио / Диктофон
  if (att.category === "audio") {
    return `
      <div class="attachment-card" data-att-id="${id}">
        <div class="att-icon">🎙️</div>
        <div class="att-info">
          <div class="att-name">${name}</div>
          <audio src="${safeUrl}" controls style="width:100%;height:34px;margin-top:6px;"></audio>
          <div class="att-meta">${size} · Голосовая заметка</div>
        </div>
        <div class="att-actions">${delBtn}</div>
      </div>
    `;
  }

  // 4. Документы
  let icon = "📄";
  if (name.endsWith(".pdf")) icon = "📕";
  else if (/\.(docx?|pages|txt|rtf)$/i.test(name)) icon = "📘";
  else if (/\.(xlsx?|numbers|csv)$/i.test(name)) icon = "📗";
  else if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) icon = "📦";

  return `
    <div class="attachment-card" data-att-id="${id}">
      <div class="att-icon">${icon}</div>
      <div class="att-info">
        <div class="att-name" title="${name}">${name}</div>
        <div class="att-meta">${size} · ${att.label || "Документ"}</div>
      </div>
      <div class="att-actions">
        <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Открыть</a>
        ${delBtn}
      </div>
    </div>
  `;
}

// Полноэкранный просмотр фото (Лайтбокс)
window.__inotesOpenLightbox = function(url) {
  $("lightboxImg").src = url;
  $("lightboxModal").hidden = false;
};
$("closeLightbox").onclick = () => {
  $("lightboxModal").hidden = true;
  $("lightboxImg").src = "";
};

window.__inotesDeleteAtt = async function(attId) {
  const n = notes.find(x => x.id === selectedId);
  if (!n || n.trashed) return;
  const att = (n.attachments || []).find(a => a.id === attId);
  if (!att) return;
  if (!confirm(`Удалить файл «${att.name}»?`)) return;

  n.attachments = n.attachments.filter(a => a.id !== attId);
  n.updated = Date.now();
  persistLocally();
  renderAttachments(n);
  toast("Файл удалён");

  if (currentToken && att.path) {
    YD.deleteRemoteFile(currentToken, att.path);
  }
};

// -------------------------------------------------------------
// Загрузка файлов на Яндекс Диск (до 200 МБ)
// -------------------------------------------------------------
async function handleFilesUpload(files) {
  if (!files || files.length === 0) return;
  if (!currentToken) {
    toast("Войдите в Яндекс ID для сохранения файлов");
    $("authModal").hidden = false;
    return;
  }
  const n = notes.find(x => x.id === selectedId);
  if (!n || n.trashed) return;
  if (!n.attachments) n.attachments = [];

  const progressWrap = $("uploadProgressWrap");
  const fileNameEl = $("uploadFileName");
  const percentEl = $("uploadPercent");
  const fillEl = $("uploadProgressFill");

  progressWrap.hidden = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    fileNameEl.textContent = `Загрузка: ${file.name}`;
    fillEl.style.width = "0%";
    percentEl.textContent = "0%";

    try {
      const att = await YD.uploadAttachment(currentToken, file, (progress) => {
        fillEl.style.width = `${progress.percent}%`;
        percentEl.textContent = `${progress.percent}% (${formatBytes(progress.loaded)} / ${formatBytes(progress.total)})`;
      });
      n.attachments.push(att);
      n.updated = Date.now();
      persistLocally();
      renderAttachments(n);
      toast(`Загружено: ${file.name}`);
    } catch (err) {
      console.error(err);
      alert(`Ошибка при загрузке ${file.name}: ${err.message}`);
    }
  }

  progressWrap.hidden = true;
}

// -------------------------------------------------------------
// Скан документа с камеры
// -------------------------------------------------------------
function scanDocumentWithCamera() {
  $("cameraPicker").click();
}

async function processScannedPhoto(file) {
  if (!file) return;
  toast("Обработка скана документа…");

  const img = new Image();
  const reader = new FileReader();

  reader.onload = e => {
    img.src = e.target.result;
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const enhanced = v > 140 ? Math.min(255, v * 1.15) : Math.max(0, v * 0.85);
        data[i] = enhanced;
        data[i + 1] = enhanced;
        data[i + 2] = enhanced;
      }
      ctx.putImageData(imgData, 0, 0);

      canvas.toBlob(async blob => {
        if (!blob) return;
        const scanFile = new File([blob], `Скан_${new Date().toISOString().slice(0, 10)}.jpg`, { type: "image/jpeg" });
        await handleFilesUpload([scanFile]);
      }, "image/jpeg", 0.9);
    };
  };
  reader.readAsDataURL(file);
}

// -------------------------------------------------------------
// Голосовые заметки
// -------------------------------------------------------------
async function toggleVoiceRecording() {
  const micBtn = $("micBtn");
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      clearInterval(recordTimer);
      micBtn.classList.remove("active");
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      stream.getTracks().forEach(t => t.stop());

      if (blob.size < 1000) return;
      const audioFile = new File([blob], `Голос_${new Date().toLocaleTimeString("ru-RU").replace(/:/g, '-')}.webm`, { type: "audio/webm" });
      await handleFilesUpload([audioFile]);
    };

    mediaRecorder.start();
    micBtn.classList.add("active");
    recordSeconds = 0;
    toast("Идёт запись голоса… Нажмите микрофон ещё раз для остановки.");

    recordTimer = setInterval(() => {
      recordSeconds++;
      $("saveState").textContent = `Запись: ${recordSeconds}с`;
    }, 1000);

  } catch (err) {
    alert("Разрешите доступ к микрофону для записи голосовых заметок.");
  }
}

// -------------------------------------------------------------
// Авторизация Яндекс OAuth
// -------------------------------------------------------------
async function checkAuthAndInit() {
  const tokenFromUrl = YD.parseTokenFromUrl();
  currentToken = tokenFromUrl || YD.getStoredToken();

  if (currentToken) {
    try {
      currentUser = await YD.getUserInfo(currentToken);
      if (currentUser) {
        setSyncStatus("online");
        $("accountLabel").textContent = currentUser.display_name || currentUser.default_email;
        $("authHeading").textContent = "Яндекс Диск подключён";
        $("authSubtitle").textContent = "Синхронизация работает автоматически";
        $("authLoggedOut").hidden = true;
        $("authLoggedIn").hidden = false;
        $("userName").textContent = currentUser.display_name || "Пользователь";
        $("userEmail").textContent = currentUser.default_email || "";

        YD.initDiskStructure(currentToken).then(() => {
          runTwoWaySync();
        });

        YD.getDiskInfo(currentToken).then(info => {
          if (info && info.total_space) {
            const used = formatBytes(info.used_space);
            const total = formatBytes(info.total_space);
            $("diskUsage").textContent = `Место на Диске: ${used} из ${total}`;
          }
        });
      } else {
        YD.removeStoredToken();
        currentToken = null;
        setSyncStatus("offline");
      }
    } catch (e) {
      setSyncStatus("offline");
    }
  } else {
    setSyncStatus("offline");
  }
}

// -------------------------------------------------------------
// Слушатели событий
// -------------------------------------------------------------
$("notesList").addEventListener("click", e => {
  const row = e.target.closest(".note-item-row");
  if (row) openNote(row.dataset.id);
});

$("newNoteBtn").onclick = $("editorNewBtn").onclick = createNote;
$("backBtn").onclick = closeEditor;
$("menuBtn").onclick = () => $("sidebar").classList.toggle("open");

$("noteTitle").addEventListener("input", () => updateSelected({ title: $("noteTitle").value }));
$("noteBody").addEventListener("input", () => updateSelected({ body: $("noteBody").innerHTML }));

$("pinBtn").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (n) {
    updateSelected({ pinned: !n.pinned });
    $("pinBtn").classList.toggle("active", !!n.pinned);
    $("pinIcon").textContent = n.pinned ? "★" : "⌑";
  }
};

$("deleteBtn").onclick = moveToTrash;
$("restoreBtn").onclick = restoreFromTrash;
$("permDeleteBtn").onclick = deletePermanently;
$("emptyTrashBtn").onclick = emptyTrash;

$("checklistBtn").onclick = () => {
  const el = $("noteBody");
  el.focus();
  document.execCommand("insertHTML", false, '<div><input type="checkbox"> Новая задача</div>');
  updateSelected({ body: el.innerHTML });
};

$("attachBtn").onclick = () => $("filePicker").click();
$("filePicker").onchange = e => {
  handleFilesUpload(Array.from(e.target.files));
  e.target.value = "";
};

$("scanBtn").onclick = scanDocumentWithCamera;
$("cameraPicker").onchange = e => {
  if (e.target.files && e.target.files[0]) {
    processScannedPhoto(e.target.files[0]);
  }
  e.target.value = "";
};

$("micBtn").onclick = toggleVoiceRecording;

// Drag & drop
const editorPane = $("editorPane");
editorPane.addEventListener("dragover", e => { e.preventDefault(); });
editorPane.addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFilesUpload(Array.from(e.dataTransfer.files));
  }
});

// Буфер обмена (Cmd+V / Ctrl+V)
document.addEventListener("paste", e => {
  if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
    e.preventDefault();
    handleFilesUpload(Array.from(e.clipboardData.files));
  }
});

$("searchInput").oninput = e => {
  searchTerm = e.target.value;
  renderList();
};

$("folderList").onclick = e => {
  const b = e.target.closest("[data-folder]");
  if (!b) return;
  activeFolder = b.dataset.folder;
  renderList();
  if (innerWidth <= 768) $("sidebar").classList.remove("open");
};

$("themeBtn").onclick = () => {
  document.body.classList.toggle("light");
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  localStorage.setItem("inotes-dark", isDark ? "1" : "0");
};
if (localStorage.getItem("inotes-dark") === "0") {
  document.body.classList.remove("dark");
  document.body.classList.add("light");
}

$("accountBtn").onclick = $("syncCard").onclick = () => {
  $("authModal").hidden = false;
};
$("closeAuth").onclick = () => $("authModal").hidden = true;
$("yandexLoginBtn").onclick = () => {
  window.location.href = YD.getYandexAuthUrl();
};

$("manualSyncBtn").onclick = async () => {
  toast("Запуск синхронизации…");
  await runTwoWaySync();
  toast("Синхронизация завершена!");
};

$("signOutBtn").onclick = () => {
  if (confirm("Выйти из аккаунта Яндекс? Заметки останутся на этом устройстве.")) {
    YD.removeStoredToken();
    currentToken = null;
    currentUser = null;
    setSyncStatus("offline");
    $("accountLabel").textContent = "Войти через Яндекс";
    $("authLoggedOut").hidden = false;
    $("authLoggedIn").hidden = true;
    $("authModal").hidden = true;
    toast("Вы вышли из Яндекс ID");
  }
};

if (!notes.length) {
  notes = [{
    id: uid(),
    title: "График и документы ✦",
    body: `Добро пожаловать в iNotes!

Приложение оформлено в точности как стандартные Заметки iPhone.

Попробуйте:
• Прикрепить фотографии или документы (📎)
• Отсканировать документ с камеры (📷)
• Записать голосовую заметку (🎙️)
• Добавить список задач (✓☷)`,
    folder: "personal",
    pinned: true,
    trashed: false,
    attachments: [],
    updated: Date.now()
  }];
  localStorage.setItem(STORE, JSON.stringify(notes));
}

const initialNote = notes.find(n => !n.trashed);
if (initialNote) selectedId = initialNote.id;
renderList();
if (selectedId) openNote(selectedId);

checkAuthAndInit();

window.addEventListener("online", runTwoWaySync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    runTwoWaySync();
  }
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}
