---
"@agentproto/adapter-codex": minor
"@agentproto/harness": patch
---

The codex adapter gets two options: `service_tier` (`fast` or `flex`) and `reasoning_effort` (`none` to `xhigh`). They set codex's own `service_tier` and `model_reasoning_effort` config keys through the wrapper's `CODEX_CONFIG`, and set nothing when omitted. `fast` is the lower-latency priority tier: on a decision benchmark it took 3.7 s per decision against 10.8 s on the default tier.

The harness now deep-merges JSON-object env values when two options write the same env key (here `CODEX_CONFIG`), instead of the last option replacing the first.
