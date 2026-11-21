---
"@agentproto/billing": minor
"@agentproto/voice-assemblyai": minor
---

Publish `@agentproto/billing` and `@agentproto/voice-assemblyai` to npm at 0.1.0: drop `"private": true` and add the standard `publishConfig.access: "public"` that every published `@agentproto/*` package carries. (`@agentproto/voice` was already made publishable in #2806.) Both ship their built `dist/` (`files: dist, README.md, LICENSE`), and their workspace dependencies (`@agentproto/provider-kit`, `@agentproto/doctype`, `@agentproto/product`, `@agentproto/wallet`) are already on npm, so `workspace:*` resolves at publish. First release for the two names; changesets bump `0.0.0` → `0.1.0` (minor).
