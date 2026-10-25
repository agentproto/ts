---
"@agentproto/runtime": patch
---

Autocompact now recognises the slash command a harness actually advertises in `available-commands` (`/compact`, or `/compress` on hermes) rather than requiring an unadvertised `compact` session mode, so sessions on real ACP adapters compact at the absolute token threshold again. This is already covered by `.changeset/autocompact-advertised-compact-command.md` on the branch; this entry mirrors the same patch bump for the workflow handoff.
