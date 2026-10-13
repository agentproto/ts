---
"@agentproto/runtime": minor
---

App agents now resolve their spawn adapter from AGENT.md metadata or a model route (claude-* → claude-code, opencode/* and opencode-go/* → opencode) and fail with a clear error instead of silently falling back to mastra-agent.
