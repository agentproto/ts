---
"@agentproto/runtime": minor
---

feat: opt-in `env.autoPassthrough` on sandbox specs. When the flag is set and the spawn's host-side billing-credential resolution produced a credential, the credential's env-var NAME (its `setEnv`, e.g. `ANTHROPIC_API_KEY`) is injected into `spec.env.passthrough` before the sandbox box boots, so a fresh box inherits host auth without the caller naming vars. Only the name is injected — the value travels via the existing passthrough mechanism (host secrets broker → box env) and is never read, logged, or echoed by the flag. Billing credential only; explicit `env.passthrough` entries are unioned (deduped, caller entries kept). When no credential resolved — or the host process cannot resolve the var — nothing is injected and the spawn proceeds unchanged.
