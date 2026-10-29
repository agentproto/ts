---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Keep model, billing profile, and context policy when restarting a session.

`@agentproto/cli`: `sessions restart` gains `--model` and `--access-profile` and routes agent restarts through the daemon so spawn fields (model, wallet, policy, lineage) survive.

`@agentproto/runtime`: the restart override accepts and validates a `contextContinuity` policy, merging it with the previous resolved policy and carrying it onto the restarted descriptor.

`agentproto-vscode`: expose `SessionDescriptor.modelPolicy` and add `modelsForAccessProfile`, so an access-profile switch can pick a compatible model and restart with model and account applied atomically.
