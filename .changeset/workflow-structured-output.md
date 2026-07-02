---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
---

AgentStep gains an optional `outputSchema` (zod): the workflow interpreter validates
a session's final message against it and re-prompts on mismatch (default 2 retries),
binding the parsed object as the step output. Hosts expose `readFinalMessage` to
supply the text.