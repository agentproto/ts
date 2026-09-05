# `agentproto app`

```text
agentproto app install <appDir> [--data-dir <path>]
agentproto app list
agentproto app pack   <appDir> [--out <path.agentapp>] [--json]
agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]
agentproto app serve  [appDir] [--port <n>] [--remote-mcp-url <url>] [--json]
agentproto app build  <appDir> [--json]
agentproto app dev    <appDir> [--port <n>] [--json] [-- <viteArgs...>]
agentproto app init   <template> [dir]
agentproto app validate [dir] [--json]
```

> This page covers the `agentproto app` CLI verb (install/serve/pack/build/
> dev). For what a bundled agent can actually reach at runtime — `app_run`,
> and which tool ids an `AGENT.md` can declare — see [Which tools can an app
> agent call?](../guides/app-agent-tools.md).

Bundle an agentproto app folder (one carrying a valid `.agentproto/APP.md`)
into a single self-contained `.agentapp` tar.gz — the "APK for agentproto
apps" — and unpack that bundle back into a folder, verifying an aggregate
SHA-256 before restoring. Entirely local and dependency-free (system `tar`):
no daemon, no network. `build` and `dev` compile/run an app's optional `ui/`
**source** project (Vite + TypeScript) into/against the static
`.agentproto/ui/` that `serve`, `pack`, and the MCP-Apps panel actually
consume — see [Optional `ui/` source project](#optional-ui-source-project)
below.

An app folder is any directory with `.agentproto/APP.md` plus the agents
(`.agentproto/agents/<id>/AGENT.md`), workflows
(`.agentproto/workflows/<id>/WORKFLOW.md`), and optional UI
(`.agentproto/ui/`) it references — the shape `defineApp().emit(dir)`
(`@agentproto/app-kit`) produces. The bundle walks the WHOLE folder
(including `.agentproto/` and any loose workspace files, but skipping any
`node_modules/` or `.git/` directory at any depth — a `ui/` source tree ships
both and neither belongs in the shipped app), so unpacking restores the
exact tree and relative paths that `readAppRefs` / `app_install` depend on
survive the round-trip.

## Subverbs

### `install <appDir> [--data-dir <path>]`

Register the app (its `id` from `.agentproto/APP.md`) → `<appDir>` mapping in
`~/.agentproto/apps.json`, the same file the daemon's `app_install` writes, so
`agentproto app serve --app <id>` and the daemon can resolve it. Idempotent:
re-running for the same id updates the entry.

| Flag | Default | Description |
|------|---------|-------------|
| `--data-dir <path>` | see below | Where the app's durable data — everything `app_data_read` / `app_data_write` / `app_data_list` touch — lives. Absolute, `~`-relative, or relative to `<appDir>`. This is what keeps multi-GB generated output out of the app's source tree. |

The registered **data dir** is resolved, in order: `--data-dir` → the entry's
previously registered data dir (a bare re-install never moves an app's data)
→ the APP.md `data.dir` frontmatter hint (relative to `<appDir>`) →
`<appDir>/data`. It is stored absolute; the daemon's `app_install {dir,
dataDir}` follows the same precedence.

How paths resolve against it (the daemon's rule, `packages/runtime/src/app-data.ts`):

1. An app-relative path resolves under the data dir.
2. Under the default layout (`<appDir>/data`) a leading `data/` is the legacy
   spelling from when the plane was anchored at `<appDir>` and is dropped —
   `data/trips/x.json` and `trips/x.json` name the same file.
3. If a path (or its top-level folder) does not exist under the data dir but
   does under `<appDir>`, it resolves there — files written by a pre-data-dir
   install keep working, and `app_data_list` merges both views. Move the
   folder into the data dir and the fallback stops applying.

### `list`

Print every registered app as `id -> dir`, each followed by its data dir
(entries written before the field existed show `<dir>/data`).

### `serve [appDir] [--port <n>] [--json]`

Serve an agentproto app's `.agentproto/ui/` as a standalone webapp with a
working `window.McpApp` bridge wired to the daemon's `/mcp` endpoint. The same
HTML dashboard that renders inside an MCP-Apps panel now runs in a plain
browser tab with full MCP connectivity.

| Flag | Default | Description |
|------|---------|-------------|
| `appDir` | current directory | Directory holding `.agentproto/APP.md` + `.agentproto/ui/`. Ignored in remote mode (see below). |
| `--port <n>` | declared `ui.port` in `APP.md`, else OS-assigned | Port to bind. A declared `ui.port` that is already taken falls back to auto-assign; an explicit `--port` that is taken is a hard error. Not read in remote mode (no `APP.md`) — there `--port` or auto-assign applies. |
| `--remote-mcp-url <url>` | unset | Streamable-HTTP MCP endpoint of a remote server (e.g. `https://api.example.com/mcp`). Setting this enables **remote mode** (see below). Env: `AGENTPROTO_REMOTE_MCP_URL`. |
| `--remote-mcp-auth <token>` | unset | Bearer token sent as the `Authorization` header on every MCP request to the remote server. Env: `AGENTPROTO_REMOTE_MCP_AUTH`. |
| `--remote-app-id <appId>` | unset | The MCP-Apps app id to render in remote mode, or a full `ui://…` resource URI. A bare id is fetched as `ui://<appId>`. Env: `AGENTPROTO_REMOTE_APP_ID`. |
| `--json` | `false` | Print `{ url, appDir, daemonMcpUrl }` (or, in remote mode, `{ url, mode: "remote", appId, resourceUri, daemonMcpUrl }`) on stdout instead of a human summary. |

Start the daemon first (`agentproto serve`); the bridge proxies tool calls to
`http://127.0.0.1:<daemon.port>/mcp`.

`app serve` also exposes a same-origin file-upload endpoint for app UIs:
`POST /__agentproto/upload?filename=<name>` with the raw file bytes as the
body. Files land in `<appDir>/inbox/` with a sanitized, collision-avoided
name, and the endpoint returns `{ path, bytes }`. Uploads are capped at 200 MB.

**Remote mode** (`--remote-mcp-url` set): instead of serving a local app dir
and proxying tool calls to the local daemon, `app serve` connects its MCP
client to a REMOTE MCP server and renders one of ITS MCP-Apps `ui://`
resources as a browser tab. There is no local app directory in this mode —
the HTML is fetched over MCP (`readResource`) and no `ui.tools` allowlist
applies: every tool the remote server exposes is forwarded, with the
loopback-only bind as the safety gate.

### `pack <appDir> [--out <path.agentapp>] [--json]`

Reads `<appDir>/.agentproto/APP.md`, walks the entire app dir, computes an
aggregate SHA-256 over every file, writes a `manifest.json` at the bundle
root, and emits a gzipped tar archive containing `manifest.json` plus the
app folder's *contents* (not a wrapping folder). Extraction therefore yields
`manifest.json`, `.agentproto/`, and the loose files at top level.

| Flag | Default | Description |
|------|---------|-------------|
| `--out <path>` | `<safeId>-<version>.agentapp` in cwd | The output `.agentapp` path. When omitted, derives a filesystem-safe filename from the app `id` and `version` (e.g. `@agentproto/job-application-kit` v`0.1.0` → `agentproto-job-application-kit-0.1.0.agentapp`). |
| `--json` | `false` | Print the generated `manifest.json` on stdout instead of a human summary. |

Fails with exit code `2` if `<appDir>` has no `.agentproto/APP.md`.

### `unpack <file.agentapp> [--dir <outDir>] [--json]`

Extracts the bundle to a temp dir, reads and validates `manifest.json`
(required, `format: agentapp/v1`), recomputes the aggregate SHA-256 over the
listed files and compares it to the manifest — a mismatch means the bundle
is corrupted and the command fails (exit `1`) without restoring. On success
it copies the app contents (excluding `manifest.json`, which is a bundle
artifact, not part of the app) into the destination.

| Flag | Default | Description |
|------|---------|-------------|
| `--dir <dir>` | `<safeId>-<version>` in cwd | Dest folder to restore into. When omitted, derives `<safeId>-<version>` from the manifest. |
| `--json` | `false` | Print a machine-readable verification summary on stdout. |

### `serve [appDir] [--port <n>] [--json]`

Serves `<appDir>/.agentproto/ui/` as a standalone webapp with a working
`window.McpApp` bridge, so the same UI that renders inside an MCP-Apps panel
runs in a plain browser tab with full MCP connectivity. Port resolution:
`--port` > the app's declared `ui.port` (APP.md frontmatter) > an
OS-assigned free port. Requires the daemon (`agentproto serve`) to be
running — the bridge forwards tool calls to its `/mcp` endpoint.

### `build <appDir> [--json]`

Builds `<appDir>/ui/` (the optional Vite UI **source** project — see
[Optional `ui/` source project](#optional-ui-source-project)) into
`<appDir>/.agentproto/ui/`, the static output `serve`/`pack`/the MCP-Apps
panel consume.

- No `ui/package.json`, or one with no `scripts.build` → **no-op success**
  (exit `0`): the app is a hand-written static UI with nothing to compile.
  Human output: `no ui build step — static UI passthrough`. `--json`:
  `{"built":false,"reason":"no-ui-project"}` (missing `ui/package.json`) or
  `{"built":false,"reason":"no-build-script"}` (present but no
  `scripts.build`).
- Otherwise runs `<pm> run build` with cwd `<appDir>/ui`, stdio inherited.
  The package manager is detected from a lockfile — `pnpm-lock.yaml` →
  pnpm, `package-lock.json` → npm, `yarn.lock` → yarn — checked in
  `<appDir>` first, then `<appDir>/ui`, defaulting to pnpm.
- A non-zero build exit is a hard failure (exit `1`). After a successful
  build, `agentproto app build` verifies `<appDir>/.agentproto/ui/index.html`
  exists; if the ui project's `vite.config.ts` doesn't emit there
  (`outDir: "../.agentproto/ui"`), that's also exit `1`, with a hint.
- `--json` success: `{"built":true,"uiDir":"<abs .agentproto/ui path>"}`.

Fails with exit code `2` if `<appDir>` has no `.agentproto/APP.md`.

### `dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]`

Runs `<appDir>/ui/`'s own dev server (`<pm> run dev`, same package-manager
detection as `build`) with a live `window.McpApp` bridge — the `app serve`
experience but with Vite's HMR instead of a static build. Requires
`<appDir>/ui/package.json` to declare a `scripts.dev`; a hand-written static
UI has nothing to hot-reload — use `agentproto app serve` instead (exit `2`
otherwise).

Two servers run: the ui project's own dev server (whatever port it picks)
and a bridge-only HTTP server this command owns — `POST
/__agentproto/tool-call` plus `OPTIONS`/CORS, since the browser talks to the
Vite dev origin, a different port than the bridge. `--port` sets the
bridge server's port (default: OS-assigned). The dev server child is spawned
with `AGENTPROTO_BRIDGE_URL=http://127.0.0.1:<bridgePort>` in its
environment, so a scaffolded `vite.config.ts` can proxy `/__agentproto` to
it. Extra args after `--` are forwarded to `<pm> run dev`.

When APP.md declares `ui.port` (the same frontmatter `serve` reads) and no
`-- <viteArgs>` were passed at all, `dev` appends `--port <declared>` to the
`<pm> run dev` invocation itself, so the ui dev server's own URL is stable
and matches the app's declared surface — this is unrelated to the `--port`
flag above, which only controls the bridge server. Passing any explicit
`viteArgs` disables the hint entirely: you're steering the dev server
directly, so nothing gets merged on top of your flags.

Ctrl-C or the dev server child exiting tears both servers down; `app dev`
exits with the child's exit code. `--json` prints
`{"bridgeUrl":"...","appDir":"..."}` on one line before handing the
terminal to the dev server.

### `init <template> [dir]`

Scaffold `[dir]` (default: the current directory) from `<template>` — the
same `scaffoldApp` operation `pnpm create agentproto-app <dir>` drives, so
no second package install is needed. Refuses a non-empty target directory
(exit `2`, reason `target-not-empty`); an unknown template is also exit `2`.

Templates:

| Template | Shape |
|----------|-------|
| `react-ts` | Vite + TanStack Router/Query `ui/` source project + `.agentproto/` shell (the `create-agentproto-app` default) |
| `vanilla` | minimal `.agentproto/` shell + static UI |
| `book` | the book-app trame (category `book`, library stub, install skill) |
| `trame` | the minimal AIP app trame — see below |

The `trame` template emits everything `validate` (below) knows how to
check, mirroring the book-factory app layout:

```text
<dir>/.agentproto/APP.md                       (id from the dir slug, one agent, one workflow,
                                               ui.tools incl. app_state_get/app_state_list,
                                               verify.command: "node scripts/verify.mjs")
<dir>/.agentproto/agents/<slug>-agent/AGENT.md
<dir>/.agentproto/workflows/<slug>-flow/WORKFLOW.md
<dir>/.agentproto/workflows/<slug>-flow/prompts/run.md
<dir>/.agentproto/ui/index.html                (single file, window.McpApp-aware stage board)
<dir>/gates/example.mjs                        (exit 0 + one-line JSON report)
<dir>/scripts/verify.mjs                       (runs the gates, prints {ok, findings})
<dir>/data/DATA.md                             (the data-plane key dictionary)
<dir>/tests/gate.test.mjs                      (node --test suite)
```

The workflow ships ONE `kind: agent` step (harness-pinned: `model`,
`effort`, `role`, `promptFile` — the file wins over the inline prompt)
followed by ONE `kind: gate` step running `node gates/example.mjs` from the
app root.

### `validate [dir] [--json]`

Check `[dir]` (default: the current directory) against the app loader.
Exit `0` iff ALL of:

1. `loadAppHandle` (`@agentproto/app-kit`) succeeds — `APP.md` parses, every
   `AGENT.md` loads, and the `defineApp` attachment invariant holds.
2. Every declared workflow loads via `@agentproto/workflow-loader` —
   harness blocks, `promptFile` resolution, and `kind: gate` steps are
   validated there.
3. Every `ui.tools` entry is a known daemon tool or any `app_*` tool. There
   is no authoritative exported tool-name list in the daemon today, so the
   CLI validates against a documented static list of the
   orchestration/session surface (`agent_start`, `agent_prompt`,
   `agent_output`, `agent_kill`, `agent_export`, `session_list`,
   `session_monitor`, `session_events_poll`, `session_tree`,
   `session_set_keepalive`, `message_parent`, `command_execute`,
   `permissions_list`, `permissions_respond`, `task_create`, `task_list`,
   `task_claim`, `task_update`, `daemon_health`) plus the whole `app_*`
   family.
4. When APP.md declares `data.dir`, `<dir>/<data.dir>/DATA.md` exists (the
   data plane must ship its key dictionary — see `data/DATA.md`).
5. When APP.md declares `verify.command`, it is run — argv-split on
   whitespace, NO shell, cwd = the app dir, 10-minute cap. Its stdout is
   printed verbatim and its exit code propagated: with no other findings,
   `validate` exits with the verify command's own exit code.

Findings print one per line as `[error] <scope>: <message>` on stderr.
`--json` prints `{ ok, findings: [{scope, level, message}] }` on stdout;
exit `0` iff `ok`.

## Optional `ui/` source project

An app's `.agentproto/ui/` is always the thing actually served — a plain
`index.html` + assets, hand-written or built. An app MAY additionally carry
a `ui/` **source** project (a Vite + TypeScript project) that *builds into*
`.agentproto/ui/`:

- `vite.config.ts` sets `outDir: "../.agentproto/ui"`, `emptyOutDir: true`,
  and `base: "./"` (relative asset paths, since the daemon / `app serve` /
  the MCP-Apps panel serve static files with no rewrite rules and may serve
  from a subpath).
- The router (if any) uses hash history (`createHashHistory`) for the same
  reason: one `index.html` + hash routes works from any subpath, and even
  `file://`, with no per-route HTML emission needed from the static host.
- No `ui/` directory, or a `ui/` without a `package.json` build script,
  means the app is a hand-written static UI — `app build` no-ops
  successfully and `app dev` isn't available (use `app serve`).

`create-agentproto-app` scaffolds this shape (Vite + TanStack Router +
TanStack Query + `@agentproto/app-client`) end to end.

## The `manifest.json`

```json
{
  "format": "agentapp/v1",
  "id": "@agentproto/job-application-kit",
  "name": "Job Application Kit",
  "version": "0.1.0",
  "description": "…",
  "agents": ["job-scout", "job-tailor"],
  "workflows": ["job-hunt"],
  "ui": ["index.html"],
  "files": [".agentproto/APP.md", "base-cv.json", "dossiers/…"],
  "fileCount": 29,
  "totalSize": 123456,
  "sha256": "abc123…",
  "createdAt": "2026-08-11T…",
  "agentprotoVersion": ">=0.1.0"
}
```

`files` are relative paths (sorted); `ui` is an array of bundled UI
filenames when the app declares one. `sha256` is an aggregate over the
concatenated bytes of every bundled file in `files` order (excluding
`manifest.json` itself), which is exactly what `unpack` recomputes to
verify integrity.

## Examples

```bash
# Register an app, keeping its generated output on a big external volume
agentproto app install ./tripsmith --data-dir /Volumes/big/tripsmith-data

# Pack a real app into the current directory
agentproto app pack ./job-application-kit

# Pack with an explicit output path and JSON manifest
agentproto app pack ./job-application-kit --out kit.agentapp --json

# Unpack into a chosen folder (verifies SHA first)
agentproto app unpack kit.agentapp --dir ./my-app

# An unpacked folder is itself packable again (round-trip stable)
agentproto app pack ./my-app

# Scaffold the minimal app trame, then prove it is sound
agentproto app init trame ./my-app
agentproto app validate ./my-app --json

# Build a ui/ source project into .agentproto/ui/ (no-ops for a static UI)
agentproto app build ./my-app

# Run the ui/ dev server with a live MCP bridge (daemon must be running)
agentproto app dev ./my-app

# Forward extra args to the underlying dev server
agentproto app dev ./my-app -- --host 0.0.0.0
```