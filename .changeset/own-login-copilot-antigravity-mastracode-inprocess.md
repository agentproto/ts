---
"@agentproto/adapter-antigravity": minor
"@agentproto/adapter-copilot-cli": minor
"@agentproto/adapter-mastracode-inprocess": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
"@agentproto/secrets": minor
---

copilot-cli (GitHub login), antigravity (Google Sign-In) and mastracode-inprocess (Claude + ChatGPT logins, same pair as mastracode) now declare their CLI's own login as an `authSubscription` (`external: true`: no bearer injected), so they count as usable on the user's subscription login. `@agentproto/secrets` adds a `mastracode-inprocess` provision recipe that shares mastracode's login sources. The runtime's external-login check now returns without verifying when the adapter has no provision recipe (the CLI owns that login and fails loud itself) instead of failing with a misleading "no login found". The `--auth` help of `sessions start`, the `agent_start` `auth` description and the sessions docs no longer say the option is claude-code only.
