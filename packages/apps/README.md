# @agentproto/apps

Ready-made agentproto **apps** — *teams* of agents plus the workflows they run,
each declared with [`@agentproto/app-kit`](../app-kit). Import a team, use any
subset of its agents/workflows from your own host.

```ts
import { codeTeam } from "@agentproto/apps/code-team"

// In-process: build the team and pick the agent(s) you want.
const built = await codeTeam.toMastraAgents({ resolveModel: (ref) => registry.resolve(ref) })
built["@agentproto/reviewer"].agent   // just the reviewer, as a runnable Mastra agent

// …or use several. The record is keyed by agent id.
const { ["@agentproto/implementer"]: impl, ["@agentproto/fixer"]: fixer } = built
```

An app here is a plain `AppHandle` — `codeTeam.agents`, `codeTeam.workflows`,
`codeTeam.toMastraAgents(...)`, `codeTeam.emit(dir)`. Nothing new to learn.

## Teams

| Team | Import | Agents | Workflows |
| --- | --- | --- | --- |
| `code-team` | `@agentproto/apps/code-team` | `implementer` → `reviewer` → `fixer` | `deliver-change` |
| `content-team` | `@agentproto/apps/content-team` | `researcher` → `writer` → `editor` → `illustrator` | `produce-content`, `produce-cover` |
| `mail-triage` | `@agentproto/apps/mail-triage` | `triager` | `triage-inbox` |
| `media-viewer` | `@agentproto/apps/media-viewer` | `cataloger` | `scan-media` |
| `session-viewer` | `@agentproto/apps/session-viewer` | `narrator` | `narrate-session` |
| `ops-panel` | `@agentproto/apps/ops-panel` | `manager`, `watchdog` | — |

Each team is a folder with `agents/<name>.ts` (one self-contained file per agent
— its `defineAgent` handle + `body`) and `workflows/<name>.ts`, composed in the
team's `index.ts`. A new team is a sibling folder + a re-export.

## Two ways to consume

- **In-process** — `await team.toMastraAgents({ resolveModel })` returns the
  built agents keyed by id; take the ones you need. `@mastra/core` is a peer
  dependency, so install it in the host.
- **On disk** — `await team.emit(dir)` writes the AGENT.md / WORKFLOW.md
  manifests for a runtime that loads a workspace from disk. No Mastra needed.

## Emitting the whole catalog

`@agentproto/apps` also ships an `agentproto-apps-sync` binary that emits every
bundled app to disk and writes a flat catalog:

```bash
npx agentproto-apps-sync [--base-dir <dir>]
```

The default base directory is `~/.agentproto/apps`. It writes each app's
manifests under `<baseDir>/<slug>/` and a summary catalog to
`<baseDir>/../app-catalog.json` (so `~/.agentproto/app-catalog.json` by
default). The five builtin daemon panels above are **not** part of this
sync/emit flow — they aren't `AppHandle`s, so there's nothing to `.emit(dir)`.
A running daemon lists them in `app_catalog` directly (see "Builtin daemon
panels" above), independent of this file and of `~/.agentproto/apps.json`.

## Builtin daemon panels

Five of `@agentproto/runtime`'s daemon-builtin MCP-Apps widgets live here too,
as house-app-quality code — but they are **not** `AppHandle`s (`defineApp`
requires a non-empty `agents` array, and these are pure read-only viewers with
no agent of their own):

| Panel | Import | MCP tool id |
| --- | --- | --- |
| `sessions-panel` | `@agentproto/apps/sessions-panel` | `agentproto_sessions` |
| `agents-overview` | `@agentproto/apps/agents-overview` | `agentproto_agents_overview` |
| `bureau-sessions` | `@agentproto/apps/bureau-sessions` | `agentproto_bureau_sessions` |
| `session-story` | `@agentproto/apps/session-story` | `agentproto_session_story` |
| `live-session` | `@agentproto/apps/live-session` | `live_session` |

Each exports a `make<Name>App(ops)` factory producing an `AgnoMcpApp` — the
shape `@agentproto/runtime`'s `mcp-apps-adapter.ts` mounts on the daemon's MCP
server. `@agentproto/runtime`'s `builtin-apps.ts` wraps these five with the
daemon's own session registry and mounts them at boot, unconditionally — no
`app_install` step, and they're always listed in `app_catalog` under
`category: "builtin"`. A sixth builtin panel, the terminal, stays in
`@agentproto/runtime` (`terminal-panel-app.ts`) — it needs a live PTY
WebSocket, not a portable tool-call-driven `AgnoMcpApp`.

## Generic by design

Team ids are `@agentproto/…` and depend on **no** product package (the
architecture invariant: nothing under `@agentproto/*` may import an app's
`@<app>/core`). That's what lets any host — including agentik-studio — import a
team and use its agents/workflows directly.
