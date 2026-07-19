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

use std::process::Command;
use std::time::Duration;

use serde::Serialize;

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

/// GET /sessions/:id/events?since=<seq> — a page of the session's durable,
/// normalized semantic events (events.jsonl). A terminal-only session has no
/// transcript: the daemon answers 404 `{"error":"no_transcript"}`, which we map
/// to an empty page rather than an error so the caller degrades cleanly.
#[tauri::command]
async fn daemon_session_events(
    daemon_url: Option<String>,
    id: String,
    since: Option<u64>,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let since = since.unwrap_or(0);
    let path = format!("/sessions/{}/events?since={since}", urlencode(&id));

    let mut req = client()?.get(format!("{base}{path}"));
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();

    if status.as_u16() == 404 {
        // Terminal-only (no structured transcript) — hand back an empty page.
        return Ok(serde_json::json!({
            "sessionId": id,
            "events": [],
            "nextSeq": since,
            "complete": true,
        }));
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Minimal percent-encoding for a path segment (session ids are safe slugs, but
/// encode defensively so a slash or space can never break the route).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// POST /sessions/:id/prompt?wait=false — drive the session with a new user
/// message. Bearer-gated (mirrors the other daemon_* commands + token resolver).
/// Body shape mirrors the VS Code client's `prompt()`: `{ "prompt": <text> }`.
#[tauri::command]
async fn daemon_prompt(
    daemon_url: Option<String>,
    session_id: String,
    text: String,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = format!("/sessions/{}/prompt?wait=false", urlencode(&session_id));

    let mut req = client()?
        .post(format!("{base}{path}"))
        .json(&serde_json::json!({ "prompt": text }));
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    // The route may answer with an empty body when wait=false — treat as null.
    let raw = res.text().await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())
}

/// POST /sessions/agent — spawn a new agent session. Bearer-gated.
/// Body shape mirrors the VS Code client's `spawnAgent()`: `opts` is forwarded
/// verbatim. The daemon returns a SessionDescriptor on success.
#[tauri::command]
async fn daemon_spawn(
    daemon_url: Option<String>,
    opts: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = "/sessions/agent";

    let mut req = client()?.post(format!("{base}{path}")).json(&opts);
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    // The route answers with a SessionDescriptor object.
    let raw = res.text().await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())
}

/// POST /sessions/:id/kill — end a session. Bearer-gated. Empty body on success
/// is treated as null.
#[tauri::command]
async fn daemon_kill(
    daemon_url: Option<String>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = format!("/sessions/{}/kill", urlencode(&session_id));

    let mut req = client()?
        .post(format!("{base}{path}"))
        .json(&serde_json::json!({}));
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    let raw = res.text().await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())
}

/// POST /sessions/:id/interrupt — cancel the in-flight turn and leave the
/// session alive. Bearer-gated. Empty body on success is treated as null.
#[tauri::command]
async fn daemon_interrupt(
    daemon_url: Option<String>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = format!("/sessions/{}/interrupt", urlencode(&session_id));

    let mut req = client()?
        .post(format!("{base}{path}"))
        .json(&serde_json::json!({}));
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    let raw = res.text().await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())
}

/// GET /permissions[?sessionId=…] — list pending permission requests.
/// Bearer-gated GET; mirrors `daemon_sessions` and unwraps the `permissions`
/// array (or [] if the daemon omits it).
#[tauri::command]
async fn daemon_permissions(
    daemon_url: Option<String>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = match session_id {
        Some(id) => format!("/permissions?sessionId={}", urlencode(&id)),
        None => "/permissions".to_string(),
    };
    let body = get_json(&base, &path, true).await?;
    Ok(body
        .get("permissions")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![])))
}

/// POST /permissions/:id — respond to a pending permission request.
/// Bearer-gated. `input` is forwarded verbatim.
#[tauri::command]
async fn daemon_respond_permission(
    daemon_url: Option<String>,
    permission_id: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = daemon_url.unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string());
    let base = normalize_url(&url);
    let path = format!("/permissions/{}", urlencode(&permission_id));

    let mut req = client()?
        .post(format!("{base}{path}"))
        .json(&input);
    if let Some(token) = resolve_token(&base) {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status} — {body}"));
    }
    let raw = res.text().await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())
}

// ── git working-tree diff (WP4) ─────────────────────────────────────────────
// Sourced by shelling `git` (the SPEC default over the git2 crate: simplest,
// no extra dependency). `git -C <cwd> diff HEAD` shows all uncommitted tracked
// changes (staged + unstaged) against the last commit.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffLine {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_line: Option<u32>,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    path: String,
    name: String,
    dir: String,
    added: u32,
    removed: u32,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
struct Commit {
    hash: String,
    message: String,
}

#[derive(Serialize)]
struct GitDiff {
    branch: String,
    added: u32,
    removed: u32,
    files: Vec<ChangedFile>,
    commits: Vec<Commit>,
}

/// Run `git -C <cwd> <args…>` capturing stdout. Returns the trimmed stdout, or
/// an empty string when git fails (not a repo, no HEAD yet, git absent) — a
/// non-repo cwd yields an empty diff rather than an error.
fn git(cwd: &str, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
        .unwrap_or_default()
}

/// Split a repo-relative path into (dir-with-trailing-slash, basename).
fn split_path(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

/// Parse a `@@ -a,b +c,d @@` hunk header into (old_start, new_start).
fn parse_hunk(line: &str) -> Option<(u32, u32)> {
    let inner = line.strip_prefix("@@ ")?;
    let end = inner.find(" @@")?;
    let ranges = &inner[..end];
    let mut parts = ranges.split(' ');
    let old = parts.next()?.trim_start_matches('-');
    let new = parts.next()?.trim_start_matches('+');
    let old_start: u32 = old.split(',').next()?.parse().ok()?;
    let new_start: u32 = new.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

/// Parse `git diff` unified output into per-file hunk line lists.
fn parse_diff(raw: &str) -> Vec<ChangedFile> {
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // "a/<path> b/<path>" — take the b-side path.
            let path = rest
                .split(" b/")
                .nth(1)
                .unwrap_or("")
                .trim()
                .to_string();
            let (dir, name) = split_path(&path);
            files.push(ChangedFile {
                path,
                name,
                dir,
                added: 0,
                removed: 0,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(file) = files.last_mut() else { continue };

        if line.starts_with("+++") || line.starts_with("---") || line.starts_with("index ") {
            continue;
        }
        if line.starts_with("new file")
            || line.starts_with("deleted file")
            || line.starts_with("old mode")
            || line.starts_with("new mode")
            || line.starts_with("similarity ")
            || line.starts_with("rename ")
            || line.starts_with("\\ No newline")
            || line.starts_with("Binary files")
        {
            continue;
        }
        if line.starts_with("@@") {
            if let Some((o, n)) = parse_hunk(line) {
                old_no = o;
                new_no = n;
            }
            file.lines.push(DiffLine {
                kind: "hunk".to_string(),
                old_line: None,
                new_line: None,
                text: line.to_string(),
            });
            continue;
        }
        match line.chars().next() {
            Some('+') => {
                file.added += 1;
                file.lines.push(DiffLine {
                    kind: "add".to_string(),
                    old_line: None,
                    new_line: Some(new_no),
                    text: line[1..].to_string(),
                });
                new_no += 1;
            }
            Some('-') => {
                file.removed += 1;
                file.lines.push(DiffLine {
                    kind: "del".to_string(),
                    old_line: Some(old_no),
                    new_line: None,
                    text: line[1..].to_string(),
                });
                old_no += 1;
            }
            Some(' ') => {
                file.lines.push(DiffLine {
                    kind: "ctx".to_string(),
                    old_line: Some(old_no),
                    new_line: Some(new_no),
                    text: line[1..].to_string(),
                });
                old_no += 1;
                new_no += 1;
            }
            _ => {}
        }
    }
    files
}

/// git_diff — the working-tree diff of a session's cwd (branch, per-file hunks,
/// totals, recent commits). Empty/degraded rather than erroring on a non-repo.
#[tauri::command]
async fn git_diff(cwd: String) -> Result<GitDiff, String> {
    if cwd.is_empty() || cwd == "—" {
        return Ok(GitDiff {
            branch: String::new(),
            added: 0,
            removed: 0,
            files: Vec::new(),
            commits: Vec::new(),
        });
    }
    let branch = git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let raw = git(&cwd, &["diff", "HEAD"]);
    let files = parse_diff(&raw);
    let added = files.iter().map(|f| f.added).sum();
    let removed = files.iter().map(|f| f.removed).sum();

    // Recent commits — hash + subject, unit-separator delimited.
    let log = git(&cwd, &["log", "-5", "--pretty=format:%h\x1f%s"]);
    let commits = log
        .lines()
        .filter_map(|l| {
            let (hash, message) = l.split_once('\x1f')?;
            Some(Commit {
                hash: hash.to_string(),
                message: message.to_string(),
            })
        })
        .collect();

    Ok(GitDiff {
        branch,
        added,
        removed,
        files,
        commits,
    })
}

// ── directory listing (slice 3 / Files tree) ────────────────────────────────
// Backs the React `useFileTree` hook (src/files/useFileTree.ts), which calls
// `invoke<string[]>("list_dir", { cwd })`. Contract: one absolute path string
// per entry, a trailing "/" marking a directory. The hook's parseEntry keeps
// the full path (so a directory's path can be fed straight back in to expand
// the next level) and takes the last segment as the display name.

/// list_dir — the immediate entries of `cwd`. Reads the directory with the
/// arg-array `std::fs::read_dir` (never a shell). Returns absolute paths,
/// directories suffixed with "/". A bad/unreadable path is a rejected promise
/// on the JS side, surfaced in the hook's `error` rather than thrown.
#[tauri::command]
fn list_dir(cwd: String) -> Result<Vec<String>, String> {
    let read = std::fs::read_dir(&cwd).map_err(|e| format!("{cwd}: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mut path = entry.path().to_string_lossy().to_string();
        if is_dir {
            path.push('/');
        }
        out.push(path);
    }
    Ok(out)
}

// ── file content (slice 4 / Files viewer) ───────────────────────────────────
// Backs the React `useFileContent` hook (src/files/useFileContent.ts), which
// calls `invoke<FileContentDto>("read_file", { path })`. Reads with `std::fs`
// (never a shell). A file over the cap is truncated (`truncated: true`, keeping
// the valid UTF-8 prefix); binary/non-UTF8 content is rejected with a short
// message rather than dumping bytes.

const MAX_FILE_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContentDto {
    path: String,
    content: String,
    truncated: bool,
}

/// read_file — the UTF-8 text of `path`, capped at MAX_FILE_BYTES. A bad path
/// (missing, unreadable) is a rejected promise on the JS side (surfaced in the
/// hook's `error`); binary content is rejected the same way rather than dumped.
#[tauri::command]
fn read_file(path: String) -> Result<FileContentDto, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let truncated = bytes.len() > MAX_FILE_BYTES;
    let slice = if truncated {
        &bytes[..MAX_FILE_BYTES]
    } else {
        &bytes[..]
    };

    // A NUL byte marks a binary file — don't try to render it.
    if slice.contains(&0) {
        return Err("binary file — cannot display".to_string());
    }

    let content = match std::str::from_utf8(slice) {
        Ok(s) => s.to_string(),
        // Truncation can sever a multi-byte char at the cap boundary — keep the
        // valid prefix. A genuine mid-file invalid sequence ⇒ treat as binary.
        Err(e) if truncated => std::str::from_utf8(&slice[..e.valid_up_to()])
            .map_err(|e| e.to_string())?
            .to_string(),
        Err(_) => return Err("binary file — cannot display".to_string()),
    };

    Ok(FileContentDto {
        path,
        content,
        truncated,
    })
}

// ── PR status (slice 4 / Changes → PR tab) ──────────────────────────────────
// Backs the React `usePrStatus` hook (src/changes/usePrStatus.ts), which calls
// `invoke<PrStatusDto | null>("pr_status", { cwd })`. Shells `gh pr view` in
// `cwd` (via `current_dir`, since gh — unlike git — has no `-C` flag and infers
// the repo from the working directory). No open PR / not a GitHub repo / gh
// absent ⇒ Ok(None), so the tab degrades to "no open PR" rather than erroring.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrChecks {
    passed: u32,
    failed: u32,
    pending: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrStatusDto {
    number: u64,
    title: String,
    state: String,
    url: String,
    checks: PrChecks,
}

/// Bucket a single `statusCheckRollup` entry into passed / failed / pending.
/// gh returns two node shapes: StatusContext (carries `state`) and CheckRun
/// (carries `status` + `conclusion`); normalize both to one bucket.
fn check_bucket(check: &serde_json::Value) -> &'static str {
    // StatusContext — a legacy commit status, keyed by `state`.
    if let Some(state) = check.get("state").and_then(|v| v.as_str()) {
        return match state {
            "SUCCESS" => "passed",
            "FAILURE" | "ERROR" => "failed",
            _ => "pending",
        };
    }
    // CheckRun — only a COMPLETED run carries a meaningful conclusion.
    let status = check.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "COMPLETED" {
        return "pending";
    }
    match check
        .get("conclusion")
        .and_then(|v| v.as_str())
        .unwrap_or("")
    {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => "passed",
        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "failed",
        _ => "pending",
    }
}

/// pr_status — the open PR (if any) for the repo at `cwd`. Degrades to Ok(None)
/// on every non-answer (empty cwd, gh absent, non-GitHub repo, no open PR).
#[tauri::command]
fn pr_status(cwd: String) -> Result<Option<PrStatusDto>, String> {
    if cwd.is_empty() || cwd == "—" {
        return Ok(None);
    }

    let output = Command::new("gh")
        .current_dir(&cwd)
        .args([
            "pr",
            "view",
            "--json",
            "number,title,state,url,statusCheckRollup",
        ])
        .output();

    // gh absent, no open PR, or not a GitHub repo all exit non-zero ⇒ no PR.
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(None),
    };
    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let number = json.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = json
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = json
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut checks = PrChecks {
        passed: 0,
        failed: 0,
        pending: 0,
    };
    if let Some(rollup) = json.get("statusCheckRollup").and_then(|v| v.as_array()) {
        for check in rollup {
            match check_bucket(check) {
                "passed" => checks.passed += 1,
                "failed" => checks.failed += 1,
                _ => checks.pending += 1,
            }
        }
    }

    Ok(Some(PrStatusDto {
        number,
        title,
        state,
        url,
        checks,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            daemon_health,
            daemon_sessions,
            daemon_session_events,
            daemon_prompt,
            daemon_spawn,
            daemon_kill,
            daemon_interrupt,
            daemon_permissions,
            daemon_respond_permission,
            git_diff,
            list_dir,
            read_file,
            pr_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
