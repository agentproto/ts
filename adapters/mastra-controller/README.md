# @agentproto/adapter-mastra-controller

AIP-45 adapter for a Mastra `AgentController` (`@mastra/core/agent-controller`)
built in-process from a `mastra.agent-controller/v1` manifest: modes with
plan to execute transitions, per-mode instructions and tool allowlists,
subagents, Observational Memory defaults, permissions. Implements the
`protocol: "proprietary"` arm contract (no subprocess).

> **Status: E48 PR 3.** Runs a live controller session with its modes
> (stream mapping, spawn-time mode selection, `setSessionMode`, cancel) and
> answers its requests: tool approvals, `ask_user` questions and
> `submit_plan` plan approvals surface as `agent-prompt` events answered
> with `respondPermission`. See MASTRA-CONTROLLER.md.

## Running a session

```ts
import {
  createAgentCliClient,
  createAgentControllerHost,
  mastraController,
} from "@agentproto/adapter-mastra-controller"

const client = createAgentCliClient(mastraController, {
  host: createAgentControllerHost({
    resolvers: { "@guilde/harness/storage/postgres": ref => makeStore(ref.input) },
  }),
})
await client.connect({
  cwd,
  env: { AGENTPROTO_MASTRA_CONTROLLER_MANIFEST: ".harness/research-assistant.md" },
  abortSignal,
  mode: "plan",
})
await client.send("turn-1", "Research the history of tea.")
for await (const evt of client.events()) console.log(evt) // text-delta ... turn-end
```

Through the daemon, the same two inputs are the adapter options `manifest`
and `controller_mode`.

## The manifest

```ts
import { parseControllerManifest } from "@agentproto/adapter-mastra-controller"

// Markdown with YAML frontmatter (the body is ignored) or a plain object.
const manifest = parseControllerManifest(await readFile(".harness/research-assistant.md", "utf8"))
manifest.modes // [{ id: "plan", default: true, transitionsTo: "execute", ... }, { id: "execute", ... }]
```

Invalid input throws `ControllerManifestError`, whose `issues` name the field
path of each problem (`modes.1.default`, `modes.0.transitionsTo`, ...).

The JSON Schema is published at
`@agentproto/adapter-mastra-controller/schema/mastra.agent-controller.v1.schema.json`
and generated from the zod source (`pnpm schema:write`); a test fails when the
committed file drifts. Cross-field rules (one default mode, `transitionsTo`
naming a declared mode, unique ids) are only enforced by the parser.

### Portable vs host-resolved fields

| Portable (plain data) | Host-resolved (`{ $resolver: string, ... }`) |
| --- | --- |
| `id`, `name`, `version`, `description` | `storage`, `memory`, `workspace`, `agent`, `tools` |
| `modes[]`: `id`, `name`, `description`, `default`, `transitionsTo`, `defaultModelId`, `instructions`, `availableTools`, `metadata` | `modes[]`: `agent`, `model`, `tools` |
| `subagents[]`: `id`, `name`, `description`, `instructions`, `defaultModelId`, `maxSteps`, `forked`, `allowedControllerTools`, `allowedWorkspaceTools` | `subagents[]`: `agent`, `model`, `tools` |
| `omConfig`, `models.allowed`, `permissions` | `models.resolver` |

Host references are checked for a `$resolver` string and otherwise kept
untouched; the host resolves them when it builds the controller. Unknown keys
pass through, so a host profile can add its own fields.

## Exports

- `mastraController`: the `defineHarness` handle (slug `mastra-controller`,
  `protocol: "proprietary"`, options `manifest` and `controller_mode`,
  capability `streaming`).
- `createAgentCliClient(definition, { host?, manifest? })`: the proprietary
  arm factory.
- `createAgentControllerHost({ resolvers?, defaults? })`: builds the
  `AgentControllerConfig` / `AgentController` from a manifest;
  `UnresolvedReferenceError`, `ResolvedValueError`.
- `parseControllerManifest`, `ControllerManifestSchema` and the per-part
  schemas, `controllerManifestJsonSchema()`.

## Spec

See [AIP-45](https://agentproto.sh/docs/aip-45) and **MASTRA-CONTROLLER.md**.
