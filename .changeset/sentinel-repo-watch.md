---
"@agentproto/runtime": minor
---

feat(sentinel): `local-gh` can watch a whole repository. A sentinel on the bare subject `github:owner/repo` (`until: never`, e.g. `POST /sentinels {subject, sessionId, provider:"local-gh", until:"never"}` or `sentinel_watch`) delivers, for EVERY PR of the repo and without any LLM polling: `pull_request.opened`, `pull_request.ready_for_review`, one CI verdict per head (`check_suite.completed`, on the first failure or once all checks settle), reviews, and merge/close. One GraphQL call per repo per tick; the first poll only records existing PRs. This gives a supervisor session a second subscription on PRs whose author session is the only target of the per-PR auto-watch.
