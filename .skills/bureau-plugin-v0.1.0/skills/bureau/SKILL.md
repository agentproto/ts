---
name: bureau
description: >-
  Drive Bureau — the browser stack's installable capability server: a stealth
  Firefox (Camofox) + daemon that exposes browser tools as MCP-over-HTTP on
  :8830, plus a CLI for saved browser identities (sessions), social capture /
  search, adapter health probes, declarative workflows, and Guilde connection.
  Use when working WITH the Bureau product itself — running the daemon, managing
  saved sessions/credentials, capturing footprints, probing adapter drift, or
  hitting its /mcp surface. Distinct from the `browser` skill (the user's own
  Chrome via the local-browser tunnel chain); Bureau is its own packaged daemon
  + camofox.
metadata:
  tags:
    bureau, camofox, mcp, browser, sessions, social, capture, footprint,
    workflow, daemon, agentproto
---

# Bureau — the installable browser capability server

## Démarrage rapide : bureau start

`bureau start` orchestre Camofox headless + `bureau serve` en une seule
commande.

```bash
bureau start                              # Camofox :9377 + serve :8830, avant-plan
bureau start --detach                     # tout en arrière-plan, exit 0 si healthy
bureau start bureau-only                  # Camofox supposé up, démarre juste serve
bureau start --port 9000                  # bureau serve sur :9000
bureau start --camofox-port 9400 --detach
bureau start --camofox-cmd "camoufox serve --port 9377" --detach
bureau start --timeout 90                 # délai max 90 s (défaut 60)
```

Résolution de la commande Camofox (ordre) : `--camofox-cmd` →
`$CAMOFOX_SERVE_CMD` → `launchctl start com.agentik.camofox` (macOS). Si rien
n'est résolvable, erreur explicite avec instructions. Idempotent : si Camofox
est déjà up, ne le respawn pas.

Bureau is the **standalone, shipped product** of the browser stack: one daemon
co-located with a stealth Firefox (Camofox), exposing browser capabilities as
**MCP-over-HTTP** plus a CLI. Same daemon runs three ways behind one
`BureauEndpoint` contract — `bureau serve` on the user's machine (this skill),
agentproto-daemon-managed, or as a cloud RuntimeSpec on a Guilde
browser-workstation. Zero `@guilde` deps; it's its own appliance.

## Layout

- **App**: `projects/browser/apps/bureau` — the CLI + serve entrypoint
  (`@agstudio/bureau`, `bin: bureau`).
- **Invoke**: `node projects/browser/apps/bureau/dist/index.js <cmd>` (built
  output), or `pnpm --filter=@agstudio/bureau dev <cmd>` (tsx watch), or the
  global `bureau` bin if linked.
- **State**: `~/.agentproto/bureau/` — `sessions/` (saved identities, the cookie
  store), `guilde.json` (connection), `runtime.json` (descriptor when hosted).
  Secrets (platform passwords, gld\_ tokens) live in the **OS Keychain**, never
  on disk or argv.
- **Ports**: daemon `:8830` (MCP `/mcp` + `/watch/<tab>` screencast +
  `/health`); Camofox REST `:9377`.

## Daemon

```bash
node dist/index.js [serve]          # start the capability server (default cmd)
curl -s http://127.0.0.1:8830/health         # {"ok":true,"tools":26}
```

`serve` needs Camofox up on :9377 first. Verify with
`curl -s http://127.0.0.1:9377/health` → `{"ok":true,"engine":"camoufox",...}`.
The MCP surface (26 tools) is reached over JSON-RPC at `POST /mcp` with
`Accept: application/json, text/event-stream`. Families:

- **Drive** (`browser_navigate`/`evaluate`/`click`/`fill`/`screenshot`,
  `browser_act` — interactive write counterpart to `scrape`).
  - `browser_export` — export the current tab to a FILE on the Bureau host
    (returns the path, no base64): `png` (live viewport screenshot; `fullPage`
    is opt-in, CDP/Chrome only — camofox/Gecko captures the viewport only),
    `pdf` / `document` (branded cover + clickable TOC with real page numbers +
    running header/footer), `html-zip` / `html` / `text` — the non-png formats
    run the live DOM through `@canvakit/export`. `browser_screenshot` also takes
    a `path` now to write a PNG file instead of returning base64.
- **Social, AS a saved session** — one neutral verb per tool, dispatched over
  the `SOCIAL_PLATFORMS[platform]` adapter registry (adding a platform = one
  registry entry, never a new tool):
  - `social_action` — API-first WRITES (react/repost/reply/post/message); rides
    each platform's own in-page fetch (reliable, reaches DOM-blocked surfaces).
  - `social_conversation` — messaging READ (list inbox / read thread / resolve
    person→thread); each message carries media refs.
  - `social_media` — download an attachment's bytes from a `mediaRefs[].url`.
  - `social_feed` — public-timeline READ: `home` (own feed) / `authorPosts` (a
    person's posts), each with activity urn + author + text + reaction/comment
    counts. The public-stream counterpart to `social_conversation`.
  - `social_network` — relationship writes (`invite` / `withdrawInvitation` /
    `removeConnection`), each adapter on its most durable seam: LinkedIn via the
    **trusted-input UI ladder** (SDUI, no replayable contract — drives the real
    buttons), X via the **v1.1 friendships API** (clean fetch: create/destroy +
    `friendships/lookup` for the state read). Both read the relationship `state`
    back (connected/pending/connectable) to prove it took. `invite` = a real
    follow/request reaching a real person — gate it.
  - `social_capture` / `social_search` / `social_capture_contract` (the generic
    "capture the real request, don't guess" recorder).

  **Port coverage today** (each cell = one registry entry; grow via the
  ADAPTER-SOP, capturing on the platform's authed `*-agentik` chrome-profile
  session): `action` linkedin + x · `conversation` (inbox read) **linkedin + x +
  instagram** · `media` (attachment download) **linkedin + x + instagram +
  facebook + reddit** (one shared tiered-CDN fetch behind all of them —
  `core/media-download.ts`: tier 1 plain CORS, tier 2 credentialed + optional
  platform auth headers) · `network` **linkedin + x** · `feed` (home +
  authorPosts) **ALL 7: linkedin + x + instagram + reddit + facebook + tiktok +
  youtube** (tiktok is `authorPosts`-only — For-You needs signed `/api/*` it
  can't forge; youtube `home` = the authed recommended feed via ytInitialData,
  `authorPosts` = channel Videos over InnerTube). capture/search span all.
  FB-feed gotcha: FB ships no feed JSON and signs its GraphQL, so the feed port
  reads the RENDERED timeline (one shared harvester with the capture adapter) —
  text + author + permalink, but **no** reaction/comment counts and it needs a
  HEADFUL session. Authed chrome-profile sessions exist for x · linkedin ·
  instagram · facebook · reddit · tiktok · youtube — so any of them can grow a
  port now (no `creds set` needed; the bridge already injected the real-Chrome
  jar). X-media gotcha: media is cross-origin
  (`pbs.twimg.com`/`video.twimg.com`, `ACAO:*`) so the download fetches with NO
  credentials (a credentialed cross-origin fetch trips CORS), Bearer+ct0 only as
  the auth-walled `ton.x.com` fallback.

```bash
# list tools
curl -s -X POST http://127.0.0.1:8830/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# drive: navigate + read the title
curl -s -X POST http://127.0.0.1:8830/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com","waitUntil":"load"}}}'
```

## Sessions — saved browser identities

A **session** is a named, logged-in identity ("my Agentik X") resolved against a
real Chrome profile's cookies, addressed by name — never a cookie jar or opaque
"Profile 3". `capture` / `search` / `health` all take `--session <id>`.

```bash
bureau session scan                  # Chrome profiles as identities (★ = default)
bureau session list                  # saved sessions
bureau session show <id>             # one session + live login status
bureau session save <id> --profile "Profile 1" --platform x [--backend camofox]
bureau session rm <id>
# env: BUREAU_SESSIONS_DIR (default ~/.agentproto/bureau/sessions)
```

`session show <id>` ends with `status: ✓ profile present and logged in` when the
identity is live — the cheapest liveness check before a capture.

### Re-minting a dead session (`session login --auto`) — the relog

An **owned** session (e.g. native `linkedin`) keeps its auth token (`li_at`) in
Camofox memory, **not** in Chrome cookies — so it dies when the Camofox context
recycles, and **closing/reopening Chrome does NOT bring it back**. The fix is a
headless re-login off the Keychain creds:

```bash
# re-mint a dead session HEADLESS (no window) — secret read from Keychain, typed
# into the page, never seen by the LLM. ~40s.
bureau session login <id> --platform <p> --auto --account <stored-account>
# e.g.
bureau session login linkedin --platform linkedin --auto --account you@example.com
```

`--auto` requires a stored credential — `bureau creds list` shows the
`(platform, account)` pairs that can be re-minted this way. Output ends
`✓ saved owned session "<id>" → … (authed at <url>)`. Only platforms with
`bureau creds set` done can `--auto`; the rest need an interactive headful login
(port 9378). **Signs a session is dead:** reads return empty / a login-wall URL,
or a relationship/profile read comes back `state: "unknown"` (the action bar
never rendered because the page bounced to a wall).

## Social capture / search / health

```bash
# capture a footprint off a saved identity → versioned FootprintFile
bureau capture <handle> --session <id> --platform <x|linkedin|instagram|…> \
  [--depth quick|standard|deep|exhaustive] [--slices a,b,c] [--out f.json] \
  [--land [--workspace <dir>] [--graph [--tenant <id>]]] [--record [f.mp4]]

# discover posts / people
bureau search "<query>" --session <id> --platform <linkedin|…> \
  [--kind content|people] [--limit 30] [--date past-24h|past-week|past-month] \
  [--out f.json] [--land-graph [--tenant <id>]]

# probe an adapter for drift (queryId rot / shape / auth wall) — cheap read
bureau health --session <id> --handle <subject> [--platform <x|…>]
bureau health --session <id> --handle "<query>" --search [--kind content|people]
```

`health` is the smoke test: it resolves the session to a live browser and reads
one known-good subject. Verdict `✓ OK` / `⚠ drift` / `fail`; non-zero exit on
fail/drift makes it a cron-able weekly drift alarm (one call per platform).

## Land — footprint → corpus (+ graph)

Capture is decoupled from landing: land a file produced earlier, re-land after
tuning, or pipe a fresh capture through with `bureau capture --land`.

```bash
bureau land <footprint.json> [--workspace <dir>] [--graph [--tenant <id>]]
```

## Creds — platform sign-in secrets (Keychain)

For `session login --auto`. The secret is read only at login time to be typed
into the page; never on argv, stdout, or to the orchestrator.

```bash
bureau creds set <platform> --account <a> [--from-env VAR]   # hidden prompt or env
bureau creds list                                            # (platform, account) pairs
bureau creds rm  <platform> --account <a>
```

## Guilde connection — login / connect-token

```bash
# AIP-50 auth-manifest form (runs the provider's flow engine):
bureau login guilde [--server <url>] [--guild <id>] [--force]
# legacy explicit form:
bureau login --server <url> [--guild <id>] [--token gld_…] [--user <id>]
bureau login --status        # stored connection, no secret
bureau login --logout

# seal a local CLI credential into a connected server's vault:
bureau connect-token …
```

Token kept in the Keychain; `--status` prints server/guild/auth only.

## Workflows — declarative AIP-15 runs

Generic host over the catalogue's workflow registry; registering a
`WorkflowDescriptor` is the entire wiring a new workflow needs.

```bash
bureau workflow list
bureau workflow run <id> [--offline <data.json> | --session <id>] [--send] \
  [--out <dir>] [--<input-flag> <value> …]
```

`--offline` replays a JSON payload through a fake session (no browser/network);
`--session` drives a saved live session. Delivery is dry-run to `./out` unless
`--send`. E.g. `house-search-report` takes
`--query --destination --recipient [--max-price --type --max-commute --limit --title]`.

## Smoke test (verified working)

A quick end-to-end pass — all of these were confirmed live against a running
daemon + Camofox:

```bash
# zsh doesn't word-split unquoted vars — use a function, not B="…"; $B
b() { node projects/browser/apps/bureau/dist/index.js "$@"; }
curl -s http://127.0.0.1:9377/health            # camofox up
curl -s http://127.0.0.1:8830/health            # {"ok":true,"tools":26}
b session list                                  # saved identities present
b session show x-agentik                        # status: ✓ logged in
b health --session x-agentik --handle nasa --platform x   # ✓ OK ~4.5s
b workflow list                                 # registered workflows
```

## Gotchas

- **Camofox first.** `serve` and every live session need Camofox on :9377; if
  `session show` says not-logged-in, the profile cookies or Camofox are stale.
- **Headful Camofox** for interactive login flows runs on a separate port (9378)
  and may need a manual launch — see `lib/camofox-headful.ts`.
- **Keychain creds never via the LLM** — `creds set` uses a hidden prompt or a
  named env var; don't echo passwords through argv or a tool.
- **Built dist can be stale** — `pnpm --filter=@agstudio/bureau build` (tsup)
  after editing, or use `dev` (tsx watch) for live iteration.
