// iNotes Yandex Disk Integration
export const YANDEX_CLIENT_ID = "69cc7afb875e47fbb9108ed7de454613";

export function getRedirectUri() {
  const loc = window.location;
  if (loc.hostname.includes("github.io")) {
    return "https://aidarkemal.github.io/inotes/";
  }
  return `${loc.origin}${loc.pathname}`;
}

export function getYandexAuthUrl() {
  const redirect = getRedirectUri();
  return `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}`;
}

export function parseTokenFromUrl() {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('access_token');
  if (token) {
    localStorage.setItem('inotes_yd_token', token);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return token;
  }
  return null;
}

export function getStoredToken() {
  return localStorage.getItem('inotes_yd_token') || null;
}

export function removeStoredToken() {
  localStorage.removeItem('inotes_yd_token');
}

export async function getUserInfo(token) {
  try {
    const res = await fetch("https://login.yandex.ru/info?format=json", {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("getUserInfo error", e);
    return null;
  }
}

export async function getDiskInfo(token) {
  try {
    const res = await fetch("https://cloud-api.yandex.net/v1/disk/", {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("getDiskInfo error", e);
    return null;
  }
}

export async function ensureFolder(token, path) {
  try {
    const res = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { Authorization: `OAuth ${token}` }
    });
    return res.status === 201 || res.status === 409;
  } catch (e) {
    console.warn("ensureFolder error", e);
    return false;
  }
}

export async function initDiskStructure(token) {
  const folders = [
    "disk:/iNotes",
    "disk:/iNotes/Фотографии",
    "disk:/iNotes/Видео",
    "disk:/iNotes/PDF и документы",
    "disk:/iNotes/Другие файлы"
  ];
  for (const f of folders) {
    await ensureFolder(token, f);
  }
}

export async function fetchRemoteNotes(token) {
  try {
    const metaRes = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("disk:/iNotes/notes.json")}`, {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (metaRes.status === 404) {
      return null;
    }
    if (!metaRes.ok) throw new Error("Не удалось получить ссылку на notes.json");
    const meta = await metaRes.json();
    const fileRes = await fetch(meta.href);
    if (!fileRes.ok) return null;
    return await fileRes.json();
  } catch (e) {
    console.warn("fetchRemoteNotes error", e);
    return null;
  }
}

export async function saveRemoteNotes(token, notesPayload) {
  try {
    const uploadUrlRes = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent("disk:/iNotes/notes.json")}&overwrite=true`, {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (!uploadUrlRes.ok) throw new Error("Не удалось запросить upload link для notes.json");
    const { href } = await uploadUrlRes.json();
    const blob = new Blob([JSON.stringify(notesPayload, null, 2)], { type: "application/json" });
    const putRes = await fetch(href, {
      method: "PUT",
      body: blob
    });
    return putRes.ok;
  } catch (e) {
    console.error("saveRemoteNotes error", e);
    return false;
  }
}

export function getFileCategory(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  const ext = name.split(".").pop();

  // 1. Аудио и голосовые заметки
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext) || (mime.includes("webm") && (name.includes("голос") || mime.startsWith("audio")))) {
    return { folder: "disk:/iNotes/Другие файлы", category: "audio", label: "Голос" };
  }
  // 2. Фотографии и изображения
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "heic", "svg", "bmp"].includes(ext)) {
    return { folder: "disk:/iNotes/Фотографии", category: "photo", label: "Фото" };
  }
  // 3. Видео
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "3gp", "m4v"].includes(ext)) {
    return { folder: "disk:/iNotes/Видео", category: "video", label: "Видео" };
  }
  // 4. Документы
  if (mime.includes("pdf") || ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "pages", "numbers", "key", "csv"].includes(ext)) {
    return { folder: "disk:/iNotes/PDF и документы", category: "doc", label: "Документ" };
  }
  return { folder: "disk:/iNotes/Другие файлы", category: "other", label: "Файл" };
}

export async function getFileDownloadUrl(token, path) {
  try {
    const res = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.href;
  } catch (e) {
    console.warn("getFileDownloadUrl error", e);
    return null;
  }
}

export async function uploadAttachment(token, file, onProgress) {
  const maxBytes = 200 * 1024 * 1024; // 200 MB
  if (file.size > maxBytes) {
    throw new Error(`Размер файла «${file.name}» (${(file.size / (1024 * 1024)).toFixed(1)} МБ) превышает лимит 200 МБ.`);
  }

  const { folder, category, label } = getFileCategory(file);
  const timestamp = Date.now();
  const cleanName = file.name.replace(/[/\\?%*:|"<>]/g, "_");
  const remotePath = `${folder}/${timestamp}_${cleanName}`;

  // 1. Get upload link
  const uploadUrlRes = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`, {
    headers: { Authorization: `OAuth ${token}` }
  });
  if (!uploadUrlRes.ok) {
    const err = await uploadUrlRes.json().catch(() => ({}));
    throw new Error(err.message || "Не удалось получить ссылку для загрузки на Яндекс Диск");
  }
  const { href } = await uploadUrlRes.json();

  // 2. Upload with XHR to track progress
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", href, true);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress({
            loaded: e.loaded,
            total: e.total,
            percent,
            fileName: file.name
          });
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Ошибка передачи данных на Яндекс Диск (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Сетевой сбой при загрузке на Яндекс Диск"));
    xhr.send(file);
  });

  // 3. Get temporary direct download link
  const downloadUrl = await getFileDownloadUrl(token, remotePath);

  return {
    id: `att_${timestamp}_${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    category,
    label,
    path: remotePath,
    url: downloadUrl || "",
    urlExpires: Date.now() + 4 * 3600 * 1000,
    uploadedAt: timestamp
  };
}

export async function deleteRemoteFile(token, path) {
  try {
    await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(path)}&permanently=false`, {
      method: "DELETE",
      headers: { Authorization: `OAuth ${token}` }
    });
  } catch (e) {
    console.warn("deleteRemoteFile error", e);
  }
}
