---
"@agentproto/adapter-mastra-controller": minor
"@agentproto/cli": patch
---

`@agentproto/adapter-mastra-controller` now answers the Mastra AgentController's requests. A tool approval, an `ask_user` question and a `submit_plan` plan approval each surface as an AIP-45 `agent-prompt` event, answered through `respondPermission`. An approved plan lets the controller switch to the mode's `transitionsTo`, reported as the existing mode-switch notice; a rejected plan stays in its mode with the feedback. The manifest's `permissions` rules pre-answer matching tools. Without `permissionHold` the client answers in place: tools are allowed, a question gets a "no user" answer, a plan is rejected. Capabilities now claim `tool_calls`.

`@agentproto/cli` lists `mastra-controller` in the bundled adapter catalog.
