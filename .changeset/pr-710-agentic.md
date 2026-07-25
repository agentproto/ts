---
"@agentproto/adapter-gemini": minor
"@agentproto/adapter-hermes": minor
"@agentproto/adapter-mastracode": minor
"@agentproto/adapter-mastracode-inprocess": minor
"@agentproto/cli": minor
"@agentproto/provider-kit": minor
"@agentproto/runtime": minor
---

Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.
