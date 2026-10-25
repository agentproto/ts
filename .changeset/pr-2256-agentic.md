---
"@agentproto/cloud-agent": minor
"@agentproto/runtime": patch
---

Extract the AIP-66 managed cloud spawn surface into the new `@agentproto/cloud-agent` package: the vendor registry, pure spawn resolver and refusal shapes, `meta.cloud` identity helpers, relay session-meta side file, `GIT_TOKEN_ENV`, and declared-remote spawn env (now taking the runtime's remote validators through a `CloudRemotePort`). `@agentproto/runtime` depends on the new package and keeps the same behavior at its spawn/restart call sites.
