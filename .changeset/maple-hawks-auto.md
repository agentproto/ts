---
"@agentproto/auth": major
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

rename auth 'vendor' axis to 'endpoint' in profiles and manifests. The v1
`~/.agentproto/auth-profiles.json` disk format deliberately keeps `vendor` for
backward compatibility; the public TypeScript API exposes only `endpoint`.
