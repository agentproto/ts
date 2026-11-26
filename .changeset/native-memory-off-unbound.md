---
"@agentproto/harness": minor
"@agentproto/runtime": minor
---

Add `memory.harnessAutoMemory` (`keep` by default, `off` opt-in). With `off`, a claude-code session that binds no AIP-72 memory gets `autoMemoryEnabled: false` in its isolated settings, so a lesson the harness would file in a private dir that dies with the session goes through the shared `memory_write` tool instead. Sessions with a native-dir projection are unchanged. Applied at spawn and at restart.
