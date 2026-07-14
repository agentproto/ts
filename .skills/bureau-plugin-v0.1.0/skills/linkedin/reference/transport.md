# LinkedIn — transport, lifecycle, discipline

The browser is just an **authenticated transport**. Get it stable, then do
everything via the Voyager API (`voyager.md`).

## Chain

```
operator tool (mcp:local-browser:*)  — or —  bridge.callImportedMcp(...)
  → guilde LocalDaemonMcpBridge → GUILDE_TUNNEL_URL (tunnel pod :3600)
  → /internal/forward → agentproto daemon (:18790, ws /connect)
  → mcp_imported_call(alias:"local-browser", toolName, args)
  → chrome-devtools-mcp (29 tools) → user's real Chrome
     (cloned profile ~/.agentproto/chrome-profile-guildebrowser — carries cookies/logins)
```

Health:
`api 3040 · tunnel 3600 (/internal/forward → 401) · daemon 18790 (/health → 200)`.
Harnesses: `projects/guilde/apps/api/scripts/linkedin-*.ts` (explore, message;
the ephemeral `_li-*.ts` ones are discovery scratch — recreate as needed).

## ⚡ Timeouts & speed (read first)

- **After ~5-6 s with no answer → ~90 % it's a hard hang.** Use **~8 s** forward
  timeout, never 60 s. Abort + proceed; don't wait.
- `navigate_page` is the flaky op (waits for "load"; LinkedIn SPAs never idle).
  **Clicks that trigger navigation hang the same way.** Prefer **direct
  navigation to a URL** over clicking links/buttons that navigate (proven: the
  Message and custom-invite URLs work; clicking the same links times out).
- The **Voyager fetch is near-instant** once on any linkedin.com page — lean on
  it; don't depend on full render.

## Tool gotchas (chrome-devtools-mcp)

| Need                    | Tool                                               | Gotcha                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| navigate                | `navigate_page`                                    | `{type:"url", url}`. **No `timeout` arg.** Hangs on never-idle SPAs.                                                                                                                                                                                                                                                                                                                                                                              |
| run JS                  | `evaluate_script`                                  | `{function:"() => {…}"}`, **async supported** — the workhorse (Voyager fetch).                                                                                                                                                                                                                                                                                                                                                                    |
| see                     | `take_snapshot`                                    | a11y tree, `uid=`-addressed (uids change every snapshot — re-snap before each click). `take_screenshot` for pixels.                                                                                                                                                                                                                                                                                                                               |
| **element-scoped shot** | `take_screenshot({uid})`                           | ✅ crops to that element's box (snapshot it first to get the uid; it scrolls the element into view). `fullPage` is incompatible with `uid`. Target the **container** uid (e.g. `article`/content div), not just the `h1`, for the whole block. Alternatives: our headless driver `browserScreenshot({selector})` (CSS); or any driver via CDP `Page.captureScreenshot({clip:{x,y,width,height}})` from `getBoundingClientRect()` (arbitrary box). |
| wait                    | `wait_for`                                         | `{text:[...], timeout}` — `text` is an **array**.                                                                                                                                                                                                                                                                                                                                                                                                 |
| keys                    | `press_key`                                        | `{key:"Escape"}` to close dialogs/dropdowns.                                                                                                                                                                                                                                                                                                                                                                                                      |
| tabs                    | `list_pages`/`select_page`/`new_page`/`close_page` | see below.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| network                 | `list_network_requests`/`get_network_request`      | `get_network_request` = **metadata only (~144 B), not the body** → use the fetch.                                                                                                                                                                                                                                                                                                                                                                 |

## Tab & focus discipline

- **`list_pages` before acting.** Know count + which is `[selected]`. Never
  assume.
- New work → `new_page({url})` (isolates; keeps prior tab). `navigate_page`
  drives the _selected_ tab — confirm focus first.
- **Focus a tab: `select_page({pageId:<N>, bringToFront:true})`** where `<N>` is
  the number shown in `list_pages` (it's `pageId`, NOT `pageIdx` — `pageIdx`
  400s). `close_page({pageId:<N>})` to reap. `new_page({url, background:true})`
  opens without stealing focus.
- A generic text match (e.g. `"Message"`) can hit the global search box — target
  the specific element (link href / aria-label), not just text.
- **Multi-agent contention:** chrome-devtools-mcp has ONE global selected page.
  If another agent shares the Chrome, focus **drifts between your calls**.
  Defense: **re-assert `select_page({pageId, bringToFront:true})` immediately
  before each op**, and verify the snapshot is on your origin
  (`s.includes("linkedin.com")`) before trusting it. Keep flows short; a
  select→snapshot pair has the smallest steal window.

## Chrome lifecycle (hangs: "Target closed" / "Not connected")

- One daemon → one chrome-devtools-mcp → one Chrome on the cloned profile.
- **Never `pkill chrome-devtools-mcp`** — daemon-managed (and collides with
  Claude's own chrome-devtools server). Killing it leaves "Not connected".
- "Target closed" = profile lock contention (stale Chrome holds
  `SingletonLock`). Fix: **restart the daemon**
  (`agentproto serve --connect ws://localhost:3600/connect`) — it respawns one
  clean Chrome. If needed first: `pkill -f chrome-profile-guildebrowser`.
- Verify recovery on `https://example.com` (fast) before retrying.
