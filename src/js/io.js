// File access. In the desktop app (Tauri) native dialogs run in Rust, which only writes to files
// the user picked; in a plain browser it falls back to downloads and a file picker.
const tauri = window.__TAURI__;
export const isDesktop = !!tauri;
const enc = encodeURIComponent;

export async function saveBytes(bytes, { defaultName, filterName, extensions }) {
  if (isDesktop) {
    return tauri.core.invoke('save_file', bytes, {
      headers: { 'x-name': enc(defaultName), 'x-filter': enc(filterName), 'x-ext': enc(extensions.join(',')) },
    });
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = Object.assign(document.createElement('a'), { href: url, download: defaultName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return defaultName;
}

export async function saveText(text, options) {
  return saveBytes(new TextEncoder().encode(text), options);
}

// Overwrites a file chosen earlier in a Save/Open dialog (Ctrl+S). Desktop only.
export async function writeTextTo(path, text) {
  await tauri.core.invoke('write_known_file', new TextEncoder().encode(text), { headers: { 'x-path': enc(path) } });
}

export async function openText({ filterName, extensions }) {
  if (isDesktop) return tauri.core.invoke('open_text_file', { filterName, extensions });
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: extensions.map((e) => `.${e}`).join(',') });
    input.onchange = async () => {
      const file = input.files[0];
      resolve(file ? { text: await file.text(), path: null } : null);
    };
    input.click();
  });
}

// Turns "HTTP 400: {json}" into the provider's own human-readable message.
function friendlyHttpError(raw) {
  const m = /^HTTP (\d+): ([\s\S]*)$/.exec(String(raw));
  if (!m) return new Error(String(raw));
  let detail = m[2].trim();
  try {
    const j = JSON.parse(detail);
    detail = j.error?.message || j.message || detail;
  } catch {
    const msg = /"message"\s*:\s*"([^"]+)"/.exec(detail); // cut-off JSON: still show the provider's message
    if (msg) detail = msg[1];
  }
  if (/^3\d\d$/.test(m[1])) {
    return Object.assign(new Error(`${detail.slice(0, 160)}. An AI API never redirects, so the API address in AI settings is wrong (for Gemini it must be https://generativelanguage.googleapis.com/v1beta).`), { status: +m[1] });
  }
  const hint = { 401: ' Check the API key.', 403: ' Check the API key.', 404: ' Check the model name.', 429: ' Free limit reached; wait a minute and try again.' }[m[1]] || '';
  return Object.assign(new Error(`${detail.slice(0, 300)}${hint}`), { status: +m[1] });
}

// The AI service must answer with JSON; anything else (an HTML error page, a Wi-Fi login page ...) is explained.
function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = String(text).trim().slice(0, 80).replace(/\s+/g, ' ');
    const html = /^\s*</.test(text);
    throw new Error(html
      ? `The AI address returned a web page instead of an AI answer ("${start}..."). Check the API address in AI settings, and that your internet is not showing a login page.`
      : `The AI service sent an unreadable answer ("${start || 'empty'}..."). Try again in a moment.`);
  }
}

// HTTP POST for AI providers. Desktop goes through Rust (no browser CORS limits).
export async function postJson(url, headers, body) {
  if (isDesktop) {
    let text;
    try {
      text = await tauri.core.invoke('ai_request', { url, headers, body: JSON.stringify(body) });
    } catch (err) {
      throw friendlyHttpError(err);
    }
    return parseBody(text);
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw friendlyHttpError(`HTTP ${res.status}: ${text}`);
  return parseBody(text);
}
