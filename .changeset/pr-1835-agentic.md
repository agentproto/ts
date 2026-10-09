---
"@agentproto/adapter-opencode": minor
"@agentproto/auth": minor
"@agentproto/cli": minor
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": major
---

Generalize opencode console workspaces into provider-agnostic sub-accounts: a `SubaccountProvider` registry in `@agentproto/auth`, the opencode console provider moved into `@agentproto/adapter-opencode`, new `agentproto auth subaccounts` verb and `--subaccount` flag in the CLI, and `isolateDataHome: false` support in `@agentproto/driver-agent-cli`. `@agentproto/runtime` removes its `./opencode-console-source` export (breaking).
