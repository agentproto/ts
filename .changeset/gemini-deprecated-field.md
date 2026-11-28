---
"@agentproto/harness": minor
"@agentproto/adapter-gemini": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Harness manifests gain an optional `deprecated: { replacedBy, message }` field. A spawn of a deprecated harness still runs and returns a warning naming the replacement. The `gemini` harness declares it, pointing to `antigravity`: only the Gemini CLI harness is deprecated, and Gemini models stay available through antigravity.
