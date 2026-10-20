//! Requests to the sync relay, made here rather than in the web view so its content security
//! policy stays tight whichever relay the user picks. Bodies are already sealed by the front end.

use std::time::Duration;

#[derive(serde::Serialize)]
pub struct SyncResponse {
    status: u16,
    text: String,
}

/// HTTPS only, except a relay on this computer (for testing one locally).
fn allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")
}

#[tauri::command]
pub async fn sync_request(method: String, url: String, auth: String, body: Option<Vec<u8>>) -> Result<SyncResponse, String> {
    if !allowed(&url) {
        return Err("The sync relay must use HTTPS".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let method = match method.as_str() {
            "GET" => reqwest::Method::GET,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("Unsupported method".to_string()),
        };
        let mut request = client.request(method, &url).bearer_auth(auth);
        if let Some(bytes) = body {
            request = request.header("Content-Type", "application/octet-stream").body(bytes);
        }
        let response = request.send().map_err(|_| "Couldn't reach the sync relay.".to_string())?;
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        Ok(SyncResponse { status, text })
    })
    .await
    .map_err(|e| e.to_string())?
}
