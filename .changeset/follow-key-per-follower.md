---
"@agentproto/runtime": patch
---

session_follow: a follow `key` is now scoped to its follower. Two sessions reusing the same key no longer overwrite each other's follow; `session_unfollow` by key only touches the caller's own follow (`DELETE /follows/:key?follower=` for HTTP).
