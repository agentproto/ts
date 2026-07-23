---
"@agentproto/runtime": patch
---

`agent_start`: surface a "did you mean" advisory when a spawn names an explicit
`model` slug the local catalog doesn't know but a known id shares its bare
product (a wrong- or missing-vendor/route prefix, e.g. `deepseek-chat` →
`deepseek/deepseek-chat`, `moonshot/kimi-k2` → `moonshotai/kimi-k2`). Turns an
opaque late 404 deep in the provider call into an actionable breadcrumb in the
spawn response `warnings`. Advisory only — never a reject, so genuinely-new and
free-form (hermes OpenRouter) slugs still spawn, in step with the money-safety
guard's never-reject-an-unknown-model rule.
