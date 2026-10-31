# @agentproto/adapter-mastra-controller

## 0.1.0

### Minor Changes

- da71f8c: `@agentproto/adapter-mastra-controller` now answers the Mastra AgentController's requests. A tool approval, an `ask_user` question and a `submit_plan` plan approval each surface as an AIP-45 `agent-prompt` event, answered through `respondPermission`. An approved plan lets the controller switch to the mode's `transitionsTo`, reported as the existing mode-switch notice; a rejected plan stays in its mode with the feedback. The manifest's `permissions` rules pre-answer matching tools. Without `permissionHold` the client answers in place: tools are allowed, a question gets a "no user" answer, a plan is rejected. Capabilities now claim `tool_calls`. A plan's text is read only from a regular file under the session cwd (symlinks resolved), at most 256 KiB; otherwise the prompt carries "plan not readable: <reason>". A `multi_select` question is answered with a single pick.

  `@agentproto/cli` lists `mastra-controller` in the bundled adapter catalog, and `permissions ls` renders a mastra-controller plan approval's plan text.

  `@agentproto/harness`: the `respondPermission` doc no longer says only the ACP arm implements it.

- 91c1095: New package: scaffold of the AIP-45 proprietary adapter for a Mastra AgentController. Ships the `mastra.agent-controller/v1` manifest schema (zod, with `parseControllerManifest` for frontmatter markdown or plain objects, errors naming the field path) and its generated JSON Schema. The client throws `not implemented yet (E48 PR 2)` until the live controller lands.
- fcefbf3: Run a Mastra AgentController session with its modes. `createAgentCliClient` now reads the manifest named by the new `manifest` option, builds the controller through `createAgentControllerHost({ resolvers, defaults })`, opens a session in the requested mode (`connect({ mode })`, the new `controller_mode` option, else the manifest default) and maps controller events to AIP-45 stream events through `mapMastraEvent`. `cancel()` ends the turn as `cancelled`, `setSessionMode()` switches the controller mode, and a mode switch the controller makes by itself surfaces as a `thought` notice. An unregistered `$resolver` fails with `UnresolvedReferenceError` naming the field path. The handle now claims `streaming`; tool approvals and plan suspensions follow in the next release.
- 0e0fd10: Adopt the AIP-45 `mode-changed` stream event and typed `agent-prompt` requests (agentproto/agentproto #121).

  `@agentproto/acp`: `StreamEvent` gains the `mode-changed` variant (`modeId`, `previousModeId`, `cause: "caller" | "agent"`, `reason?`) and the `agent-prompt` event gains `request?` (`tool-permission | question | plan-approval`, absent reads as `tool-permission`) with the `question` and `planApproval` payloads (new `AgentPromptRequestKind`, `AgentPromptQuestion`, `AgentPromptPlanApproval` types). The ACP client turns a `current_mode_update` into `mode-changed`: `cause: "caller"` when it echoes the caller's own `setSessionMode`, `"agent"` otherwise, with `previousModeId` from the tracked mode. A `setSessionMode` the agent does not echo is reported once it is applied; when the agent reports another mode during the call, that report stands. No-op updates are not reported.

  `@agentproto/harness`: `capabilities` accepts `mode_events` and `typed_prompts` (booleans, the `HARNESS.schema.json` fields), and re-exports the new acp types.

  `@agentproto/adapter-mastra-controller`: a controller mode switch is a `mode-changed` event instead of the `thought` notice (`cause: "agent"`, `reason: "plan approved"` after an approved plan), and the host's own `setSessionMode` is reported with `cause: "caller"`. Prompts carry `request`, with a `question` payload (choices, or free text on the `answer` option) or a `planApproval` payload (plan text, `planRef`, target mode, approve and reject option ids). Declares `mode_events` and `typed_prompts`. Deprecated: the `_meta` keys `mastra-controller/request`, `mastra-controller/plan` and `mastra-controller/transitionsTo` (and the `META_REQUEST`, `META_PLAN`, `META_TRANSITIONS_TO` exports) are kept for one release as aliases of the typed fields.

  `@agentproto/runtime`: the pending-permission inbox (`GET /permissions`, `permissions_list`) and the session transcript carry `request`, `question` and `planApproval` unchanged; `mode-changed` is recorded in the transcript, relayed from sandbox sessions, exported, and shown as a `[mode]` output line.

  `@agentproto/cli`: `permissions ls` renders a plan from the typed `planApproval` first, falling back to the `_meta` aliases.

- 91c1095: New package: scaffold of the AIP-45 proprietary adapter for a Mastra AgentController. Ships the `mastra.agent-controller/v1` manifest schema (zod, with `parseControllerManifest` for frontmatter markdown or plain objects, errors naming the field path) and its generated JSON Schema. The client throws `not implemented yet (E48 PR 2)` until the live controller lands.
- fcefbf3: Run a live Mastra `AgentController` session from a `mastra.agent-controller/v1` manifest. `createAgentCliClient` now accepts a `manifest` option (env `AGENTPROTO_MASTRA_CONTROLLER_MANIFEST`), builds the controller via the new exported `createAgentControllerHost({ resolvers, defaults })`, opens a session in the requested mode (`connect({ mode })`, `controller_mode`, else the manifest default), and maps controller events to AIP-45 stream events. `cancel()` aborts the turn, `setSessionMode()` switches controller modes, controller-initiated switches surface as a `thought` notice, and the handle now claims `streaming`. Tool approvals and plan suspensions follow in E48 PR 3.
- da71f8c: `@agentproto/adapter-mastra-controller` now answers the Mastra AgentController's requests: tool approvals, `ask_user` questions and `submit_plan` plan approvals surface as AIP-45 `agent-prompt` events answered through `respondPermission`. A suspended run keeps its turn open until the answer resumes it, and the manifest's `permissions` rules pre-answer matching tools. Capabilities now claim `tool_calls`.

  `@agentproto/cli` lists `mastra-controller` in the bundled adapter catalog.

### Patch Changes

- b4c753f: `@agentproto/adapter-mastra-controller` now requires `@mastra/core` `>=1.60.0 <2` instead of `>=1.59.0 <2`. On 1.59.0 the approval gate re-runs on a tool resuming from its own `suspend()`: a rejected `submit_plan` loses the user's feedback and a self-suspended tool that is approved never resumes. `createAgentControllerHost()` throws `UnsupportedMastraCoreError` when an older `@mastra/core` is installed.
- Updated dependencies [68c476e]
- Updated dependencies [da71f8c]
- Updated dependencies [0e0fd10]
- Updated dependencies [c350f3a]
- Updated dependencies [c53688d]
- Updated dependencies [f1dab61]
- Updated dependencies [dd134f4]
- Updated dependencies [c350f3a]
- Updated dependencies [30961a9]
- Updated dependencies [dd134f4]
- Updated dependencies [30961a9]
  - @agentproto/harness@3.0.0
