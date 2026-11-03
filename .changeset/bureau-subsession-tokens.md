---
"@agentproto/runtime": minor
---

Mint AIP-59 section 8 sub-session tokens for imported MCP servers that opt in. An import can now declare `subsession: "aip-59"` (http only); when a session calls one of its tools, the daemon mints a per-session token with the device credential the import already carries and sends it as `Agentproto-Subsession`, instead of the spoofable `x-agentproto-caller-session` header (review B2). Tokens are cached per (alias, session) and re-minted within 60 s of expiry, concurrent callers share one in-flight mint, a mint failure refuses the call rather than falling back to a device-level call, and every token is revoked when its session exits. The session descriptor records the server's recordings LINK (`browserRecordings.url`) when a token is minted (AIP-63 M7). Inert until an import sets `subsession: "aip-59"`.
