---
"@agentproto/cli": patch
---

Fix `agentproto sessions list --fields a,b` crashing with `Cannot read properties of undefined (reading 'length')` when rendering a table without `--json`. Projected rows now print as a plain table with exactly the requested columns in the requested order, using `-` for missing values.
