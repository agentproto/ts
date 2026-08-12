# `agentproto app`

```text
agentproto app pack   <appDir> [--out <path.agentapp>] [--json]
agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]
agentproto app serve  [appDir] [--port <n>] [--json]
```

Bundle an agentproto app folder (one carrying a valid `.agentproto/APP.md`)
into a single self-contained `.agentapp` tar.gz — the "APK for agentproto
apps" — and unpack that bundle back into a folder, verifying an aggregate
SHA-256 before restoring. Entirely local and dependency-free (system `tar`):
no daemon, no network.

An app folder is any directory with `.agentproto/APP.md` plus the agents
(`.agentproto/agents/<id>/AGENT.md`), workflows
(`.agentproto/workflows/<id>/WORKFLOW.md`), and optional UI
(`.agentproto/ui/`) it references — the shape `defineApp().emit(dir)`
(`@agentproto/app-kit`) produces. The bundle walks the WHOLE folder
(including `.agentproto/` and any loose workspace files), so unpacking
restores the exact tree and relative paths that `readAppRefs` / `app_install`
depend on survive the round-trip.

## Subverbs

### `serve [appDir] [--port <n>] [--json]`

Serve an agentproto app's `.agentproto/ui/` as a standalone webapp with a
working `window.McpApp` bridge wired to the daemon's `/mcp` endpoint. The same
HTML dashboard that renders inside an MCP-Apps panel now runs in a plain
browser tab with full MCP connectivity.

| Flag | Default | Description |
|------|---------|-------------|
| `appDir` | current directory | Directory holding `.agentproto/APP.md` + `.agentproto/ui/`. |
| `--port <n>` | declared `ui.port` in `APP.md`, else OS-assigned | Port to bind. A declared `ui.port` that is already taken falls back to auto-assign; an explicit `--port` that is taken is a hard error. |
| `--json` | `false` | Print `{ url, appDir, daemonMcpUrl }` on stdout instead of a human summary. |

Start the daemon first (`agentproto serve`); the bridge proxies tool calls to
`http://127.0.0.1:<daemon.port>/mcp`.

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
# Pack a real app into the current directory
agentproto app pack ./job-application-kit

# Pack with an explicit output path and JSON manifest
agentproto app pack ./job-application-kit --out kit.agentapp --json

# Unpack into a chosen folder (verifies SHA first)
agentproto app unpack kit.agentapp --dir ./my-app

# An unpacked folder is itself packable again (round-trip stable)
agentproto app pack ./my-app
```