---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Sandbox ledger + navigation. The daemon now persists one row per sandbox box to `~/.agentproto/sandboxes.json` (booted / connected / paused / stopped, with label, origin session, and idle-expiry when known), written best-effort at every lifecycle point — a ledger failure never affects a spawn or teardown. New CLI: `agentproto sandbox list [--json]`, `agentproto sandbox rm <id|label> [--box] [--yes]` (entry removal by default, `--box` destructively stops the sandbox on its provider), and `agent_start.sandbox.reuse` now accepts an exact ledger label or a unique sandboxId prefix instead of only a full sandboxId.
