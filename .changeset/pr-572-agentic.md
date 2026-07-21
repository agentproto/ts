---
"@agentproto/cli": minor
---

Add `--allow-unverified` flag to `agentproto install` to opt-in to running unverified curl/download installers. In non-interactive contexts (agents, daemon, CI), unverified installers are refused by default as a supply-chain attack mitigation; the flag explicitly bypasses this gate. Interactive (TTY) users proceed with a warning to preserve dev UX. Implements AIP-29 § Install methods compliance. New `shouldRefuseUnverifiedInstaller` policy function exported and unit-tested.
