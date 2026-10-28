---
"@agentproto/adapter-mastra-controller": minor
"@agentproto/cli": patch
---

`@agentproto/adapter-mastra-controller` now answers the Mastra AgentController's requests: tool approvals, `ask_user` questions and `submit_plan` plan approvals surface as AIP-45 `agent-prompt` events answered through `respondPermission`. A suspended run keeps its turn open until the answer resumes it, and the manifest's `permissions` rules pre-answer matching tools. Capabilities now claim `tool_calls`.

`@agentproto/cli` lists `mastra-controller` in the bundled adapter catalog.
