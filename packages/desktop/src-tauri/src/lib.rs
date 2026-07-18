// Native daemon client for agentproto-desktop.
//
// All network + on-disk-token access lives here in Rust (not the WebView) so
// the app never fights CORS on the loopback daemon and never has to read the
// per-boot token file from JS. Mirrors the VS Code extension's DaemonClient
// contract (packages/vscode/src/client/daemonClient.ts):
//   base            http://127.0.0.1:18790
//   GET /health     public liveness probe (no auth)
//   GET /sessions   -> { sessions: SessionDescriptor[] }  (Bearer-gated)
//   token           ~/.agentproto/daemons/<port>.json  { "token": "..." }
//                   (loopback daemons accept a missing token, so it's optional)

use std::time::Duration;

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:18790";

/// Strip a trailing slash so `{base}/path` never doubles up.
fn normalize_url(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/// Pull the port out of a daemon URL, defaulting to 18790 when absent.
fn daemon_port(url: &str) -> String {
    // Cheap parse: last `:` segment that is all digits.
    url.rsplit(':')
        .next()
        .and_then(|tail| {
            let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                None
            } else {
                Some(digits)
            }
        })
        .unwrap_or_else(|| "18790".to_string())
}

/// Resolve the daemon's per-boot bearer token from the port-keyed registry at
/// `~/.agentproto/daemons/<port>.json`. Returns None when no token is found
/// (non-fatal — loopback daemons accept unauthenticated requests).
fn resolve_token(url: &str) -> Option<String> {
    let port = daemon_port(url);
    let path = dirs::home_dir()?
        .join(".agentproto")
        .join("daemons")
        .join(format!("{port}.json"));
    let raw = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn get_json(url: &str, path: &str, authed: bool) -> Result<serde_json::Value, String> {
    let base = normalize_url(url);
    let mut req = client()?.get(format!("{base}{path}"));
    if authed {
        if let Some(token) = resolve_token(&base) {
            req = req.bearer_auth(token);
        }
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// GET /health — public liveness probe. Returns the raw health object.
#[tauri::command]
async fn daemon_health(daemon_url: Option<String>) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    get_json(&url, "/health", false).await
}

/// GET /sessions — Bearer-gated. Returns the `sessions` array (or [] if the
/// daemon omits it).
#[tauri::command]
async fn daemon_sessions(daemon_url: Option<String>) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let body = get_json(&url, "/sessions", true).await?;
    Ok(body
        .get("sessions")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![])))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![daemon_health, daemon_sessions])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
