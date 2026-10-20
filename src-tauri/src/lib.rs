mod relay;
mod remux;
mod secure;
mod sync;

use secure::Secure;
use tauri::{Manager, State};

struct RelayBase(String);

#[tauri::command]
fn relay_base(relay: State<RelayBase>) -> String {
    relay.0.clone()
}

#[tauri::command]
fn secret_get(s: State<Secure>, name: String) -> Result<Option<String>, String> {
    s.secret_get(&name)
}

#[tauri::command]
fn secret_set(s: State<Secure>, name: String, value: String) -> Result<(), String> {
    s.secret_set(&name, &value)
}

#[tauri::command]
fn secret_delete(s: State<Secure>, name: String) -> Result<(), String> {
    s.secret_delete(&name)
}

#[tauri::command]
fn store_read(s: State<Secure>, name: String) -> Result<Option<String>, String> {
    s.read(&name)
}

#[tauri::command]
fn store_write(s: State<Secure>, name: String, text: String) -> Result<(), String> {
    s.write(&name, &text)
}

#[tauri::command]
fn store_delete(s: State<Secure>, name: String) -> Result<(), String> {
    s.delete(&name)
}

/// Where VLC is installed, if it is.
fn vlc_path() -> Option<std::path::PathBuf> {
    let mut candidates = vec![std::path::PathBuf::from("/Applications/VLC.app/Contents/MacOS/VLC")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(std::path::PathBuf::from(home).join("Applications/VLC.app/Contents/MacOS/VLC"));
    }
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn vlc_available() -> bool {
    vlc_path().is_some()
}

/// Plays a stream in VLC, for the odd format the web view can't decode. The URL is passed as an
/// argument, never through a shell.
#[tauri::command]
fn open_in_vlc(url: String, title: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only web addresses can be opened in VLC".into());
    }
    let vlc = vlc_path().ok_or("VLC isn't installed")?;
    std::process::Command::new(vlc)
        .arg(format!("--meta-title={title}"))
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let version = app.package_info().version.to_string();
            let relay = relay::start(format!("telly/{version}"))?;
            app.manage(RelayBase(relay.base));
            let dir = app.path().app_data_dir()?.join("store");
            app.manage(Secure::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            relay_base,
            secret_get,
            secret_set,
            secret_delete,
            store_read,
            store_write,
            store_delete,
            vlc_available,
            open_in_vlc,
            sync::sync_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running telly");
}
