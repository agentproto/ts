---
"@agentproto/runtime": patch
---

Sandbox checkpoint and teardown-delivery pushes (work branch, uncommitted-work snapshot, snapshot cleanup) now run with `--no-verify`, so a repo's `pre-push` hook (e.g. a changeset gate) can no longer block the safety-net backup.
