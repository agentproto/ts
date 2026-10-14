---
"@agentproto/runtime": minor
"@agentproto/secrets": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-opencode": patch
---

Codex and opencode logins are now file-based: the login JSON stored in the secrets store is copied into the box at boot and re-copied on restart, then refreshed in place with a throttle and a digest gate so an unchanged file is never re-uploaded, and the auth block carries a `loginFile` marker pointing at the copied file instead of embedding a token so no credential lands in the session record — when the secret is missing or unreadable the session degrades fail-loud with an error naming the missing key instead of silently starting an unauthenticated agent.
