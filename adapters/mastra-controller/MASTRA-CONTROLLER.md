---
name: mastra-controller
id: mastra-controller
description: A Mastra AgentController built in-process from a mastra.agent-controller/v1 manifest. Scaffold, no live controller yet.
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
  streaming: false
  tool_calls: false
  sub_agents: false
  file_io: false
  multimodal: false
  resumable: false
  bidirectional: false
tags: ["mastra", "agent-controller", "proprietary", "in-process", "agent-runtime"]
---

# Mastra AgentController adapter

This adapter will drive a Mastra `AgentController`
(`@mastra/core/agent-controller`; `@mastra/core/harness` is its deprecated
alias) in the host's own process. It implements the AIP-45 `protocol:
"proprietary"` arm contract: `createAgentCliRuntime` skips the subprocess
spawn and dynamic-imports this package, calling its exported
`createAgentCliClient(definition)` factory (see `src/client.ts`).

## Status

E48 PR 1 (this release) ships the `mastra.agent-controller/v1` manifest
schema, its parser and its JSON Schema. The client throws
`not implemented yet (E48 PR 2)` on every call that needs a live controller,
the manifest above declares no modes and every capability is `false`. Planned
next:

1. PR 2: session and modes end to end (`agent_start` into the default mode,
   text deltas and turn end through `mapMastraEvent`), modes read from the
   session's manifest.
2. PR 3: suspensions and approvals (`submit_plan` surfaces as an agent
   prompt; approval switches to the mode's `transitionsTo`).

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
