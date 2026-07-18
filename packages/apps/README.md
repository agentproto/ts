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

| Team | Import | Agents | Workflow |
| --- | --- | --- | --- |
| `code-team` | `@agentproto/apps/code-team` | `implementer` → `reviewer` → `fixer` | `deliver-change` |
| `content-team` | `@agentproto/apps/content-team` | `researcher` → `writer` → `editor` | `produce-content` |

Each team is a folder with `agents/<name>.ts` (one self-contained file per agent
— its `defineAgent` handle + `body`) and `workflows/<name>.ts`, composed in the
team's `index.ts`. A new team is a sibling folder + a re-export.

## Two ways to consume

- **In-process** — `await team.toMastraAgents({ resolveModel })` returns the
  built agents keyed by id; take the ones you need. `@mastra/core` is a peer
  dependency, so install it in the host.
- **On disk** — `await team.emit(dir)` writes the AGENT.md / WORKFLOW.md
  manifests for a runtime that loads a workspace from disk. No Mastra needed.

## Generic by design

Team ids are `@agentproto/…` and depend on **no** product package (the
architecture invariant: nothing under `@agentproto/*` may import an app's
`@<app>/core`). That's what lets any host — including agentik-studio — import a
team and use its agents/workflows directly.
