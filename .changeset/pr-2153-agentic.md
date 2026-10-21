---
"@agentproto/adapter-claude-code-cloud": minor
"@agentproto/runtime": minor
---

Cloud sessions can run on a workspace's declared remote instead of requiring a local clean clone. The runtime passes the remote URL, branch and an isolated checkout dir (plus a keychain-resolved git token when a `credentialRef` is set) to the relay; the adapter materializes a clean `origin/<branch>` checkout and validates it under AIP-66 §3 before running the vendor CLI.
