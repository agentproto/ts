# Browser — transport, lifecycle, tabs, timeouts, tools

## Chain

```
operator tool (mcp:local-browser:*)  — or —  bridge.callImportedMcp(...)
  → guilde LocalDaemonMcpBridge → GUILDE_TUNNEL_URL (tunnel pod :3600)
  → /internal/forward → agentproto daemon (:18790, ws /connect)
  → mcp_imported_call(alias:"local-browser", toolName, args)
  → chrome-devtools-mcp (29 tools) → user's real Chrome
     (cloned profile ~/.agentproto/chrome-profile-guildebrowser — carries logins/cookies)
```

Health:
`api 3040 · tunnel 3600 (/internal/forward→401) · daemon 18790 (/health→200)`.
If down: `agentproto serve --connect ws://localhost:3600/connect`. Reusable
bridge patterns: `projects/guilde/apps/api/scripts/linkedin-*.ts`.

## ⚡ Timeouts & speed (read first)

- After ~5-6 s with no answer → ~90 % a hard hang. Use **~8 s** forward timeout,
  never 60 s. Abort + proceed; don't wait.
- `navigate_page` is the flaky op (waits for "load"; many SPAs never idle).
  **Clicks that navigate hang the same way.** Prefer **direct URL navigation**.
- In-page API fetch / `evaluate` is near-instant once on the target origin —
  lean on it; don't depend on full render.

## Tool surface + arg gotchas (chrome-devtools-mcp)

| Need       | Tool                                                     | Gotcha                                                                                                      |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| navigate   | `navigate_page`                                          | `{type:"url", url}`. **No `timeout` arg.** Hangs on never-idle SPAs → fail-fast + proceed.                  |
| run JS     | `evaluate_script`                                        | `{function:"() => {…}"}`, **async supported** — the workhorse (API fetch, extraction).                      |
| see (text) | `take_snapshot`                                          | a11y tree, `uid=`-addressed (uids change every snapshot — re-snap before each click). `{filePath}` to save. |
| screenshot | `take_screenshot`                                        | `{uid}` crops to an element; `{fullPage}` (incompatible w/ uid); else viewport. See `capture.md`.           |
| wait       | `wait_for`                                               | `{text:[...], timeout}` — `text` is an **array**.                                                           |
| keys       | `press_key`                                              | `{key:"Escape"}` to close dialogs/CMP/menus.                                                                |
| tabs       | `list_pages` / `select_page` / `new_page` / `close_page` | by **`pageId`** (the number in list_pages), NOT `pageIdx`. See below.                                       |
| network    | `list_network_requests` / `get_network_request`          | `get_network_request` = **metadata only**, not the body → use the in-page fetch for data.                   |

## Tab & focus discipline

- **`list_pages` before acting.** Know count + which is `[selected]`. Never
  assume.
- Focus: `select_page({pageId:<N>, bringToFront:true})`. New work:
  `new_page({url, background:true})` (isolate, no focus-steal). Reap:
  `close_page({pageId:<N>})`. `navigate_page` drives the _selected_ tab.
- **Multi-agent contention:** chrome-devtools-mcp has ONE global selected page.
  If another agent shares the Chrome, focus **drifts between your calls** →
  **re-assert `select_page` immediately before each op**, and verify the
  snapshot is on your origin (`s.includes("<host>")`) before trusting it. Keep
  flows short.
- A generic text match (e.g. `"Message"`) can hit the global search box — target
  the specific element (link href / aria-label), not just text.

## Chrome lifecycle (hangs: "Target closed" / "Not connected")

- One daemon → one chrome-devtools-mcp → one Chrome on the cloned profile.
- **Never `pkill chrome-devtools-mcp`** — daemon-managed (and collides with
  Claude's own chrome-devtools server). Killing it leaves "Not connected".
- "Target closed" = profile lock contention (stale Chrome holds
  `SingletonLock`). Fix: **restart the daemon** (it respawns one clean Chrome);
  if needed first `pkill -f chrome-profile-guildebrowser`. Verify on
  `https://example.com` (fast).
