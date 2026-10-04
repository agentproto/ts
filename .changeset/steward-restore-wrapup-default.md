---
"@agentproto/cli": patch
"@agentproto/apps": patch
---

`agentproto steward` goes back to the end-of-session wrap-up as its default:
judge idle agent sessions, then close or flag them (dry run unless `--apply`).
The attention-digest workflow (`session-attention`) and its `--wrapup` /
`--include-children` / `--format` flags are removed from the open-source
steward; the open-source steward keeps the minimal idle / done / errored policy
with explicit close.
