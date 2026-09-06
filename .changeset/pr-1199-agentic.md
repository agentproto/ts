---
"@agentproto/runtime": major
---

Add terminal gate security feature that restricts `terminal_start` command execution through the same allowlist that gates `command_execute`. Introduces three-valued gate mode per workspace ("allowlist"/default, "all", or "off"), resolved from workspace config file or global `AGENTPROTO_TERMINAL_GATE` environment variable. Also exports new symbols: `loadTerminalGateMode`, `TerminalGateMode`, `TERMINAL_GATE_ENV`, and `DEFAULT_TERMINAL_GATE`. The `workspace` parameter is now required on `registerSessionTools` (all call sites updated).
