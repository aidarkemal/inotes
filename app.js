import * as YD from "./yandex-disk.js";

const $ = id => document.getElementById(id);
const STORE = "inotes-notes-v2";
const DELETED_STORE = "inotes-deleted-v2";

let notes = JSON.parse(localStorage.getItem(STORE) || "[]");
let deletedIds = new Set(JSON.parse(localStorage.getItem(DELETED_STORE) || "[]"));
let selectedId = null;
let activeFolder = "all";
let searchTerm = "";
let sortNewest = true;
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

function dateLabel(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function persistLocally() {
  localStorage.setItem(STORE, JSON.stringify(notes));
  localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedIds]));
  render();
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
    $("saveState").textContent = "Синхронизировано";
    title.textContent = "Яндекс Диск подключён";
    subtitle.textContent = currentUser ? (currentUser.default_email || currentUser.display_name) : "Облако активно";
  } else {
    dot.className = "sync-dot";
    $("saveState").textContent = "Сохранено на устройстве";
    title.textContent = "Только на этом устройстве";
    subtitle.textContent = "Войдите для синхронизации";
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

    // 1. Учитываем удалённые навсегда заметки
    for (const id of remoteDeleted) {
      deletedIds.add(id);
    }
    notes = notes.filter(n => !deletedIds.has(n.id));

    // 2. Слияние заметок
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

    // 3. Отправляем итоговый результат на Яндекс Диск
    await YD.saveRemoteNotes(currentToken, {
      notes,
      deletedIds: [...deletedIds],
      updatedAt: Date.now()
    });

    render();
    if (selectedId && notes.some(n => n.id === selectedId)) {
      renderAttachments(notes.find(n => n.id === selectedId));
    }

    setSyncStatus("online");
  } catch (err) {
    console.error("Sync error:", err);
    setSyncStatus("online");
    $("saveState").textContent = "Ошибка сети";
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
// Рендер заметок и корзины
// -------------------------------------------------------------
function render() {
  const inTrash = activeFolder === "trash";

  // Фильтрация
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

  filtered.sort((a, b) => {
    if (Number(b.pinned) !== Number(a.pinned)) {
      return Number(b.pinned) - Number(a.pinned);
    }
    return sortNewest ? (b.updated || 0) - (a.updated || 0) : (a.updated || 0) - (b.updated || 0);
  });

  // Подсчёт количества в папках
  const activeNotes = notes.filter(n => !n.trashed);
  const trashNotes = notes.filter(n => n.trashed);

  $("allCount").textContent = activeNotes.length;
  $("personalCount").textContent = activeNotes.filter(n => n.folder === "personal").length;
  $("workCount").textContent = activeNotes.filter(n => n.folder === "work").length;
  $("trashCount").textContent = trashNotes.length;

  // Заголовки панели
  if (inTrash) {
    $("folderTitle").textContent = "Недавно удалённые";
    $("folderEyebrow").textContent = "КОРЗИНА";
    $("newNoteBtn").style.display = "none";
    $("emptyTrashBtn").style.display = trashNotes.length ? "block" : "none";
  } else {
    $("folderTitle").textContent = ({ all: "Все заметки", personal: "Личные", work: "Работа" })[activeFolder] || "Заметки";
    $("folderEyebrow").textContent = activeFolder === "work" ? "РАБОЧЕЕ ПРОСТРАНСТВО" : "ЛИЧНОЕ ПРОСТРАНСТВО";
    $("newNoteBtn").style.display = "block";
    $("emptyTrashBtn").style.display = "none";
  }

  $("notesCount").textContent = `${filtered.length} ${filtered.length === 1 ? "заметка" : "заметок"}`;

  // Рендер карточек
  $("notesList").innerHTML = filtered.map(n => {
    const attCount = (n.attachments || []).length;
    const attBadge = attCount > 0 ? `<span class="att-badge" title="Вложений: ${attCount}">📎 ${attCount}</span>` : "";
    return `
      <button class="note-card ${n.id === selectedId ? "selected" : ""}" data-id="${escapeHTML(n.id)}">
        <div class="card-top">
          <span class="card-title">${escapeHTML(n.title || "Без названия")}</span>
          ${n.pinned ? '<span class="pin-mark">⌑</span>' : ""}
        </div>
        <p class="card-preview">${escapeHTML(plainText(n.body) || (attCount ? `[Вложений: ${attCount}]` : "Нет текста"))}</p>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span class="card-date">${dateLabel(n.updated)} · ${inTrash ? "Удалено" : (n.folder === "work" ? "Работа" : "Личные")}</span>
          ${attBadge}
        </div>
      </button>
    `;
  }).join("");

  // Пустое состояние
  if (filtered.length === 0) {
    $("emptyState").classList.add("show");
    if (inTrash) {
      $("emptyIcon").textContent = "🗑";
      $("emptyTitle").textContent = "Корзина пуста";
      $("emptyText").textContent = "Удалённые заметки будут отображаться здесь.";
      $("emptyNewBtn").style.display = "none";
    } else {
      $("emptyIcon").textContent = "✎";
      $("emptyTitle").textContent = "Пока нет заметок";
      $("emptyText").textContent = "Создайте первую заметку — ваши мысли и файлы будут в облаке.";
      $("emptyNewBtn").style.display = "block";
    }
  } else {
    $("emptyState").classList.remove("show");
  }

  $("notesList").style.display = filtered.length ? "grid" : "none";
  document.querySelectorAll(".folder").forEach(b => b.classList.toggle("active", b.dataset.folder === activeFolder));
}

function openNote(id) {
  selectedId = id;
  const n = notes.find(x => x.id === id);
  if (!n) return;

  $("noteTitle").value = n.title || "";
  $("noteBody").innerHTML = n.body || "";
  $("noteMeta").textContent = `Изменено ${dateLabel(n.updated)}`;
  $("pinBtn").classList.toggle("active", !!n.pinned);
  $("saveState").textContent = currentToken ? "Синхронизировано" : "Сохранено";

  // Проверка: заметка в корзине или нет
  if (n.trashed) {
    $("normalActions").style.display = "none";
    $("trashActions").style.display = "flex";
    $("noteTitle").disabled = true;
    $("noteBody").contentEditable = "false";
  } else {
    $("normalActions").style.display = "flex";
    $("trashActions").style.display = "none";
    $("noteTitle").disabled = false;
    $("noteBody").contentEditable = "true";
  }

  $("editorPane").classList.add("mobile-open");
  document.querySelector(".mobile-header")?.classList.add("hidden");

  updateWordCount();
  renderAttachments(n);
  render();
}

function closeEditor() {
  $("editorPane").classList.remove("mobile-open");
  document.querySelector(".mobile-header")?.classList.remove("hidden");
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
  $("noteMeta").textContent = `Изменено ${dateLabel(n.updated)}`;
  updateWordCount();
  persistLocally();
}

function updateWordCount() {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;
  const words = (plainText(n.body).match(/\S+/g) || []).length;
  $("wordCount").textContent = `${words} слов`;
  const atts = (n.attachments || []).length;
  $("attachmentSummary").textContent = `${atts} ${atts === 1 ? "файл" : "файлов"}`;
}

// Перемещение в корзину
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
    closeEditor();
  }
  toast("Заметка перемещена в корзину");
}

// Восстановление из корзины
function restoreFromTrash() {
  if (!selectedId) return;
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  n.trashed = false;
  delete n.trashedAt;
  n.updated = Date.now();
  persistLocally();
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

  if (selectedId) {
    openNote(selectedId);
  } else {
    closeEditor();
  }
  toast("Заметка удалена навсегда");
}

// Очистить всю корзину
function emptyTrash() {
  const count = notes.filter(n => n.trashed).length;
  if (!count) return;
  if (!confirm(`Очистить корзину (${count} заметок)? Все они будут удалены навсегда.`)) return;

  const trashedNotes = notes.filter(n => n.trashed);
  for (const n of trashedNotes) {
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
// Рендер и управление вложениями
// -------------------------------------------------------------
function renderAttachments(note) {
  const container = $("noteAttachments");
  if (!note || !note.attachments || note.attachments.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:12px;">
      ВЛОЖЕНИЯ (${note.attachments.length})
    </div>
    <div style="display:grid;gap:12px;">
      ${note.attachments.map(att => renderAttachmentItem(att, !!note.trashed)).join("")}
    </div>
  `;
}

function renderAttachmentItem(att, isNoteTrashed) {
  const id = escapeHTML(att.id);
  const name = escapeHTML(att.name || "Файл");
  const size = formatBytes(att.size);
  const safeUrl = escapeHTML(att.url || "#");
  const delBtn = isNoteTrashed ? "" : `<button class="att-del" onclick="window.__inotesDeleteAtt('${id}')" title="Удалить">✕</button>`;

  if (att.category === "photo") {
    return `
      <div class="attachment-media-card" data-att-id="${id}">
        <img class="att-image-preview" src="${safeUrl}" alt="${name}" loading="lazy" onclick="window.open('${safeUrl}', '_blank')">
        <div class="attachment-media-bar">
          <div>
            <div style="font-size:12px;font-weight:600;">${name}</div>
            <div style="font-size:10px;color:var(--muted);">${size} · Фото</div>
          </div>
          <div class="att-actions">
            <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
            ${delBtn}
          </div>
        </div>
      </div>
    `;
  }

  if (att.category === "video") {
    return `
      <div class="attachment-media-card" data-att-id="${id}">
        <video class="att-video-preview" src="${safeUrl}" controls preload="metadata"></video>
        <div class="attachment-media-bar">
          <div>
            <div style="font-size:12px;font-weight:600;">${name}</div>
            <div style="font-size:10px;color:var(--muted);">${size} · Видео</div>
          </div>
          <div class="att-actions">
            <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
            ${delBtn}
          </div>
        </div>
      </div>
    `;
  }

  if (att.category === "audio") {
    return `
      <div class="attachment-card" data-att-id="${id}">
        <div class="att-icon">🎙️</div>
        <div class="att-info">
          <div class="att-name">${name}</div>
          <audio src="${safeUrl}" controls style="width:100%;height:32px;margin-top:6px;"></audio>
          <div class="att-meta">${size} · Голосовая заметка</div>
        </div>
        <div class="att-actions">
          ${delBtn}
        </div>
      </div>
    `;
  }

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
        <div class="att-meta">${size} · ${att.label || "Файл"}</div>
      </div>
      <div class="att-actions">
        <a class="att-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
        ${delBtn}
      </div>
    </div>
  `;
}

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
// Загрузка файлов (до 200 МБ)
// -------------------------------------------------------------
async function handleFilesUpload(files) {
  if (!files || files.length === 0) return;
  if (!currentToken) {
    toast("Для сохранения файлов войдите в Яндекс ID");
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
    fileNameEl.textContent = `Загрузка: ${file.name} (${i + 1} из ${files.length})`;
    fillEl.style.width = "0%";
    percentEl.textContent = "0%";

    try {
      const att = await YD.uploadAttachment(currentToken, file, (progress) => {
        fillEl.style.width = `${progress.percent}%`;
        percentEl.textContent = `${progress.percent}% (${formatBytes(progress.loaded)} из ${formatBytes(progress.total)})`;
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
// Сканирование документов с камеры
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

      // Увеличение контрастности для четкости документа
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const enhanced = v > 150 ? Math.min(255, v * 1.15) : Math.max(0, v * 0.85);
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
// Голосовые заметки (Диктофон)
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
      micBtn.style.color = "";
      micBtn.title = "Голосовая заметка";

      const blob = new Blob(audioChunks, { type: "audio/webm" });
      stream.getTracks().forEach(t => t.stop());

      if (blob.size < 1000) return;
      const audioFile = new File([blob], `Голос_${new Date().toLocaleTimeString("ru-RU").replace(/:/g, '-')}.webm`, { type: "audio/webm" });
      await handleFilesUpload([audioFile]);
    };

    mediaRecorder.start();
    micBtn.classList.add("active");
    micBtn.style.color = "var(--danger)";
    recordSeconds = 0;
    micBtn.title = "Идёт запись... Нажмите для завершения";
    toast("Идёт запись голоса… Нажмите микрофон ещё раз, чтобы остановить.");

    recordTimer = setInterval(() => {
      recordSeconds++;
      $("saveState").textContent = `Запись: ${recordSeconds}с`;
    }, 1000);

  } catch (err) {
    console.warn(err);
    alert("Для записи голоса разрешите доступ к микрофону в браузере.");
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
      console.warn(e);
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
  const card = e.target.closest("[data-id]");
  if (card) openNote(card.dataset.id);
});

$("newNoteBtn").onclick = $("emptyNewBtn").onclick = $("mobileNewBtn").onclick = createNote;
$("backBtn").onclick = closeEditor;

$("noteTitle").addEventListener("input", () => updateSelected({ title: $("noteTitle").value }));
$("noteBody").addEventListener("input", () => updateSelected({ body: $("noteBody").innerHTML }));

$("pinBtn").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (n) {
    updateSelected({ pinned: !n.pinned });
    $("pinBtn").classList.toggle("active", !!n.pinned);
  }
};

// Корзина
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

// Прикрепление файлов
$("attachBtn").onclick = () => $("filePicker").click();
$("filePicker").onchange = e => {
  handleFilesUpload(Array.from(e.target.files));
  e.target.value = "";
};

// Скан документов
$("scanBtn").onclick = scanDocumentWithCamera;
$("cameraPicker").onchange = e => {
  if (e.target.files && e.target.files[0]) {
    processScannedPhoto(e.target.files[0]);
  }
  e.target.value = "";
};

// Голосовые заметки
$("micBtn").onclick = toggleVoiceRecording;

// Drag & drop файлов в окно заметки
const editorPane = $("editorPane");
editorPane.addEventListener("dragover", e => {
  e.preventDefault();
  editorPane.style.borderColor = "var(--accent)";
});
editorPane.addEventListener("dragleave", () => {
  editorPane.style.borderColor = "";
});
editorPane.addEventListener("drop", e => {
  e.preventDefault();
  editorPane.style.borderColor = "";
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFilesUpload(Array.from(e.dataTransfer.files));
  }
});

// Вставка из буфера обмена (Ctrl+V / Cmd+V)
document.addEventListener("paste", e => {
  if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
    e.preventDefault();
    handleFilesUpload(Array.from(e.clipboardData.files));
  }
});

$("searchInput").oninput = e => {
  searchTerm = e.target.value;
  render();
};

$("folderList").onclick = e => {
  const b = e.target.closest("[data-folder]");
  if (!b) return;
  activeFolder = b.dataset.folder;
  render();
  if (innerWidth <= 650) $("sidebar").classList.remove("open");
};

$("menuBtn").onclick = () => $("sidebar").classList.toggle("open");

$("sortBtn").onclick = () => {
  sortNewest = !sortNewest;
  $("sortBtn").textContent = sortNewest ? "Недавно изменённые⌄" : "Сначала старые⌄";
  render();
};

$("themeBtn").onclick = () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("inotes-dark", document.body.classList.contains("dark") ? "1" : "0");
};
if (localStorage.getItem("inotes-dark") === "1") document.body.classList.add("dark");

// Модальное окно авторизации
$("accountBtn").onclick = () => {
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

// Приветственная заметка
if (!notes.length) {
  notes = [{
    id: uid(),
    title: "Добро пожаловать в iNotes! ✦",
    body: `Ваше личное приложение для заметок в стиле Apple Notes.

Возможности:
• ☁️ Синхронизация через личный Яндекс Диск между Android, iPhone и MacBook.
• 📎 Вложение любых файлов (фото, видео, PDF, Word, Excel, ZIP) размером до 200 МБ.
• 📷 Сканирование документов с камеры смартфона с автоулучшением контраста.
• 🎙️ Запись голосовых заметок прямо внутри заметки.
• 🗑️ Корзина (Недавно удалённые) с возможностью восстановления.
• ☷ Списки дел и чек-листы.
• 📋 Вставка скриншотов из буфера обмена (Ctrl+V / Cmd+V) и перетаскивание файлов.
• 🌓 Тёмная и светлая тема.`,
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
render();
if (selectedId) openNote(selectedId);

checkAuthAndInit();

window.addEventListener("online", runTwoWaySync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    runTwoWaySync();
  }
});

// PWA Service Worker
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}
