---
"@agentproto/adapter-opencode": minor
"@agentproto/auth": minor
"@agentproto/cli": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
---

opencode console workspaces (orgs) are now distinct, truthful wallets. opencode merges the active console org's provider block over every other config on start, so each spawn billed the active org whatever auth profile it named. A new source-backed api-key profile (`source: "opencode-console:<orgId>"`, no stored token) reads the console session read-only from `opencode.db`, fetches that org's provider block and injects the bearer plus block into the spawn; the new driver field `credentialDataHome` (opencode: `XDG_DATA_HOME`) runs an engaged-credential spawn in a login-less data dir, which also makes a plain api-key profile really bill its own key. An expired console session fails loud (never refreshed: the refresh token rotates). `agentproto auth profile opencode-orgs [--create] [--prefix <p>]` lists the console orgs and creates one profile per org. A `Go usage limit exceeded` failure (error event, session output, turn error) now names the wallet profile that hit it. Session usage and transcripts are read from the isolated opencode db when it exists.
