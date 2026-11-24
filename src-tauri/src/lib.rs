// Quest Studio desktop backend.
// Files: the UI can only write to paths the user picked in a native Save/Open dialog during this session.
// AI: HTTPS POST proxy (avoids browser CORS limits); plain HTTP is allowed only for localhost (Ollama).
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Default)]
struct AllowedPaths(Mutex<HashSet<PathBuf>>);

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    percent_decode(raw)
}

// Decodes JavaScript's encodeURIComponent output (UTF-8 percent-encoding).
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected binary data".into()),
    }
}

/// Shows a native Save dialog and writes the bytes to the chosen file. Returns the path, or None if cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, allowed: State<'_, AllowedPaths>, request: Request<'_>) -> Result<Option<String>, String> {
    let data = body(&request)?;
    let name = header(&request, "x-name")?;
    let filter = header(&request, "x-filter")?;
    let exts: Vec<String> = header(&request, "x-ext")?.split(',').map(|s| s.trim().to_string()).collect();
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    let mut dialog = app.dialog().file().set_file_name(&name).add_filter(&filter, &ext_refs);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads); // start in Downloads so exports are easy to find
    }
    let picked = dialog.blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| format!("{}: {e}", path.display()))?;
    allowed.0.lock().unwrap().insert(path.clone());
    Ok(Some(path.display().to_string()))
}

/// Overwrites a file the user already chose in this session (Ctrl+S).
#[tauri::command]
fn write_known_file(allowed: State<'_, AllowedPaths>, request: Request<'_>) -> Result<(), String> {
    let path = PathBuf::from(header(&request, "x-path")?);
    if !allowed.0.lock().unwrap().contains(&path) {
        return Err("This file was not chosen in a Save or Open dialog. Use Save As.".into());
    }
    std::fs::write(&path, body(&request)?).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(serde::Serialize)]
struct OpenedFile {
    path: String,
    text: String,
}

/// Shows a native Open dialog and returns the chosen text file.
#[tauri::command]
async fn open_text_file(
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenedFile>, String> {
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let picked = app.dialog().file().add_filter(&filter_name, &ext_refs).blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES {
        return Err("File is larger than 50 MB.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    allowed.0.lock().unwrap().insert(path.clone());
    Ok(Some(OpenedFile { path: path.display().to_string(), text }))
}

/// POSTs JSON to an AI provider and returns the response body.
#[tauri::command]
async fn ai_request(url: String, headers: HashMap<String, String>, body: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid address: {e}"))?;
    let local = matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1"));
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && local)) {
        return Err("Only https:// addresses (or http://localhost for Ollama) are allowed.".into());
    }
    // Never follow redirects: an AI API answers directly; a redirect means a wrong address or a login page.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(parsed).header("Content-Type", "application/json").body(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = res.status();
    if status.is_redirection() {
        let to = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("another page").to_string();
        return Err(format!("HTTP {}: The AI address redirected to {to}", status.as_u16()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = text.chars().take(500).collect();
        return Err(format!("HTTP {}: {snippet}", status.as_u16()));
    }
    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AllowedPaths::default())
        .invoke_handler(tauri::generate_handler![save_file, write_known_file, open_text_file, ai_request])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Quest Studio");
}
