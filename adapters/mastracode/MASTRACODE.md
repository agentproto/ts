---
name: mastracode
id: mastracode
description: Mastra Code terminal coding agent via its documented headless CLI.
version: 0.1.0
bin: npx
bin_args: ["-y", "mastracode"]
install:
  - method: npm
    package: mastracode
    global: true
version_check:
  cmd: npm view mastracode version
  parse: '(\d+\.\d+\.\d+)'
  range: ">=0.26.0"
  timeout_ms: 15000
sandbox: ./SANDBOX.md
protocol: print
tags: ["mastracode", "mastra", "print", "agent-runtime", "coding"]
---

# Mastra Code adapter

This adapter wraps Mastra Code as an AIP-45 agent CLI using the currently
documented headless command surface:

```sh
npx -y mastracode --prompt "Fix the bug" --output jsonl
```

As of 2026-06-30, `mastracode acp --help` prints the top-level CLI help rather
than ACP-specific usage, so this adapter is intentionally not marked as ACP.
