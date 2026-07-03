---
"@agentproto/driver-agent-cli": minor
"@agentproto/cli": minor
"@agentproto/adapter-hermes": patch
"@agentproto/runtime": patch
---

Declare a per-mode support `status` (`active` | `noop` | `planned`) + `status_note`
on the agent-CLI manifest, and surface each adapter's declared modes with that
status through `adapter_list`. This lets an adapter honestly admit that a declared
mode is a measured no-op or not-yet-wired instead of silently accepting it at
spawn. hermes' `lean` mode is marked `noop` with the measured reason
(`--ignore-user-config` composes correctly but saves zero tokens — skills live
outside `config.yaml`). Modes with no explicit status normalise to `active`.
