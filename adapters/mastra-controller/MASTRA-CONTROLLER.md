---
name: mastra-controller
id: mastra-controller
description: A Mastra AgentController built in-process from a mastra.agent-controller/v1 manifest, with its modes.
version: 0.0.0
bin: in-process
install:
  - method: npm
    package: "@agentproto/adapter-mastra-controller"
version_check:
  cmd: npm view @mastra/core version
  parse: '(\d+\.\d+\.\d+)'
  range: ">=1.59.0 <2"
  timeout_ms: 15000
sandbox:
  model: in-process
  note: >-
    Runs inside the host process, no subprocess boundary. Tool access will be
    whatever the manifest's permissions and the host's resolved tools grant,
    with the host process's OS permissions.
protocol: proprietary
adapter: "@agentproto/adapter-mastra-controller"
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: false
  multimodal: false
  resumable: false
  bidirectional: false
options:
  - id: manifest
    type: string
    description: Path to the mastra.agent-controller/v1 manifest, absolute or relative to the session cwd. Required.
    env:
      AGENTPROTO_MASTRA_CONTROLLER_MANIFEST: "{value}"
  - id: controller_mode
    type: string
    description: Controller mode to enter at spawn, one of the manifest's modes[].id. Default is the manifest's default mode.
    env:
      AGENTPROTO_MASTRA_CONTROLLER_MODE: "{value}"
tags: ["mastra", "agent-controller", "proprietary", "in-process", "agent-runtime"]
---

# Mastra AgentController adapter

This adapter drives a Mastra `AgentController`
(`@mastra/core/agent-controller`; `@mastra/core/harness` is its deprecated
alias) in the host's own process. It implements the AIP-45 `protocol:
"proprietary"` arm contract: `createAgentCliRuntime` skips the subprocess
spawn and dynamic-imports this package, calling its exported
`createAgentCliClient(definition)` factory (see `src/client.ts`).

## Status

E48 PR 2 (this release): a live session with modes.

- `connect()` reads the manifest named by the `manifest` option, builds the
  controller through `createAgentControllerHost({ resolvers, defaults })`,
  `init()`s it and opens one session in the requested mode: `connect({ mode })`,
  else the `controller_mode` option, else the manifest's default mode.
  Manifest `permissions` are applied to the session.
- `send()` / `events()` run one turn with `session.sendMessage` and map the
  controller events through `mapMastraEvent` (`@agentproto/harness`): text
  deltas, tool calls and results, usage, errors, turn end.
- `cancel()` aborts the turn (`turn-end` reason `cancelled`); `close()`
  destroys the controller.
- Modes: the manifest's modes are the session's `availableModes`,
  `currentModeId` follows the controller, and `setSessionMode()` calls
  `session.mode.switch`. They are not static AIP-45 `modes` (those are
  context modes composed at spawn).
- AIP-45 has no mode-change stream event. A switch the controller makes by
  itself (a mode's `transitionsTo` after an approved plan) is emitted as a
  `thought` notice (`[mastra-controller] mode switched by the controller:
  plan -> execute`) and moves `currentModeId`.

- Requests. Controller suspensions become `agent-prompt` events, answered
  with `respondPermission(requestId, resolution)` (`requestId` is the
  prompt's `toolCallId`). The prompt's `_meta["mastra-controller/request"]`
  says which kind it is:
  - `tool-approval` (`tool_approval_required`): options `approve`
    (allow_once), `always_allow` (allow_always) and `decline`
    (reject_once). `always_allow` grants that tool for the rest of the
    session and approves; the controller's own `always_allow_category`
    needs a `toolCategoryResolver` a manifest cannot declare, so it is not
    offered. A resolution's `feedback` on `decline` becomes the decline
    reason.
  - `question` (`ask_user` suspended): the prompt's `text` is the question,
    with one `answer:<i>` option per choice (the answer is that choice's
    label), or a single `answer` option whose free text is the resolution's
    `feedback`, plus `decline`.
  - `plan-approval` (`submit_plan` suspended): `approve` / `reject`. The
    prompt carries the plan path in `rawInput`, the plan file's text under
    `_meta["mastra-controller/plan"]` and the target mode under
    `_meta["mastra-controller/transitionsTo"]`. On approve the controller
    switches to the mode's `transitionsTo` (the `thought` notice above) and
    the run continues there; on reject it stays in the current mode and the
    model receives the resolution's `feedback` as its revision note.
  - `suspension` (any other tool's `suspend()`): `approve` / `decline`,
    resumed with `{ approved, feedback? }`.

  A run parked on a suspension keeps its turn open until the answer
  resumes it; `cancel()` on a parked turn drops the suspension and ends the
  turn `cancelled`.
- The manifest's `permissions` rules are set on the session at connect, so
  the controller allows or denies a matching tool by itself, without a
  prompt. `ask_user` and `submit_plan` default to `allow` there (their
  suspension is the prompt) unless the manifest names them.
- Prompts are raised only when the host connects with `permissionHold`
  (the daemon's permission inbox). Without it nothing would answer, so the
  client answers in place, like the ACP arm's auto-allow default: tools are
  approved, other suspensions continue, a question gets a "no user is
  attached" answer and a plan is rejected (an unattended session never
  leaves its mode), each answer noted as a `thought`.

Capabilities claim `streaming` and `tool_calls`.

AIP-45 has no plan-approval contract: a plan approval rides on the generic
`agent-prompt` / `respondPermission` pair, told apart only by `_meta`, and a
controller-driven mode switch has no stream event of its own. Both are
candidates for a later AIP-45 note (E48 PR 5).

## Host resolution and defaults

`createAgentControllerHost({ resolvers })` maps each `$resolver` name to a
`(ref, ctx) => value` function; `ctx.path` is the field being resolved. A
reference with no registered resolver fails with `UnresolvedReferenceError`
naming that path. `storage`, `memory`, `workspace`, `agent`, `tools` and
`modes[].agent` / `modes[].tools` / `subagents[].tools` land on the config
field of the same name; `modes[].model` and `subagents[].model` must resolve
to a model id string (it becomes `defaultModelId`); `models.resolver` must
resolve to a `(modelId) => model` function used by the inline backing agent.
`subagents[].agent` has no controller counterpart and is rejected.

Defaults: storage is `InMemoryStore` from `@mastra/core/storage` (core ships
no libsql store, that lives in `@mastra/libsql`, so threads last as long as
the controller); the backing agent is built inline from the manifest (its
model is the session's current model id, the mode's `defaultModelId` on
entry); no memory. `models.allowed` has no controller field and is not used
yet.

## Why a new adapter

- Not `@agentproto/adapter-mastra-agent`: that is an ACP bridge with no
  notion of controller modes.
- Not `@agentproto/adapter-mastracode-inprocess`: that drives Mastra Code, a
  fixed preset of one controller. This adapter builds whatever controller a
  manifest declares.
- `@mastra/core` is a `peerDependency` (`>=1.59.0 <2`) so the host and this
  adapter share one `AgentController` class identity.

## Why `mastra.agent-controller/v1` and not `harness/v1`

`harness/v1` names AIP-45's own AGENT-CLI document. This manifest describes
one Mastra controller, a vendor-specific runtime, so it gets a
vendor-namespaced id. The parser still accepts `spec: harness/v1` so the
manifests agentik-studio already ships parse unchanged.

## Portable vs host-resolved

Portable fields (`id`, `name`, `version`, `modes[]` data, `subagents[]`
data, `omConfig`, `models.allowed`, `permissions`) map 1:1 onto
`AgentControllerConfig`, `AgentControllerMode` and `AgentControllerSubagent`.
Fields naming a live object (storage, backing agent, memory, workspace, tool
bundles, model resolver) are opaque `{ $resolver: string, ... }` references a
host resolves when it builds the controller. The full list is in
`src/manifest.ts` and the README.
