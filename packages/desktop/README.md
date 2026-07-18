# agentproto-desktop

Native desktop shell for the agentproto daemon — a standalone window over the
same daemon the [VS Code extension](../vscode) drives. Built with
[Tauri v2](https://tauri.app) (system WebView + Rust core, ~5 MB app) so it
reuses the daemon rather than embedding one.

## Architecture

All network + token access lives in **Rust** (`src-tauri/src/lib.rs`), exposed
to the React WebView as Tauri commands. This keeps the per-boot token file read
(`~/.agentproto/daemons/<port>.json`) and the loopback HTTP calls out of the
WebView entirely — no CORS, no token in JS. Mirrors the VS Code extension's
`DaemonClient` contract (`packages/vscode/src/client/daemonClient.ts`):

| Command (Rust)     | Daemon call        | Notes                                   |
| ------------------ | ------------------ | --------------------------------------- |
| `daemon_health`    | `GET /health`      | public liveness probe, no auth          |
| `daemon_sessions`  | `GET /sessions`    | Bearer-gated; token auto-resolved       |

- **Frontend:** React 19 + Vite (`src/`) — `src/daemon.ts` wraps the commands,
  `src/App.tsx` renders the live session list (5 s poll).
- **Core:** Rust (`src-tauri/`) — `reqwest` for HTTP, `dirs` for the home dir.

## Develop

```bash
# Rust toolchain required once (rustup). Then, from the repo root:
pnpm install          # one lockfile for the whole ts monorepo
# from this package dir:
pnpm tauri dev        # compiles the Rust core + opens the window
```

Point it at a running daemon (`agentproto daemon`) — default
`http://127.0.0.1:18790`, editable in the URL bar.

## Build

```bash
pnpm tauri build      # produces a .app / .dmg under src-tauri/target/release/bundle/
```

Unsigned builds run locally (right-click → Open on first launch). Distribution
signing/notarization needs an Apple Developer ID cert — not required for dev.

## Roadmap

First slice ships health + session list. Next: open a session transcript
(`GET /sessions/:id/events` + SSE stream), spawn/drive/stop, permission prompts
— the same surface the VS Code extension already exposes.
