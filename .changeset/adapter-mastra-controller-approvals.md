---
"@agentproto/adapter-mastra-controller": minor
"@agentproto/cli": patch
"@agentproto/harness": patch
---

`@agentproto/adapter-mastra-controller` now answers the Mastra AgentController's requests. A tool approval, an `ask_user` question and a `submit_plan` plan approval each surface as an AIP-45 `agent-prompt` event, answered through `respondPermission`. An approved plan lets the controller switch to the mode's `transitionsTo`, reported as the existing mode-switch notice; a rejected plan stays in its mode with the feedback. The manifest's `permissions` rules pre-answer matching tools. Without `permissionHold` the client answers in place: tools are allowed, a question gets a "no user" answer, a plan is rejected. Capabilities now claim `tool_calls`. A plan's text is read only from a regular file under the session cwd (symlinks resolved), at most 256 KiB; otherwise the prompt carries "plan not readable: <reason>". A `multi_select` question is answered with a single pick.

`@agentproto/cli` lists `mastra-controller` in the bundled adapter catalog, and `permissions ls` renders a mastra-controller plan approval's plan text.

`@agentproto/harness`: the `respondPermission` doc no longer says only the ACP arm implements it.
