---
"@agentproto/runtime": minor
---

App agents now resolve their spawn adapter from AGENT.md metadata or a model route (claude-* → claude-code, opencode/* and opencode-go/* → opencode) and fail with a clear error instead of silently falling back to mastra-agent.

Behavior change: an agent with no `metadata.adapter`/`metadata.harness` and a model outside those routes (for example `openrouter/...` or `gpt-5`) used to run on mastra-agent. It now fails: `app_run` lists it in `errors`, and workflow agent-ref resolution throws for the whole app. Add `metadata: { adapter: mastra-agent }` to its AGENT.md, or pass `adapter` to `app_run`, to keep the previous behavior.

A run where no agent resolved an adapter no longer reports `adapter: "mastra-agent"`; it reports no adapter.
