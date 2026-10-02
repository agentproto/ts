---
"@agentproto/adapter-opencode": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": minor
"@agentproto/apps": minor
---

Surface silent provider stream errors as turn errors. `@agentproto/driver-agent-cli` adds a stderr logfmt parser (`parseStderrStreamError`, `_onStderrLine` push subscription) so opencode's silent 429/usage-cap retry loop surfaces as a turn error instead of a hung session, and the opencode adapter spawns with `--print-logs --log-level ERROR`. `@agentproto/runtime` exports `NO_OUTPUT_STALL_TURN_ERROR` (new export ⇒ minor) and attaches it via the stall watchdog for zero-output turns. `@agentproto/apps` (session-steward) gains the `session-steward` skill, a session snapshot script, and APP.md skill wiring.
