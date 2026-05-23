# @agentproto/runtime-profile-standard

Reference file-mode MultiAgentRuntime profile for the `agentproto`
CLI. Installs a small Claude Code scaffolding into the current
repository so `agentproto run-swarm` works out of the box.

**Status:** alpha.

## What it drops in

| Path                                       | Strategy        |
| ------------------------------------------ | --------------- |
| `.claude/agents/reviewer.md`               | overwrite       |
| `.claude/hooks/session-start.mjs`          | overwrite (+x)  |
| `.claude/hooks/user-prompt-submit.mjs`     | overwrite (+x)  |
| `.claude/commands/ap-swarm.md`             | overwrite       |
| `.claude/examples/swarm-local.md`          | overwrite       |
| `.claude/settings.json`                    | deep-merge      |

The install handler records what landed in
`~/.agentproto/profiles/standard.json`, so re-runs are idempotent and
user edits aren't clobbered without `--force`.

## Install

```bash
agentproto install runtime-profile/standard
```

After install, follow `/ap-swarm` inside a Claude Code session, or
copy `.claude/examples/swarm-local.md` to `.runtime/multi-agent.yaml`
and run:

```bash
agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
```

## Scope

This profile is file-mode only: a local append-only markdown journal
at `.runtime/conversation.md`. Transport-bridge profiles (Slack,
hosted chat servers, MCP-bridged threads, …) ship as separate
`@<vendor>/runtime-profile-*` packages that install the same way and
register their own adapters with the CLI's plugin registry.

## License

MIT.
