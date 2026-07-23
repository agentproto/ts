# `agentproto` CLI

The `agentproto` binary is the reference host for AgentProto agent-CLI
adapters. It installs adapter packages (`claude-code`, `claude-sdk`,
`hermes`, `opencode`, `codex`, `mastra-agent`, `openclaw`, …), runs them locally
for a single turn or a long-lived session, exposes them as a daemon over
an outbound WebSocket tunnel, and orchestrates multi-agent swarms
through the runtime kernel.

This tree is **tool docs** — what the binary does, what flags it takes,
what files it touches. For the protocol it implements, see the AIPs
at <https://agentproto.sh/docs>.

> **Status:** alpha. The package is pre-1.0 (`0.10.0`). See
> [`../../VERSIONING.md`](../../VERSIONING.md) for what the alpha
> guarantees and what may change between minor releases.

## Three ways in

Pick whichever matches what you're trying to do:

- **Run a Claude Code (or other) session locally** —
  [`getting-started.md`](./getting-started.md) walks through `install`
  + `run` for a single turn. For a persistent session attached to your
  terminal, see [`verbs/sessions.md`](./verbs/sessions.md).
- **Share your machine with a hosted agent** (a self-hosted
  gateway, …) — see [`verbs/auth.md`](./verbs/auth.md) for the device
  flow, then [`verbs/serve.md`](./verbs/serve.md) for the daemon with
  `--connect`.
- **Orchestrate a multi-agent swarm** —
  [`concepts/swarms.md`](./concepts/swarms.md) introduces the model,
  [`verbs/run-swarm.md`](./verbs/run-swarm.md) covers the verb.

## Reference

### Verbs

- [`agentproto acp`](./verbs/acp.md) — manage generic ACP agents (zero-code ACP CLIs)
- [`agentproto auth`](./verbs/auth.md) — log in to a host (RFC 8628 device flow)
- [`agentproto browser`](./verbs/browser.md) — manage browser service sessions (Camofox, Bureau, Chromium)
- [`agentproto chat` / `chat-tui`](./verbs/chat.md) — interactive REPL on a daemon agent session
- [`agentproto config`](./verbs/config.md) — read/write `~/.agentproto/config.json`
- [`agentproto conversation`](./verbs/conversation.md) — locate the native transcript behind a session, or the session behind a native transcript
- [`agentproto cron`](./verbs/cron.md) — durable cron jobs on the daemon (command, fresh agent, or re-prompt a live session)
- [`agentproto daemon`](./verbs/daemon.md) — install/start/stop the background service
- [`agentproto install`](./verbs/install.md) — install an adapter or a runtime profile
- [`agentproto install-mcp`](./verbs/install-mcp.md) — register the daemon's MCP server with installed coding CLIs
- [`agentproto mcp-bridge`](./verbs/mcp-bridge.md) — stdio MCP proxy to the daemon `/mcp` endpoint
- [`agentproto models`](./verbs/models.md) — list runnable models per adapter with provider-key status
- [`agentproto onboard`](./verbs/onboard.md) — first-run: register MCP + install the skill pack in one pass
- [`agentproto pack`](./verbs/pack.md) — generate a versioned skill pack from a manifest
- [`agentproto pair`](./verbs/pair.md) — end-to-end pairing with a daemon over an untrusted rendezvous
- [`agentproto permissions`](./verbs/permissions.md) — held tool-permission requests: list, approve/deny, or auto-resolve with `watch` rules
- [`agentproto plugins`](./verbs/plugins.md) — manage runtime plugins
- [`agentproto policy`](./verbs/policy.md) — CLI surface for the daemon's completion-policy engine (shell/judge gates, commit + human-ack)
- [`agentproto provider-preset`](./verbs/presets.md) — list provider gateway definitions + key-env status
- [`agentproto preset`](./verbs/preset.md) — manage saved user spawn configurations
- [`agentproto rendezvous`](./verbs/rendezvous.md) — self-host the untrusted pairing broker
- [`agentproto run`](./verbs/run.md) — one-shot adapter turn
- [`agentproto run-swarm`](./verbs/run-swarm.md) — kernel-routed multi-agent loop
- [`agentproto serve`](./verbs/serve.md) — daemon mode (local-only or tunnelled)
- [`agentproto sessions`](./verbs/sessions.md) — browse/start/attach/stop daemon sessions
- [`agentproto setup`](./verbs/setup.md) — re-run an adapter's post-install pipeline
- [`agentproto tunnel`](./verbs/tunnel.md) — manage public Cloudflare/Ngrok tunnels
- [`agentproto workspace`](./verbs/workspace.md) — register local workspaces
- [`agentproto worktree`](./verbs/worktree.md) — git worktree lifecycle (provision under `worktrees.root`, status-aware `ls`, guarded/salvage removal, `gc`)

### Concepts

- [Adapters](./concepts/adapters.md) — what `@agentproto/adapter-*` packages are
- [Plugins](./concepts/plugins.md) — extending the swarm kernel
- [Roles](./concepts/roles.md) — spawn-time delegation gate, the privilege lattice, and role packs
- [Runtime profiles](./concepts/runtime-profiles.md) — `runtime-profile/<name>` scaffolding
- [Swarms](./concepts/swarms.md) — manifest + kernel cycle model
- [Credentials](./concepts/credentials.md) — how host tokens are stored
- [Hooks and sandbox](./concepts/hooks-and-sandbox.md) — the two enforcement planes (ACP semantic gate vs. OS sandbox), the 3-tier cross-harness coverage matrix, and config surfaces (`.agentproto/hooks.json`, `.agentproto/command-sandbox.json`)
- [Session transcripts](./concepts/session-transcripts.md) — structured per-session capture, event kinds, native vs daemon export

### Guides

- [Use agentproto as an MCP server inside coding CLIs](./guides/mcp-in-coding-cli.md) — register the daemon in Claude Code, Codex, and Hermes

### File reference

- [`~/.agentproto/config.json` schema](./reference/config-schema.md)
- [`~/.agentproto/credentials.json` format](./reference/credentials-format.md)

## Install

```bash
npm i -g @agentproto/cli
agentproto --version
```

Node ≥ 20.9.0. Optional `node-pty` for terminal sessions —
`npm i -g node-pty` if you want `agentproto sessions terminal` and
PTY-backed agent attach.
