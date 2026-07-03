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

## No `lean` mode (yet)

Investigated declaring a `lean` mode (drop skill/memory/subagent scaffolding
to cut input-token overhead) but found no lever that actually reaches this
adapter's headless invocation:

- The headless CLI (`--prompt ...`, what `protocol: print` drives here) has
  no flag for it — `mastracode --help` lists only
  `--continue/--thread/--title/--clone-thread/--resource-id/--timeout/
  --max-turns/--permission-mode/--output/--model/--mode/--thinking-level/
  --settings`.
- `MASTRACODE_DISABLE_MCP` / `MASTRACODE_DISABLE_HOOKS` /
  `MASTRACODE_DISABLE_MEMORY` exist in the installed package but are only
  read by the interactive TUI entrypoint (`tuiMain`); the headless entrypoint
  (`runMCCli`) this adapter spawns never reads them, so declaring them as
  `env` here would silently do nothing.
- `--settings <path>` can point at a leaner `settings.json` (fewer model
  packs / no subagents / OM off), but that requires shipping and maintaining
  an actual settings file alongside the adapter, not just a manifest flag —
  out of scope here. Revisit if that's worth doing.
