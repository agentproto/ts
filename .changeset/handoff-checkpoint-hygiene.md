---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Handoff and checkpoint fixes from the cold-run review. `sessions handoff --dry-run` stays read-only but now says its content is an approximate extraction (`approximate` and `approximateNote` in the response) because the real handoff interrogates the source session. The handoff question, the source session's JSON reply to it, and the daemon-composed role/AGENTS.md preamble are tagged in the transcript export (`internal`) and left out of `recentDigest`, the fallback `nextStep` and the resume prompt. `nextAction: "compact_then_continue"` is now only suggested inside the compact band (`compactAtPct` up to `continueFreshAtPct`), not at low context. The 401 `sessions_unauthorized` message names `<workspace>/.agentproto/runtime.json` as the token source and how to send it, and the CLI's fallback 401 explanation no longer says it cannot tell where the token came from.
