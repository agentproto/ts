---
"@agentproto/cloud-agent": minor
"@agentproto/runtime": patch
---

Extract the AIP-66 managed cloud spawn surface into the new `@agentproto/cloud-agent` package. The vendor registry, pure spawn resolver and refusal shapes, `meta.cloud` identity helpers, relay session-meta side file and declared-remote spawn env now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
