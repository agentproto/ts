---
name: bureau
description: >-
  Drive Bureau, the browser stack's installable capability server: a stealth
  Firefox (Camofox) plus a daemon that exposes browser tools as MCP-over-HTTP on
  :8830, plus a CLI for saved browser accounts (the CLI verbs say sessions),
  social capture and search, adapter health probes, and declarative workflows.
  Use when working WITH the Bureau product itself: running the daemon, managing
  saved accounts and credentials, capturing footprints, probing adapter drift,
  or hitting its /mcp surface. To drive a page as an agent, use the `browser`
  skill; this one is the packaged daemon and its CLI.
metadata:
  tags:
    bureau, camofox, mcp, browser, sessions, social, capture, footprint,
    workflow, daemon, agentproto
---

# Bureau: the installable browser capability server

## Driving pages: use the browser skill

This skill is the product and its CLI. To drive a page as an agent, use the
`browser` skill: it starts from `browser_list_instances`,
`browser_list_accounts` and `browser_list_owned_tabs`, then drives the tab you
own. That skill carries the account model (an account on a site, not a saved
identity) and the ownership, consent and grant rules. The listing tools exist: `browser_list_instances`, `browser_list_accounts` and
`browser_list_owned_tabs` (`bureau_tabs` lists every session's tabs, not only yours).

## Quick start: bureau start

`bureau start` orchestrates Camofox headless + `bureau serve` in a single
command.

```bash
bureau start                              # Camofox :9377 + serve :8830, foreground
bureau start --detach                     # everything in background, exit 0 when healthy
bureau start bureau-only                  # Camofox assumed up, only starts serve
bureau start --port 9000                  # bureau serve on :9000
bureau start --camofox-port 9400 --detach
bureau start --camofox-cmd "camoufox serve --port 9377" --detach
bureau start --timeout 90                 # max wait 90 s (default 60)
```

Resolution of the Camofox command (order): `--camofox-cmd` →
`$CAMOFOX_SERVE_CMD` → `launchctl start sh.bureau.camofox` (macOS - the launchd
label `sh.bureau.camofox` is a user-configurable default; adapt it to your own
installed label). If nothing resolves, it fails with an explicit error and
instructions. Idempotent: if Camofox is already up, it does not respawn it.

Bureau is the **standalone, shipped product** of the browser stack: one daemon
co-located with a stealth Firefox (Camofox), exposing browser capabilities as
**MCP-over-HTTP** plus a CLI. Same daemon runs three ways behind one
`BureauEndpoint` contract - `bureau serve` on the user's machine (this skill),
agentproto-daemon-managed, or as a cloud RuntimeSpec on a browser
workstation. It is its own appliance with no dependency on any hosting platform.

## Layout

- **App**: `apps/bureau` - the CLI + serve entrypoint (`@agentproto/bureau`, `bin: bureau`).
- **Invoke**: `node apps/bureau/dist/index.js <cmd>` (built output), or
  `pnpm --filter @agentproto/bureau dev <cmd>` (tsx watch), or the global `bureau` bin if linked.
- **State**: the Bureau home, `~/.agentproto/bureau/` by default; the
  `BUREAU_HOME` environment variable overrides it for every piece of state
  (`sessions/`, `exports/`, pairings, grants, `browsers.yaml`, `runtime.json`).
  A per-directory variable (for example `BUREAU_SESSIONS_DIR`) still wins for
  its own directory. If you cannot find `exports/`, check whether the running
  daemon was started with another `BUREAU_HOME`.
  Secrets (platform passwords, API tokens) live in the **OS Keychain**, never
  on disk or argv.
- **Ports**: daemon `:8830` (MCP `/mcp` + `/watch/<tab>` screencast +
  `/health`); Camofox REST `:9377`.

## Daemon

```bash
node dist/index.js [serve]          # start the capability server (default cmd)
curl -s http://127.0.0.1:8830/health         # {"ok":true,"tools":65,...}  (/health is open)
```

`serve` needs Camofox up on :9377 first. Verify with
`curl -s http://127.0.0.1:9377/health` → `{"ok":true,"engine":"camoufox",...}`.
`/mcp` accepts one credential, a device bearer minted by pairing (`bureau
install-mcp` writes it into a client's MCP config; see `docs/pairing.md`). Every
call needs `Authorization: Bearer <token>`; without it the answer is `401`. Never
paste the token into a prompt or a log: read it from your client's config file
into a shell variable.

The MCP surface (65 tools with the default plugins) is reached over JSON-RPC at
`POST /mcp` with `Accept: application/json, text/event-stream`. `tools/list` is
the authority; the families are:

- **Page (`browser_*`, each takes `instance`, a tab you own)**: `browser_new_tab`
  (optional `url`), `browser_navigate`, `browser_click`, `browser_fill`,
  `browser_press_key`, `browser_evaluate`, `browser_get_dom`,
  `browser_screenshot`, `browser_export`, `browser_upload_file`,
  `browser_close_tab`, `browser_close_window`, `browser_list_owned_tabs`,
  `browser_list_instances`, `browser_list_accounts`.
- **Capture and recon**: `browser_record_start` / `_frame` / `_stop`,
  `browser_live_view` / `_frame` / `_stop`, `browser_list_requests`,
  `browser_get_request_body`.
- **Saved account tab (camofox)**: `browser_act` (gated writes),
  `browser_download`, `browser_cdp_send` (raw CDP, escape hatch), `scrape`.
- **Recipes**: `browser_list_recipes`, `browser_recipe_guide`, and the site
  tools each installed recipe adds (named `<site>_<action>`; the list comes
  from `browser_list_recipes`). The ones that send or publish (messages,
  invites, posts, replies, reactions) act for the user: ask first.
- **Accounts and credentials**: `bureau_accounts`, `bureau_sessions`,
  `bureau_tabs`, `list_credentials`, `record_credential`, `session_reauth`,
  `session_sync_from_chrome`, `session_lease`, `session_lease_revoke`.
- **Workflows**: `bureau_workflow_list`, `bureau_workflow_run`,
  `bureau_workflow_usage`.

Unknown arguments are an error (`browser:unknown_argument`, which lists the
accepted ones): nothing is silently dropped.

- `browser_export` renders a tab you own to a FILE on the Bureau host
  (write access; returns the path and metadata, never the bytes), under
  `<home>/exports/`. `format` is `pdf` (Chrome only), `png` (viewport,
  `fullPage` on Chrome only, or one element with `selector`), `html` (the
  serialized DOM) or `text` (readable text). camofox/Gecko cannot print to PDF
  or capture a full page and refuses with `browser:unsupported`; png of the
  viewport or of one element, html and text work there. There is no zip
  format. `browser_screenshot` also takes a `path` to write a PNG file
  instead of returning base64.
- `browser_upload_file` attaches files on the Bureau host to an
  `<input type=file>` of a tab you own (write access; CDP
  `DOM.setFileInputFiles`, Chrome only, camofox answers
  `browser:unsupported`). Each path must be a regular file of at most 25 MiB
  under an allowed root after realpath: `<home>/exports`, `upload.roots` in
  `browsers.yaml`, `BUREAU_UPLOAD_ROOTS` (colon separated). A refusal lists the
  allowed roots; copying the file into `<home>/exports` works without a restart.

```bash
# BEARER: read it from your client's MCP config into a variable, never echo it
# list tools
curl -s -X POST http://127.0.0.1:8830/mcp \
  -H "Authorization: Bearer $BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# drive: navigate + read the title
curl -s -X POST http://127.0.0.1:8830/mcp \
  -H "Authorization: Bearer $BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com","waitUntil":"load"}}}'
```

## Accounts: saved browser identities

An **account** is a named, logged-in identity ("my X demo account") resolved
against a real profile's cookies, addressed by name, never a cookie jar or
opaque "Profile 3". The CLI verbs still say `session`; in the model it is an
account. `capture` / `search` / `health` all take `--session <id>`.

```bash
bureau session scan                  # Chrome profiles as identities (★ = default)
bureau session list                  # saved sessions
bureau session show <id>             # one session + live login status
bureau session save <id> --profile "Profile 1" --platform x [--backend camofox]
bureau session rm <id>
# env: BUREAU_SESSIONS_DIR (default <BUREAU_HOME>/sessions; BUREAU_HOME defaults to ~/.agentproto/bureau)
```

`session show <id>` ends with `status: ✓ profile present and logged in` when the
account is live - the cheapest liveness check before a capture.

### Re-minting a dead account (`session login --auto`): the relog

An **owned** account (a native one) keeps its auth token in
Camofox memory, **not** in Chrome cookies - so it dies when the Camofox context
recycles, and **closing/reopening Chrome does NOT bring it back**. The fix is a
headless re-login off the Keychain creds:

```bash
# re-mint a dead session HEADLESS (no window) - secret read from Keychain, typed
# into the page, never seen by the LLM. ~40s.
bureau session login <id> --platform <p> --auto --account <stored-account>
# e.g.
bureau session login my-account --platform <platform> --auto --account you@example.com
```

An agent does the same over MCP with `session_reauth {"account": "<id>"}`: no
password argument, it answers `ok`, `needs-human` (2FA or still walled, with the
command above to finish by hand) or `no-credential`.

`--auto` requires a stored credential - `bureau creds list` shows the
`(platform, account)` pairs that can be re-minted this way. Output ends
`✓ saved owned session "<id>" → … (authed at <url>)`. Only platforms with
`bureau creds set` done can `--auto`; the rest need an interactive headful login
(port 9378). **Signs an account is dead:** reads return empty / a login-wall URL,
or a relationship/profile read comes back `state: "unknown"` (the action bar
never rendered because the page bounced to a wall).

## Social capture / search / health

```bash
# capture a footprint off a saved account → versioned FootprintFile
bureau capture <handle> --session <id> --platform <platform> \
  [--depth quick|standard|deep|exhaustive] [--slices a,b,c] [--out f.json] \
  [--land [--workspace <dir>] [--graph [--tenant <id>]]] [--record [f.mp4]]

# discover posts / people
bureau search "<query>" --session <id> --platform <platform> \
  [--kind content|people] [--limit 30] [--date past-24h|past-week|past-month] \
  [--out f.json] [--land-graph [--tenant <id>]]

# probe an adapter for drift (queryId rot / shape / auth wall) - cheap read
bureau health --session <id> --handle <subject> [--platform <x|…>]
bureau health --session <id> --handle "<query>" --search [--kind content|people]
```

`health` is the smoke test: it resolves the account to a live browser and reads
one known-good subject. Verdict `✓ OK` / `⚠ drift` / `fail`; non-zero exit on
fail/drift makes it a cron-able weekly drift alarm (one call per platform).

## Land - footprint → corpus (+ graph)

Capture is decoupled from landing: land a file produced earlier, re-land after
tuning, or pipe a fresh capture through with `bureau capture --land`.

```bash
bureau land <footprint.json> [--workspace <dir>] [--graph [--tenant <id>]]
```

## Creds - platform sign-in secrets (Keychain)

For `session login --auto` and `session_reauth`. The secret is read only at
login time to be typed into the page; never on argv (the Keychain write goes
through `security -i` on stdin), stdout, or to the orchestrator. Over MCP, `list_credentials` shows the pairs (never a secret) and
`record_credential` hands a human this command, or opens a single-use form on
the Bureau host with `via: "page"`.

```bash
bureau creds set <platform> --account <a> [--from-env VAR]   # hidden prompt or env
bureau creds list                                            # (platform, account) pairs
bureau creds rm  <platform> --account <a>
```

## Workflows - declarative AIP-15 runs

Generic host over the catalogue's workflow registry; registering a
`WorkflowDescriptor` is the entire wiring a new workflow needs.

```bash
bureau workflow list
bureau workflow run <id> [--offline <data.json> | --session <id>] [--send] \
  [--out <dir>] [--<input-flag> <value> …]
```

`--offline` replays a JSON payload through a fake session (no browser/network);
`--session` drives a saved live account. Delivery is dry-run to `./out` unless
`--send`. E.g. `house-search-report` takes
`--query --destination --recipient [--max-price --type --max-commute --limit --title]`.

## Smoke test (verified working)

A quick end-to-end pass - all of these were confirmed live against a running
daemon + Camofox:

```bash
# zsh doesn't word-split unquoted vars - use a function, not B="…"; $B
b() { node projects/browser/apps/bureau/dist/index.js "$@"; }
curl -s http://127.0.0.1:9377/health            # camofox up
curl -s http://127.0.0.1:8830/health            # {"ok":true,"tools":65,...}
b session list                                  # saved accounts present
b session show my-account                         # status: ✓ logged in
b health --session my-account --handle <handle> --platform <platform>   # ✓ OK
b workflow list                                 # registered workflows
```

## Gotchas

- **Camofox first.** `serve` and every live session need Camofox on :9377; if
  `session show` says not-logged-in, the profile cookies or Camofox are stale.
- **Headful Camofox** for interactive login flows runs on a separate port (9378)
  and may need a manual launch - see `lib/camofox-headful.ts`.
- **Keychain creds never via the LLM** - `creds set` uses a hidden prompt or a
  named env var; don't echo passwords through argv or a tool.
- **Built dist can be stale** - `pnpm --filter @agentproto/bureau build` (tsup)
  after editing, or use `dev` (tsx watch) for live iteration.
