---
"@agentproto/adapter-mastra-controller": patch
---

`@agentproto/adapter-mastra-controller` now requires `@mastra/core` `>=1.60.0 <2` instead of `>=1.59.0 <2`. On 1.59.0 the approval gate re-runs on a tool resuming from its own `suspend()`: a rejected `submit_plan` loses the user's feedback and a self-suspended tool that is approved never resumes. `createAgentControllerHost()` throws `UnsupportedMastraCoreError` when an older `@mastra/core` is installed.
