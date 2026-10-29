---
"@agentproto/runtime": minor
---

Refuse a tool call at dispatch when the calling session's AGENT manifest denies it. A session spawned from an AGENT.md with a `tools` deny item (`{kind: mcp, server, deny: [...]}`) now records the matching AIP-38 `tool:invoke` deny grants on its descriptor (`toolDenyGrants`, additive and optional, carried across restart and continue-fresh). The `/mcp` server factory (`agentproto/<name>`) and the imported-call guard (`<server>/<name>`) evaluate them with `decide("tool.invoke")` composed as default allow, so only an explicit deny refuses, with a typed error naming the tool and the refusing grant. A session with no grants, and a host call with no caller session, are not evaluated and behave as before. Adds the `@agentproto/operator` dependency for the deny-grant helper.
