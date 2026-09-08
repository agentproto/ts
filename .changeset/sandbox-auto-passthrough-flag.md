---
"@agentproto/sandbox": minor
---

feat: `SandboxSpec.env.autoPassthrough` (opt-in, default strictly absent). Declared on the spec and the zod schema; the runtime injects the resolved billing-credential env-var NAME into `env.passthrough` when set. Values never flow through the flag.
