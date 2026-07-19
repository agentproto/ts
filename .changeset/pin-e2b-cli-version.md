---
"@agentproto/sandbox-e2b": patch
---

Pin the boot-time `@agentproto/cli` install to a configurable `cliVersion` (defaulting to `@latest`) instead of a hardcoded `@agentproto/cli@latest`, so a broken `@latest` npm publish can no longer silently kill the sandbox on boot.
