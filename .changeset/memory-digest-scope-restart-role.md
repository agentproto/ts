---
"@agentproto/runtime": patch
"@agentproto/memory": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-pi": patch
---

AIP-72 memory follow-ups. The spawn digest now follows section 9 resolution step 3: an adapter whose `capabilities.memory.inject` is `none`, or that declares no memory capability, gets no digest; only `system-prompt` (with a usable channel) and the `native-dir` fallback carry it. codex, hermes, opencode and pi, which have a system-prompt channel, now declare `memory: { inject: "system-prompt", capture: "none" }` so they keep the digest. `session_restart` now carries the spawn role (`meta.role`), so the memory commit gate gives the same answer before and after a restart. `@agentproto/memory` documents the unfilled `tags` default in `validateMemory` and scopes the `renderMemory` status-rewrite note to files it wrote.
