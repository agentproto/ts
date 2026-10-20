---
"@agentproto/runtime": minor
---

Adds authorship-aware PR provenance: the footer renders one "Authored by" entry per session that worked on the branch (adapter, wallet, model, provider and per-session cost) alongside "Opened by", and adds the daemon-side `pr_open` tool that runs `gh pr create` on the host for a box session's pushed work branch.
