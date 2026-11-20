---
name: antigravity
id: antigravity
description: Google Antigravity's CLI (`agy acp`) as an AIP-44 ACP agent.
version: 0.2.0
bin: agy
bin_args: ["acp"]
install:
  - method: curl
    url: https://antigravity.google/cli/install.sh
version_check:
  cmd: agy --version
  parse: '(\d+\.\d+\.\d+)'
  range: ">=1.5.13"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
sandbox: ./SANDBOX.md
protocol: acp
acp: ./antigravity-acp.ACP.md
session:
  mode: "persistent"
  idle_timeout_ms: 1800000
  context_carryover: true
tags: ["antigravity", "agy", "google", "acp", "agent-runtime", "coding"]
---

# Google Antigravity adapter

Wraps Google Antigravity's CLI, `agy`, over its first-party Agent Client
Protocol server:

```sh
agy acp
```

Wire profile: [`antigravity-acp.ACP.md`](./antigravity-acp.ACP.md). Login is a
one-time interactive Google sign-in, see [`SECRETS.md`](./SECRETS.md).
