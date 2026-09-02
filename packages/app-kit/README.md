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

An app may also declare `requires: ["@acme/shared", ...]` — app ids that must be
applied to the same scope before this one can run. The runtime validates the
graph when mounting apps via `app_apply`.

## UI surfaces, artifacts, dev-launch, and the artifact surface

Beyond agents and workflows, an app can declare four optional surfaces that
round-trip through `emit` and `loadAppHandle` and are integrated into the
runtime app registry:

- **`ui`** — an HTML dashboard/panel. `html` is written to
  `.agentproto/ui/index.html`; `APP.md` frontmatter carries the relative path
  plus optional `title`, `description`, `tools`, and `csp`.
- **`artifact`** — a persistent HTML dashboard (Cowork artifact). The app
  provides a path to an HTML file on disk; `emit` copies it to
  `.agentproto/artifact/index.html`. The daemon never writes the host manifest
  — it exposes the content via `app_artifact_get`, and the host agent (Cowork)
  calls its own `create_artifact` to register it.
- **`skill`** — a Cowork skill directory. The app provides a path to a
  directory containing `SKILL.md` (AIP-42); `emit` copies the entire directory
  to `.agentproto/skill/`. The daemon exposes the content via `app_skill_get`,
  and the host agent (Cowork) calls `save_skill` to register it. Install-time
- **`artifacts`** — a list of artifact types the app's agents may produce,
  declared for discovery.
- **`dev`** — one or more local launch recipes (`name`, `runtimeExecutable`,
  `runtimeArgs`, `port`, `url`) for running the app in development.
- **`data`** — `{ dir }`, the app's default **data dir** hint, relative to the
  app dir (`"data"` ⇒ `<appDir>/data`, which is also the daemon's default when
  the hint is absent). This is where the `app_data_*` plane reads and writes —
  kept distinct from the source dir so generated output can live elsewhere. It
  is only a hint: `app_install { dataDir }` / `agentproto app install
  --data-dir` override it, and the resolved absolute path is persisted on the
  installed-app record. Reserved for later: a `store.sqlite` inside that dir
  behind an `app_data_query` tool.

An app can also be **UI-only**: omit `agents` (or pass `agents: []`) when the
app is a pure UI panel with no agent behavior of its own. In that case `ui`
becomes required — `defineApp` throws if both `agents` and `ui` are absent,
since an app with neither has nothing to do. A UI-only app still emits a
normal `APP.md` (with `agents: []`) and round-trips through `loadAppHandle`
the same way; `toMastraAgent`/`toMastraAgents` simply have nothing to build.

The three surfaces form the app's public contract:

| Surface   | Type            | Emitted path                    | Daemon tool                     | Host side                     |
|-----------|-----------------|---------------------------------|---------------------------------|-------------------------------|
| `ui`      | MCP App panel   | `.agentproto/ui/index.html`     | `app_ui_<slug>` (MCP tool)      | Renders the panel in-app      |
| `artifact`| Cowork artifact | `.agentproto/artifact/index.html`| `app_artifact_get`              | `create_artifact` (Cowork)    |
| `skill`   | AIP-42 skill     | (future)                        | (future)                        | (future)                      |

### Artifact surface flow

1. The app declares `artifact: { path: "/abs/path/to/dashboard.html", title?, description? }`
   in `defineApp`. `emit` copies the file to `.agentproto/artifact/index.html`.
2. `app_install` reads the `artifact` block from `APP.md` frontmatter, resolves
   the path, and persists it in the app registry.
3. The host agent (Cowork) calls **`app_artifact_get`** with the `appId` — the
   daemon reads the HTML file from disk at call time and returns `{ appId,
   title?, description?, html }`.
4. The host agent then calls its own **`create_artifact`** (host API) with the
   returned HTML, registering the artifact in Claude/Cowork. The daemon never
The four surfaces form the app's public contract:

| Surface    | Type            | Emitted path                        | Daemon tool                     | Host side                     |
|------------|-----------------|-------------------------------------|---------------------------------|-------------------------------|
| `ui`       | MCP App panel   | `.agentproto/ui/index.html`         | `app_ui_<slug>` (MCP tool)      | Renders the panel in-app      |
| `skill`    | Cowork skill    | `.agentproto/skill/` (dir)          | `app_skill_get`                 | `save_skill` (Cowork)         |
| `artifact` | Cowork artifact | `.agentproto/artifact/index.html`   | `app_artifact_get`              | `create_artifact` (Cowork)    |
| `artifacts`| Decl types      | inline in APP.md frontmatter        | —                               | Discovery                     |

### UI bridge API

A `ui` panel runs inside an MCP Apps host (or standalone via `agentproto app
serve`) and receives a `window.McpApp` bridge:

- `callTool(name, args)` — invoke an MCP tool exposed by the host.
- `sendMessage(content)` — push a user message up to the chat host.
- `updateModelContext({ content?, structuredContent? })` — replace the model
  context the host sees for this panel.
- `openLink(url)` — ask the host to open a URL.
- `onTeardown(cb)` — register a cleanup callback fired when the host tears down
  the panel.

In a standalone browser tab, `callTool` proxies to the daemon's `/mcp` endpoint,
while `sendMessage` and `updateModelContext` reject (there is no chat host).

### Skill surface flow

1. The app declares `skill: { path: "/abs/path/to/skill-dir", title?, description? }`
   in `defineApp`. `emit` copies the entire directory to `.agentproto/skill/`.
2. `app_install` reads the `skill` block from `APP.md` frontmatter, resolves
   the path, validates the `SKILL.md` frontmatter (must have `name` and
   `description`), and persists the record.
3. The host agent (Cowork) calls **`app_skill_get`** with the `appId` — the
   daemon reads the skill directory from disk at call time and returns
   `{ appId, name, description, files: [{ path, content }] }`. Binary files
   are skipped with a warning in the response.
4. The host agent then calls its own **`save_skill`** (host API) with the
   writes the host manifest directly.

```ts
export const dashboardApp = defineApp({
  id: "@acme/dashboard",
  name: "Operations Dashboard",
  agents: [/* … */],
  workflows: [/* … */],
  ui: {
    html: "<!doctype html><html>…</html>",
    title: "Ops Dashboard",
    tools: ["terminal_start", "agent_start"],
  },
  artifact: {
    path: "/path/to/dashboard.html",
    title: "Ops Dashboard",
    description: "Live operations dashboard.",
  skill: {
    path: "/path/to/skill-dir",
    title: "Dashboard Skill",
  },
  artifacts: [
    { type: "image/png", description: "Generated cover illustration" },
  ],
  dev: {
    launch: [
      { name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3000 },
    ],
  },
})
```

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
<dir>/.agentproto/ui/index.html                         (only when the app declares a `ui` surface)
<dir>/.agentproto/artifact/index.html                     (only when the app declares an `artifact` surface)
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
(defaults to `"0.1.0"` when `id` is set) / `description`, an optional `requires`
array of app ids it depends on, and, when the app has a home workspace, that
workspace's `id`. When declared, `ui` metadata, `artifacts`, `dev` launch
configs, and the `data: { dir }` data-dir hint are also carried in the
frontmatter (the `ui.html` document is written next to `APP.md` and referenced
by path). Nothing reads `AGENT.md`/`WORKFLOW.md`
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
