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
default).

## Generic by design

Team ids are `@agentproto/…` and depend on **no** product package (the
architecture invariant: nothing under `@agentproto/*` may import an app's
`@<app>/core`). That's what lets any host — including agentik-studio — import a
team and use its agents/workflows directly.
