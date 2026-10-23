---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add AIP-46 session presets: `tags`, `extends`, `defaultFor`, `modelPolicy` and
an optional nested `config` on the user preset store; one pure session-config
resolver used by the spawn path and exposed as `agentproto preset resolve` /
`user_preset_resolve`; preset model policies compose with the request's.
