---
"@agentproto/apps": patch
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentpush": patch
---

Documentation sync for already-shipped features. The CLI references now document the `capabilities.deferredToolDiscovery` gate on the daemon self-mount (a harness that cannot call a tool omitted from its last `tools/list` gets an eager `?deferred=0` mount), the `sandbox_checkpoint_gc` plan/apply steps in the `maintain` workflow (with `safe`/`keep`/`unknown` classification and `--apply-merged` gating), and the corrected conditional requirement for `transmit_message.sessionId` (required with the default `bind: true`, optional with `bind: false`). No runtime behavior changes.
