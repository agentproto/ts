---
"@agentproto/sandbox-instabox": patch
---

Harden the InstaBox daemon unit by running `agentproto serve` as the unprivileged `user` account (matching `@agentproto/sandbox-box`), remove a dead exit-code check in `readExistingAuthToken`, and add a harness regression test asserting `ConnectHarnessOptions.headers` reach the MCP transport.
