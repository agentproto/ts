---
"@agentproto/git-cas": minor
---

New package `@agentproto/git-cas`: a compare-and-swap `git push` that updates `refs/heads/<branch>` only while the remote still equals the expected SHA (or is absent), using `--force-with-lease=<ref>:<sha>` behind an ancestry precheck. Returns a typed outcome (`pushed`, `noop`, `head_moved`, `rejected_other` with a reason), prints one redacted `git_cas_push` JSON log line, never retries or rebases. Ships pure `buildCasPushArgv` / `buildCasPushCommand` / `classifyPush` helpers and an `agentproto-git-cas push` CLI (exit 0 pushed/noop, 3 head_moved, 4 rejected_other).
