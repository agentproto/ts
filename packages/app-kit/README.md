# @agentproto/app-kit

Declare one or more **agents** (with their system prompts) and the **workflows**
they run in one TypeScript module, then import them anywhere.

A thin umbrella over AIP-42 [`defineAgent`](../agent) + AIP-15
[`defineWorkflow`](../workflow). It doesn't re-validate their fields — those ran
when you built the handles — it validates the *coupling* and gives you two ways
to consume the bundle: runnable Mastra agents, or emitted `.md` manifests.

```ts
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

export const reviewApp = defineApp({
  agents: [
    {
      agent: defineAgent({
        schema: "agent/v1",
        id: "@agentik/reviewer",
        description: "Reviews a PR diff and reports findings.",
        model: "claude-sonnet-5",
        boundaries: ["Never run gh pr merge"],
        workflows: [{ ref: "review-and-fix" }], // ← must match a bundled workflow
      }),
      body: `You are a rigorous PR reviewer. Report findings; change nothing.`,
    },
    // body optional — omit it and the prompt composes from the agent's
    // persona / boundaries / traits.
    { agent: defineAgent({ schema: "agent/v1", id: "fixer", description: "Applies fixes.", model: "claude-sonnet-5", workflows: [{ ref: "review-and-fix" }] }) },
  ],
  workflows: [
    defineWorkflow({
      id: "review-and-fix",
      name: "Review and fix",
      description: "Read the diff, report findings.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
    }),
  ],
  attach: [ /* any AIP handle: AIP-6 company, AIP-25 persona, AIP-47 role, policy… */ ],
  workspace: {                          // ← optional home workspace (AIP-34)
    id: "@acme/reviewers",
    name: "Acme Reviewers",
    owner: { type: "guild", id: "guild_123", slug: "acme" }, // = the tenant
    // storage defaults to { inline: { provider: "local-fs", config: {} } }
  },
})
```

## The tenant + local storage — it's the workspace, not a folder

An app can declare a home **`workspace`** (AIP-34 `WORKSPACE.md`). Reuse it
instead of inventing tenant folders, because AIP-34/35 already model both axes:

- **Tenant** = the workspace's `owner` — `{ type: "guild" | "user" | "org", id, slug }`.
  Not a `tenants/<t>/` path segment; an identity on the manifest.
- **Local storage** = the AIP-35 `storage` block — `provider: "local-fs"` (also
  `dev-local`, `local-ide`, `github`, `mastra-s3`, …). Defaults to `local-fs`.

Pass either a `{ id, name, owner, storage? }` **shorthand** (completed with a
local-fs default + validated by `defineWorkspace`) or a pre-built
[`defineWorkspace`](../workspace) handle. This is the same workspace model Guilde
already uses — a guild's `system` workspace mounted at `/.guilde` holding its
operator / role / skill definitions.

## Where is the system prompt? — it's the `body`

There is **no `systemPrompt` field anywhere in AIP**. An AGENT.md is
*frontmatter (metadata) + body (the prompt)*, and the frontmatter schema is
`.strict()` — so `defineAgent` structurally cannot hold prose. The prompt is the
**body**, and it's optional: omit it and the prompt composes from the agent's
`persona` (AIP-25), `boundaries`, and `traits` — the same way Guilde assembles an
operator's prompt from AIP-47 role instructions + persona rather than a stored
string. `composeInstructions` (in [`@agentproto/mastra`](../mastra)) is the
assembler.

## The attachment invariant

`defineApp` enforces the coupling: agent ids are unique; every `agent.workflows[]`
ref must resolve to a bundled workflow; every bundled workflow must be referenced
by at least one agent. A dangling ref or an orphan workflow throws
`AppDefinitionError`. `attach` carries any other AIP handle verbatim (structural
`{ id }`), so a company, persona, or role rides along without app-kit depending
on each doctype package.

## Consuming a bundle

### `handle.toMastraAgents(resolvers)` — run them

Builds every agent, keyed by id, turning each `body` into a **real Mastra
`instructions` field** via [`@agentproto/mastra`](../mastra). You supply the
resolvers (model, tools, memory…).

```ts
const built = await reviewApp.toMastraAgents({ resolveModel: (ref) => registry.resolve(ref) })
built["@agentik/reviewer"].agent   // a runnable Mastra Agent
```

**Use just some of a team.** Pass `only` to build a subset instead of the whole
app — so a host doesn't pay to build agents it won't run. Unknown ids throw.

```ts
const built = await reviewApp.toMastraAgents({ resolveModel }, ["@agentik/reviewer"])
const [reviewer] = reviewApp.pick(["@agentik/reviewer"]) // select without building
```

`handle.toMastraAgent(resolvers)` is a convenience for single-agent apps (throws
if the app has more than one). `@mastra/core` is a **peer dependency** — install
it in the host if you call either. `emit` has no Mastra dependency.

### `handle.emit(dir)` — ship them

Writes the manifests under an **agentproto-owned base** — it doesn't squat the
shared root `.agents/` convention:

```
<dir>/WORKSPACE.md                                      (AIP-34 root manifest — only when the app has a workspace)
<dir>/.agentproto/APP.md                                (root index — always written)
<dir>/.agentproto/agents/reviewer/AGENT.md
<dir>/.agentproto/agents/fixer/AGENT.md
<dir>/.agentproto/workflows/review-and-fix/WORKFLOW.md   (shared — a workflow may be run by several agents)
```

The daemon's state root is migrating toward a `tenants/<t>/…` segment
(AIP-46 / DESIGN.md §9); app-kit will add that segment once the daemon's tenant
layer lands, rather than inventing the shape ahead of it.

All manifests are plain markdown: frontmatter = the validated handle, body = the
agent's `body` (AGENT.md) / the workflow description (WORKFLOW.md) / the app
description (APP.md). Because a `defineWorkflow` handle is pure data, the
`WORKFLOW.md` needs no `entry:` module — the manifest *is* the workflow, so
`loadWorkflowHandle` returns it directly.

### `APP.md` — the root index, and `loadAppHandle(dir)`

`emit` always writes `<dir>/.agentproto/APP.md`: a `schema: "app/v1"` manifest
whose frontmatter lists every agent + workflow the app bundles as `{ id, path }`
refs (relative to `dir`), plus the app's own optional `id` / `name` / `version`
(defaults to `"0.1.0"` when `id` is set) / `description` and, when the app has a
home workspace, that workspace's `id`. Nothing reads `AGENT.md`/`WORKFLOW.md`
files on their own today — `APP.md` is the thing a future daemon `app_install`
discovers and consumes.

`loadAppHandle(dir)` is the inverse: it reads `APP.md`, loads each referenced
`AGENT.md` / `WORKFLOW.md` (and `WORKSPACE.md`, if declared) with their own
package's loader, and re-runs `defineApp` on the result — so the attachment
invariant re-validates exactly as it did at authoring time.

```ts
import { loadAppHandle } from "@agentproto/app-kit"

const app = await loadAppHandle("/path/to/emitted/app")
app.agents.map((e) => e.agent.id) // ["@agentik/reviewer", "fixer"]
```

## Runtime note

`toMastraAgents` is the path where a `body` becomes a **true** model
`instructions` field, because that wiring lives in the mastra adapter. The
generic daemon session-spawn has no system-prompt field today (instructions ride
in as prepended prompt text for CLI adapters), so an emitted AGENT.md reaches the
model as a real system prompt only through a mastra-family runtime.
