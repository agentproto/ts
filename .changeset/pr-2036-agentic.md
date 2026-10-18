---
"@agentproto/model-catalog": minor
"@agentproto/adapter-jcode": minor
"@agentproto/adapter-mastracode": minor
"@agentproto/adapter-mastracode-inprocess": minor
"@agentproto/adapter-opencode": minor
"@agentproto/adapter-pi": minor
---

Introduce `DEFAULT_ANTHROPIC_MODEL` (`claude-sonnet-5-5`) in `@agentproto/model-catalog` as the single source of truth for the platform-wide Anthropic default, and repoint the jcode, mastracode, mastracode-inprocess, opencode, and pi adapter manifests' `models.default` (and, where present, the default menu entry) at it. `adapter-mastracode-inprocess` additionally declares its new `@agentproto/model-catalog` workspace dependency.
