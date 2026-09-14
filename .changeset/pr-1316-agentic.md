---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Surface the tool-call route's human-readable `message` (not the machine `error` slug) in both UI bridge scripts on non-ok responses, and reword the `daemon_unreachable` advice so it does not assume the target is the local daemon. Exports `STANDALONE_REST_BRIDGE_SCRIPT` from `@agentproto/runtime`.
