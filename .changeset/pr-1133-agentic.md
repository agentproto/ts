---
"@agentproto/acp": minor
"@agentproto/adapter-mastra-agent": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

feat(permissions): thread plan _meta through the hold path and add free-text feedback on the respond path

Adds `feedback?: string` to permission resolutions, enabling users to attach contextual information when approving or denying held tool-permission requests. The feature threads through all layers: types export `ACP_META_FEEDBACK` constant for the `_meta` key convention, ACP client carries `_meta` through to agent-prompt events, runtime forwards feedback on outcomes, and mastra-agent adapter folds feedback into suspension resumeData. CLI gains `--feedback` flag on approve/deny commands and renders plan text from suspension payloads. All changes are backward compatible.
