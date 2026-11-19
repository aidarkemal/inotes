import * as YD from "./yandex-disk.js";

const $ = id => document.getElementById(id);
const STORE = "inotes-appflowy-v1";
const DELETED_STORE = "inotes-deleted-v3";

let notes = loadInitialNotes();
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

// Слэш-меню
let slashTargetBlockId = null;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function escapeHTML(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 Б";
  const k = 1024, sizes = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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

// -------------------------------------------------------------
// Загрузка и миграция заметок в блочную структуру AppFlowy
// -------------------------------------------------------------
function loadInitialNotes() {
  const raw = localStorage.getItem(STORE);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }

  // Миграция из предыдущих версий
  const oldRaw = localStorage.getItem("inotes-notes-v2") || localStorage.getItem("inotes-notes-v1");
  if (oldRaw) {
    try {
      const oldNotes = JSON.parse(oldRaw);
      return oldNotes.map(n => migrateOldNote(n));
    } catch (e) {}
  }

  return [];
}

function migrateOldNote(n) {
  const blocks = [];

  // Конвертируем старый HTML текст в блоки
  if (n.body) {
    const temp = document.createElement("div");
    temp.innerHTML = n.body;
    const lines = temp.innerText.split("\n").filter(l => l.trim().length > 0);
    for (const line of lines) {
      if (line.startsWith("•") || line.startsWith("-")) {
        blocks.push({ id: uid(), type: "todo", content: line.replace(/^[•-]\s*/, ""), checked: false });
      } else {
        blocks.push({ id: uid(), type: "text", content: line });
      }
    }
  }

  // Конвертируем старые вложения в блоки прямо в потоке
  if (n.attachments && n.attachments.length) {
    for (const att of n.attachments) {
      if (att.category === "photo") {
        blocks.push({
          id: att.id || uid(),
          type: "image",
          url: att.url,
          name: att.name,
          size: att.size,
          path: att.path
        });
      } else if (att.category === "audio") {
        blocks.push({
          id: att.id || uid(),
          type: "audio",
          url: att.url,
          name: att.name,
          size: att.size,
          path: att.path
        });
      } else {
        blocks.push({
          id: att.id || uid(),
          type: "file",
          url: att.url,
          name: att.name,
          size: att.size,
          path: att.path
        });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ id: uid(), type: "text", content: "" });
  }

  return {
    id: n.id || uid(),
    title: n.title || "Без названия",
    icon: n.icon || "📝",
    folder: n.folder || "personal",
    pinned: !!n.pinned,
    trashed: !!n.trashed,
    updated: n.updated || Date.now(),
    blocks
  };
}

function persistLocally() {
  localStorage.setItem(STORE, JSON.stringify(notes));
  localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedIds]));
  renderDocList();
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
    dot.className = "af-sync-indicator syncing";
    $("saveState").textContent = "Синхронизация…";
    title.textContent = "Синхронизация…";
    subtitle.textContent = "Обновление в облаке";
  } else if (state === "online") {
    dot.className = "af-sync-indicator online";
    $("saveState").textContent = "Сохранено на Диске";
    title.textContent = "Яндекс Диск активен";
    subtitle.textContent = currentUser ? (currentUser.default_email || currentUser.display_name) : "Синхронизировано";
  } else {
    dot.className = "af-sync-indicator";
    $("saveState").textContent = "Локально";
    title.textContent = "Только на устройстве";
    subtitle.textContent = "Нажмите для облака";
  }
}

async function runTwoWaySync() {
  if (!currentToken || isSyncing) return;
  isSyncing = true;
  setSyncStatus("syncing");

  try {
    const remoteData = await YD.fetchRemoteNotes(currentToken);
    const rawRemoteNotes = (remoteData && remoteData.notes) ? remoteData.notes : [];
    const remoteDeleted = new Set((remoteData && remoteData.deletedIds) ? remoteData.deletedIds : []);

    // Приводим все удалённые заметки
    for (const id of remoteDeleted) {
      deletedIds.add(id);
    }
    notes = notes.filter(n => !deletedIds.has(n.id));

    // Автоматически конвертируем любые старые заметки из облака в блочную структуру AppFlowy
    const remoteNotes = rawRemoteNotes.map(r => {
      if (!r.blocks || !Array.isArray(r.blocks) || r.blocks.length === 0) {
        return migrateOldNote(r);
      }
      return r;
    });

    const localMap = new Map(notes.map(n => [n.id, n]));
    const mergedMap = new Map();

    for (const r of remoteNotes) {
      if (deletedIds.has(r.id)) continue;
      const l = localMap.get(r.id);
      if (!l) {
        mergedMap.set(r.id, r);
      } else {
        // Выбираем самую свежую версию, убедившись, что у неё есть блоки
        const winner = (r.updated || 0) > (l.updated || 0) ? r : l;
        if (!winner.blocks || !winner.blocks.length) {
          mergedMap.set(r.id, migrateOldNote(winner));
        } else {
          mergedMap.set(r.id, winner);
        }
      }
    }

    for (const [id, l] of localMap.entries()) {
      if (!mergedMap.has(id) && !deletedIds.has(id)) {
        if (!l.blocks || !l.blocks.length) {
          mergedMap.set(id, migrateOldNote(l));
        } else {
          mergedMap.set(id, l);
        }
      }
    }

    notes = Array.from(mergedMap.values());
    localStorage.setItem(STORE, JSON.stringify(notes));
    localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedIds]));

    // Сохраняем обратно на Яндекс Диск уже в чистом блочном формате
    await YD.saveRemoteNotes(currentToken, {
      notes,
      deletedIds: [...deletedIds],
      updatedAt: Date.now()
    });

    renderDocList();
    if (selectedId && notes.some(n => n.id === selectedId)) {
      renderBlocks(notes.find(n => n.id === selectedId));
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
// Рендер списка документов
// -------------------------------------------------------------
function renderDocList() {
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
      const matchTitle = (n.title || "").toLowerCase().includes(q);
      const matchBlocks = (n.blocks || []).some(b => (b.content || b.name || "").toLowerCase().includes(q));
      if (!matchTitle && !matchBlocks) return false;
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

  if (inTrash) {
    $("folderTitle").textContent = "Корзина";
    $("emptyTrashBtn").style.display = trashNotes.length ? "inline-block" : "none";
    $("newNoteBtn").style.display = "none";
    $("backBtnText").textContent = "Корзина";
  } else {
    $("folderTitle").textContent = ({ all: "Все страницы", personal: "Личные", work: "Работа" })[activeFolder] || "Страницы";
    $("emptyTrashBtn").style.display = "none";
    $("newNoteBtn").style.display = "inline-flex";
    $("backBtnText").textContent = "Страницы";
  }

  $("notesCount").textContent = `${filtered.length} ${filtered.length === 1 ? "документ" : "документов"}`;

  if (filtered.length === 0) {
    $("notesList").innerHTML = "";
    $("emptyState").classList.add("show");
    return;
  }

  $("emptyState").classList.remove("show");

  $("notesList").innerHTML = filtered.map(n => {
    // Ищем первое фото для превью справа
    const firstImg = (n.blocks || []).find(b => b.type === "image" && b.url);
    const thumbHtml = firstImg
      ? `<img class="af-card-thumb" src="${escapeHTML(firstImg.url)}" alt="превью" loading="lazy">`
      : "";

    // Текстовое превью
    const firstText = (n.blocks || []).find(b => b.type === "text" || b.type === "todo" || b.type === "h1");
    const preview = firstText ? escapeHTML(firstText.content || "") : "Пустой документ";

    return `
      <div class="af-doc-card ${n.id === selectedId ? "selected" : ""}" data-id="${escapeHTML(n.id)}">
        <span class="af-card-icon">${n.icon || "📄"}</span>
        <div class="af-card-body">
          <div class="af-card-title">${escapeHTML(n.title || "Без названия")}</div>
          <div class="af-card-preview">${preview}</div>
          <div class="af-card-meta">
            <span>${new Date(n.updated).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
            <span>·</span>
            <span>${n.folder === "work" ? "Работа" : "Личные"}</span>
          </div>
        </div>
        ${thumbHtml}
      </div>
    `;
  }).join("");

  document.querySelectorAll(".af-nav-item").forEach(b => b.classList.toggle("active", b.dataset.folder === activeFolder));
}

// -------------------------------------------------------------
// Открытие документа и рендер блоков AppFlowy
// -------------------------------------------------------------
function openNote(id) {
  selectedId = id;
  const n = notes.find(x => x.id === id);
  if (!n) return;

  $("pageIconBtn").textContent = n.icon || "📝";
  $("noteTitle").value = n.title || "";
  $("noteMeta").textContent = formatDetailDate(n.updated);

  if (n.trashed) {
    $("normalActions").style.display = "none";
    $("trashActions").style.display = "flex";
    $("editorBottomBar").style.display = "none";
    $("noteTitle").disabled = true;
  } else {
    $("normalActions").style.display = "flex";
    $("trashActions").style.display = "none";
    $("editorBottomBar").style.display = "flex";
    $("noteTitle").disabled = false;
  }

  renderBlocks(n);
  $("editorPane").classList.add("mobile-open");
  renderDocList();
}

function closeEditor() {
  $("editorPane").classList.remove("mobile-open");
}

function createNote() {
  if (activeFolder === "trash") activeFolder = "all";

  const n = {
    id: uid(),
    title: "",
    icon: "📝",
    folder: activeFolder === "work" ? "work" : "personal",
    pinned: false,
    trashed: false,
    updated: Date.now(),
    blocks: [
      { id: uid(), type: "text", content: "" }
    ]
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

// -------------------------------------------------------------
// Рендер интерактивных блоков контента (Blocks Canvas)
// -------------------------------------------------------------
function renderBlocks(n) {
  const container = $("blocksContainer");
  if (!n.blocks || n.blocks.length === 0) {
    n.blocks = [{ id: uid(), type: "text", content: "" }];
  }

  container.innerHTML = n.blocks.map(b => renderSingleBlock(b, !!n.trashed)).join("");

  // Навешиваем слушатели на contenteditable блоки
  container.querySelectorAll("[data-block-id]").forEach(el => {
    const bId = el.dataset.blockId;
    const editable = el.querySelector("[contenteditable=true]");
    if (editable) {
      editable.addEventListener("input", () => {
        const blk = n.blocks.find(b => b.id === bId);
        if (blk) {
          blk.content = editable.innerText;
          updateSelected({ blocks: n.blocks });

          // Если ввели слэш '/', показываем слэш-меню
          if (editable.innerText === "/") {
            showSlashMenu(bId, editable);
          } else {
            hideSlashMenu();
          }
        }
      });

      // Переход на новую строку (Enter) создаёт новый блок
      editable.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          insertBlockBelow(bId, "text");
        } else if (e.key === "Backspace" && editable.innerText.trim() === "" && n.blocks.length > 1) {
          e.preventDefault();
          removeBlock(bId);
        }
      });
    }
  });
}

function renderSingleBlock(b, isTrashed) {
  const id = escapeHTML(b.id);
  const handleHtml = isTrashed ? "" : `<div class="af-block-handle" onclick="window.__inotesHandleClick('${id}', event)" title="Добавить блок">＋</div>`;

  // 1. Текст (Абзац)
  if (b.type === "text") {
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-text-block" contenteditable="${!isTrashed}" data-placeholder="Наберите текст или '/' для вставки медиа...">${escapeHTML(b.content || "")}</div>
        </div>
      </div>
    `;
  }

  // 2. Заголовок H1
  if (b.type === "h1") {
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-h1-block" contenteditable="${!isTrashed}" data-placeholder="Заголовок...">${escapeHTML(b.content || "")}</div>
        </div>
      </div>
    `;
  }

  // 3. Подзаголовок H2
  if (b.type === "h2") {
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-h2-block" contenteditable="${!isTrashed}" data-placeholder="Подзаголовок...">${escapeHTML(b.content || "")}</div>
        </div>
      </div>
    `;
  }

  // 4. Список задач (Todo)
  if (b.type === "todo") {
    const isChecked = !!b.checked;
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-todo-block">
            <div class="af-todo-checkbox ${isChecked ? "checked" : ""}" onclick="window.__inotesToggleTodo('${id}')"></div>
            <div class="af-todo-text ${isChecked ? "checked" : ""}" contenteditable="${!isTrashed}">${escapeHTML(b.content || "")}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 5. Изображение / Скан (100% ширины, прямо в потоке)
  if (b.type === "image") {
    const safeUrl = escapeHTML(b.url || "");
    const name = escapeHTML(b.name || "Изображение");
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-image-block">
            <img class="af-image-preview" src="${safeUrl}" alt="${name}" loading="lazy" onclick="window.__inotesOpenLightbox('${safeUrl}')">
            <div class="af-media-footer">
              <div>
                <span class="af-media-title">${name}</span>
                <span class="af-media-sub"> · ${formatBytes(b.size)}</span>
              </div>
              <div class="af-media-actions">
                <a class="af-media-btn" href="${safeUrl}" target="_blank" download="${name}">Скачать</a>
                ${isTrashed ? "" : `<button class="af-media-del" onclick="window.__inotesRemoveBlock('${id}')" title="Удалить блок">✕</button>`}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // 6. Аудио / Диктофон
  if (b.type === "audio") {
    const safeUrl = escapeHTML(b.url || "");
    const name = escapeHTML(b.name || "Голосовая запись");
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-file-card">
            <span class="af-file-icon">🎙️</span>
            <div class="af-file-info">
              <div class="af-file-name">${name}</div>
              <audio src="${safeUrl}" controls style="width:100%;height:32px;margin-top:6px;"></audio>
            </div>
            ${isTrashed ? "" : `<button class="af-media-del" onclick="window.__inotesRemoveBlock('${id}')" title="Удалить">✕</button>`}
          </div>
        </div>
      </div>
    `;
  }

  // 7. Файл / Документ (PDF, Word, Excel, ZIP)
  if (b.type === "file") {
    const safeUrl = escapeHTML(b.url || "");
    const name = escapeHTML(b.name || "Файл");
    let icon = "📄";
    if (name.endsWith(".pdf")) icon = "📕";
    else if (/\.(docx?|pages|txt|rtf)$/i.test(name)) icon = "📘";
    else if (/\.(xlsx?|numbers|csv)$/i.test(name)) icon = "📗";
    else if (/\.(zip|rar|7z)$/i.test(name)) icon = "📦";

    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-file-card">
            <span class="af-file-icon">${icon}</span>
            <div class="af-file-info">
              <div class="af-file-name">${name}</div>
              <div class="af-file-meta">${formatBytes(b.size)} · Документ на Яндекс Диске</div>
            </div>
            <a class="af-media-btn" href="${safeUrl}" target="_blank" download="${name}">Открыть</a>
            ${isTrashed ? "" : `<button class="af-media-del" onclick="window.__inotesRemoveBlock('${id}')" title="Удалить">✕</button>`}
          </div>
        </div>
      </div>
    `;
  }

  // 8. Callout выделение
  if (b.type === "callout") {
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-callout-block">
            <span class="af-callout-emoji">💡</span>
            <div class="af-callout-text" contenteditable="${!isTrashed}" data-placeholder="Важная мысль...">${escapeHTML(b.content || "")}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 9. Разделитель
  if (b.type === "divider") {
    return `
      <div class="af-block-wrapper" data-block-id="${id}">
        ${handleHtml}
        <div class="af-block-content">
          <div class="af-divider-block"></div>
        </div>
      </div>
    `;
  }

  return "";
}

// -------------------------------------------------------------
// Операции с блоками
// -------------------------------------------------------------
function insertBlockBelow(targetId, type) {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  const idx = n.blocks.findIndex(b => b.id === targetId);
  const newBlock = { id: uid(), type, content: "" };

  if (idx !== -1) {
    n.blocks.splice(idx + 1, 0, newBlock);
  } else {
    n.blocks.push(newBlock);
  }

  updateSelected({ blocks: n.blocks });
  renderBlocks(n);

  // Фокусируемся на новом блоке
  setTimeout(() => {
    const newEl = document.querySelector(`[data-block-id="${newBlock.id}"] [contenteditable=true]`);
    if (newEl) newEl.focus();
  }, 50);
}

function removeBlock(blockId) {
  const n = notes.find(x => x.id === selectedId);
  if (!n || n.blocks.length <= 1) return;

  const idx = n.blocks.findIndex(b => b.id === blockId);
  if (idx !== -1) {
    const prevBlock = n.blocks[idx - 1] || n.blocks[idx + 1];
    n.blocks.splice(idx, 1);
    updateSelected({ blocks: n.blocks });
    renderBlocks(n);

    if (prevBlock) {
      setTimeout(() => {
        const el = document.querySelector(`[data-block-id="${prevBlock.id}"] [contenteditable=true]`);
        if (el) el.focus();
      }, 50);
    }
  }
}

window.__inotesRemoveBlock = removeBlock;

window.__inotesToggleTodo = function(blockId) {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;
  const b = n.blocks.find(x => x.id === blockId);
  if (b && b.type === "todo") {
    b.checked = !b.checked;
    updateSelected({ blocks: n.blocks });
    renderBlocks(n);
  }
};

window.__inotesHandleClick = function(blockId, event) {
  slashTargetBlockId = blockId;
  const rect = event.target.getBoundingClientRect();
  const menu = $("slashMenu");
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  menu.hidden = false;
};

// -------------------------------------------------------------
// Слэш-меню (AppFlowy Slash Command)
// -------------------------------------------------------------
function showSlashMenu(blockId, targetEl) {
  slashTargetBlockId = blockId;
  const rect = targetEl.getBoundingClientRect();
  const menu = $("slashMenu");
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  menu.hidden = false;
}

function hideSlashMenu() {
  $("slashMenu").hidden = true;
  slashTargetBlockId = null;
}

$("slashMenu").addEventListener("click", e => {
  const item = e.target.closest(".af-slash-item");
  if (!item) return;
  const type = item.dataset.type;
  hideSlashMenu();

  if (type === "scan") {
    scanDocumentWithCamera();
  } else if (type === "photo" || type === "file") {
    $("filePicker").click();
  } else if (type === "audio") {
    toggleVoiceRecording();
  } else {
    const n = notes.find(x => x.id === selectedId);
    if (!n) return;

    if (slashTargetBlockId) {
      const b = n.blocks.find(x => x.id === slashTargetBlockId);
      if (b && b.content === "/") {
        b.type = type;
        b.content = "";
        updateSelected({ blocks: n.blocks });
        renderBlocks(n);
        setTimeout(() => {
          const el = document.querySelector(`[data-block-id="${b.id}"] [contenteditable=true]`);
          if (el) el.focus();
        }, 50);
        return;
      }
    }
    insertBlockBelow(slashTargetBlockId, type);
  }
});

document.addEventListener("click", e => {
  if (!e.target.closest("#slashMenu") && !e.target.closest(".af-block-handle") && !e.target.closest("#quickAddBtn")) {
    hideSlashMenu();
  }
});

$("quickAddBtn").onclick = (e) => {
  const rect = e.target.getBoundingClientRect();
  const menu = $("slashMenu");
  menu.style.top = `${Math.max(10, rect.top - 380)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  menu.hidden = false;
};

$("addBlockTrigger").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;
  const lastBlock = n.blocks[n.blocks.length - 1];
  insertBlockBelow(lastBlock?.id, "text");
};

// -------------------------------------------------------------
// Загрузка файлов до 200 МБ в поток блоков
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

      // Добавляем блок прямо в текущий документ
      const blockType = att.category === "photo" ? "image" : (att.category === "audio" ? "audio" : "file");
      n.blocks.push({
        id: uid(),
        type: blockType,
        url: att.url,
        name: att.name,
        size: att.size,
        path: att.path
      });

      updateSelected({ blocks: n.blocks });
      renderBlocks(n);
      toast(`Загружено: ${file.name}`);
    } catch (err) {
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

      // Улучшение контраста документа
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

// Полноэкранный просмотр фото (Лайтбокс)
window.__inotesOpenLightbox = function(url) {
  $("lightboxImg").src = url;
  $("lightboxModal").hidden = false;
};
$("closeLightbox").onclick = () => {
  $("lightboxModal").hidden = true;
  $("lightboxImg").src = "";
};

// -------------------------------------------------------------
// Корзина и восстановление
// -------------------------------------------------------------
function moveToTrash() {
  if (!selectedId) return;
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  n.trashed = true;
  n.trashedAt = Date.now();
  persistLocally();

  const next = notes.find(x => !x.trashed);
  selectedId = next?.id || null;
  if (selectedId) openNote(selectedId);
  else closeEditor();
  toast("Страница перемещена в корзину");
}

function restoreFromTrash() {
  if (!selectedId) return;
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;

  n.trashed = false;
  delete n.trashedAt;
  n.updated = Date.now();
  persistLocally();

  activeFolder = "all";
  renderDocList();
  openNote(n.id);
  toast("Страница восстановлена!");
}

function deletePermanently() {
  if (!selectedId) return;
  if (!confirm("Удалить страницу навсегда? Это действие нельзя отменить.")) return;

  const id = selectedId;
  deletedIds.add(id);
  notes = notes.filter(x => x.id !== id);
  selectedId = notes[0]?.id || null;
  persistLocally();

  if (selectedId) openNote(selectedId);
  else closeEditor();
  toast("Страница удалена навсегда");
}

function emptyTrash() {
  const count = notes.filter(n => n.trashed).length;
  if (!count) return;
  if (!confirm(`Очистить корзину (${count} документов)? Все они будут удалены навсегда.`)) return;

  for (const n of notes.filter(n => n.trashed)) {
    deletedIds.add(n.id);
  }

  notes = notes.filter(n => !n.trashed);
  selectedId = notes[0]?.id || null;
  persistLocally();
  if (selectedId) openNote(selectedId);
  else closeEditor();
  toast("Корзина очищена");
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
  const card = e.target.closest(".af-doc-card");
  if (card) openNote(card.dataset.id);
});

$("newNoteBtn").onclick = createNote;
$("backBtn").onclick = closeEditor;
$("menuBtn").onclick = () => $("sidebar").classList.toggle("open");

$("noteTitle").addEventListener("input", () => updateSelected({ title: $("noteTitle").value }));

// Смена иконки документа
const EMOJIS = ["📝", "📊", "💡", "💼", "🎯", "🚀", "📁", "⭐️", "🔑", "📌", "🎨", "💻"];
$("pageIconBtn").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;
  const currIdx = EMOJIS.indexOf(n.icon || "📝");
  const nextEmoji = EMOJIS[(currIdx + 1) % EMOJIS.length];
  n.icon = nextEmoji;
  $("pageIconBtn").textContent = nextEmoji;
  updateSelected({ icon: nextEmoji });
  renderDocList();
};

$("pinBtn").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (n) {
    updateSelected({ pinned: !n.pinned });
    $("pinBtn").classList.toggle("active", !!n.pinned);
  }
};

$("deleteBtn").onclick = moveToTrash;
$("restoreBtn").onclick = restoreFromTrash;
$("permDeleteBtn").onclick = deletePermanently;
$("emptyTrashBtn").onclick = emptyTrash;

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

$("todoBtn").onclick = () => {
  const n = notes.find(x => x.id === selectedId);
  if (!n) return;
  const lastBlock = n.blocks[n.blocks.length - 1];
  insertBlockBelow(lastBlock?.id, "todo");
};

// Drag & drop файлов
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
  renderDocList();
};

$("folderList").onclick = e => {
  const b = e.target.closest("[data-folder]");
  if (!b) return;
  activeFolder = b.dataset.folder;
  renderDocList();
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
  if (confirm("Выйти из аккаунта Яндекс? Документы останутся на этом устройстве.")) {
    YD.removeStoredToken();
    currentToken = null;
    currentUser = null;
    setSyncStatus("offline");
    $("accountLabel").textContent = "Яндекс Диск";
    $("authLoggedOut").hidden = false;
    $("authLoggedIn").hidden = true;
    $("authModal").hidden = true;
    toast("Вы вышли из Яндекс ID");
  }
};

// Приветственный документ в стиле AppFlowy
if (!notes.length) {
  notes = [{
    id: uid(),
    title: "Добро пожаловать в iNotes Flow ✦",
    icon: "🚀",
    folder: "personal",
    pinned: true,
    trashed: false,
    updated: Date.now(),
    blocks: [
      { id: uid(), type: "callout", content: "Это блочный редактор нового поколения в стиле AppFlowy и Notion с синхронизацией через ваш Яндекс Диск." },
      { id: uid(), type: "h1", content: "Возможности блоков" },
      { id: uid(), type: "text", content: "Вы можете добавлять блоки в любое место документа — наберите слэш «/» или нажмите кнопку «＋»." },
      { id: uid(), type: "todo", content: "Попробовать скан документа с камеры (📷)", checked: false },
      { id: uid(), type: "todo", content: "Прикрепить фото, видео или файл до 200 МБ (📎)", checked: false },
      { id: uid(), type: "todo", content: "Записать голосовую заметку (🎙️)", checked: false },
      { id: uid(), type: "divider" },
      { id: uid(), type: "text", content: "Все ваши данные и файлы автоматически сохраняются в вашем личном Яндекс Диске и доступны на Mac, Android и iPhone." }
    ]
  }];
  localStorage.setItem(STORE, JSON.stringify(notes));
}

const initialNote = notes.find(n => !n.trashed);
if (initialNote) selectedId = initialNote.id;
renderDocList();
if (selectedId) openNote(selectedId);

checkAuthAndInit();

window.addEventListener("online", runTwoWaySync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    runTwoWaySync();
  }
});

// Очищаем старые кэши Service Worker при запуске
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let r of registrations) r.unregister();
  }).catch(() => {});
}
