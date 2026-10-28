---
"@agentproto/cli": patch
---

Fix `agentproto sessions list --fields a,b` crashing with `Cannot read properties of undefined (reading 'length')` when printing a table. Projected rows now render as a plain table with exactly the requested columns, in the requested order (`-` for missing values).
