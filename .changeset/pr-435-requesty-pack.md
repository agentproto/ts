---
"@agentproto/llm-endpoint": minor
---

Route the `requesty` provider through the LLM endpoint proxy and ship a
committed, provider-transparent `requesty` pack.

Requesty exposes a native Anthropic surface (at `/v1/messages`, not the
`/anthropic/v1/messages` its docs claim), so — like OpenRouter — it passes
through with no request/response shape conversion. It also shares OpenRouter's
empty-`signature` thinking blocks, which the `claude` CLI rejects, so it joins
the same proxy-side strip.

The committed pack stays provider-transparent (no Claude aliases), per the
existing rule that public packs never pretend to be real Claude models; a test
pins that. Claude-name compatibility belongs in a gitignored `packs.local.json`,
which is also the only place the alias path fires.

README documents the proven CLI recipe: select a local pack by
`ANTHROPIC_CUSTOM_HEADERS: X-Proxy-Pack`, never by URL path — the claude binary
appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so a `…/v1/<pack>` base becomes
`/v1/<pack>/v1/messages`, matches no pack route, and 400s with a misleading
"Unable to resolve model".
