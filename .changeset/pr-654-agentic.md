---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Implement WS6: credential discovery scanner + first-run onboarding flow. Adds `auth_discover_credentials` (read-only scan of local credentials), `auth_profile_import` (materialize discovered credentials into profiles), and onboarding wizard. Two security invariants verified: never returns secret values (sentinel test), never throws on malformed source (per-source warn+skip). All five discovery origins supported (Claude Code, Codex, Gemini, env, hermes-config). New optional `origin` field on AuthProfile stamps the import provenance.
