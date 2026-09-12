---
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-hermes": patch
"@agentproto/sandbox-box": patch
"@agentproto/sandbox-e2b": patch
---

Test-only: replace presence-only env gates for live e2e suites (moonshot, hermes bin, Box, e2b/OpenRouter) with runtime preflight credential/capability probes that skip loudly on definitively dead credentials and run honestly on ambiguity.
