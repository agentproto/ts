---
"@agentproto/runtime": minor
---

Implement `action:"gate"` for the hooks engine — shell commands that auto-resolve permissions from exit codes. Factors out gate execution into a shared `runShellGate()` function (reused by both turn-end policy gates and hook-engine gates), ensuring identical behavior and reducing duplication. Includes comprehensive test coverage and properly maintains the RISK-0 guard against security-intent rules on Plane-1. New exports: `decideRule()`, `runShellGate()`, `HookGateSpec`, `ShellGateOutcome`.
