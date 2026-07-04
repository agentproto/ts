---
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-mastracode-inprocess": patch
"@agentproto/adapter-mastra-agent": patch
---

Stop advertising Anthropic models in these adapters' `models.allowed` menus.

Follow-up to the hermes deny (#198). These adapters listed Anthropic models (Opus/extra Sonnet/gateway dupes) as pickable escalations, so an orchestrator could select premium Anthropic here. This trims the advertised menu — no hard deny, no default change, no env change. Each adapter keeps its own default (opencode/mastracode/mastracode-inprocess still default to Claude Sonnet — they're Claude coding agents), and the free-form `model` option still accepts any id; Anthropic simply isn't offered on the menu. `mastra-agent` (glm default) drops its Opus/Sonnet escalations entirely.
