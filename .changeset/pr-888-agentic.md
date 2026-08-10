---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

**Support shell-based package managers (uv, pip, brew, cargo, go, pipx)** — expand adapter installation beyond npm to handle package managers commonly used in AI/ML workflows. New `parseShellHint` function parses and validates non-npm install commands; only recognized package managers are executed to prevent blind shell injection.

**ACP adapters can now use `uv tool install`, `pip install`, etc.** — planner detects hint type (npm → shell → unsupported) and adapter install routes handle shell commands with the same safety/timeout guards as npm-global installs.
