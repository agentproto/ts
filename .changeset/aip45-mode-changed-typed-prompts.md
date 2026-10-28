---
"@agentproto/acp": minor
"@agentproto/harness": minor
"@agentproto/adapter-mastra-controller": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Adopt the AIP-45 `mode-changed` stream event and typed `agent-prompt` requests (agentproto/agentproto #121).

`@agentproto/acp`: `StreamEvent` gains the `mode-changed` variant (`modeId`, `previousModeId`, `cause: "caller" | "agent"`, `reason?`) and the `agent-prompt` event gains `request?` (`tool-permission | question | plan-approval`, absent reads as `tool-permission`) with the `question` and `planApproval` payloads (new `AgentPromptRequestKind`, `AgentPromptQuestion`, `AgentPromptPlanApproval` types). The ACP client turns a `current_mode_update` into `mode-changed`: `cause: "caller"` when it echoes the caller's own `setSessionMode`, `"agent"` otherwise, with `previousModeId` from the tracked mode. A `setSessionMode` the agent does not echo is reported once it is applied. No-op updates are not reported.

`@agentproto/harness`: `capabilities` accepts `mode_events` and `typed_prompts` (booleans, the `HARNESS.schema.json` fields), and re-exports the new acp types.

`@agentproto/adapter-mastra-controller`: a controller mode switch is a `mode-changed` event instead of the `thought` notice (`cause: "agent"`, `reason: "plan approved"` after an approved plan), and the host's own `setSessionMode` is reported with `cause: "caller"`. Prompts carry `request`, with a `question` payload (choices, or free text on the `answer` option) or a `planApproval` payload (plan text, `planRef`, target mode, approve and reject option ids). Declares `mode_events` and `typed_prompts`. Deprecated: the `_meta` keys `mastra-controller/request`, `mastra-controller/plan` and `mastra-controller/transitionsTo` (and the `META_REQUEST`, `META_PLAN`, `META_TRANSITIONS_TO` exports) are kept for one release as aliases of the typed fields.

`@agentproto/runtime`: the pending-permission inbox (`GET /permissions`, `permissions_list`) and the session transcript carry `request`, `question` and `planApproval` unchanged; `mode-changed` is recorded in the transcript, relayed from sandbox sessions, exported, and shown as a `[mode]` output line.

`@agentproto/cli`: `permissions ls` renders a plan from the typed `planApproval` first, falling back to the `_meta` aliases.
