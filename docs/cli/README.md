# `agentproto` CLI

The `agentproto` binary is the reference host for AgentProto agent-CLI
adapters. It installs adapter packages (`claude-code`, `hermes`,
`opencode`, `codex`, `mastra-agent`, `openclaw`, …), runs them locally
for a single turn or a long-lived session, exposes them as a daemon over
an outbound WebSocket tunnel, and orchestrates multi-agent swarms
through the runtime kernel.

This tree is **tool docs** — what the binary does, what flags it takes,
what files it touches. For the protocol it implements, see the AIPs
at <https://agentproto.sh/docs>.

> **Status:** alpha. The package is pre-1.0 (`0.1.0-alpha.x`). See
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

- [`agentproto auth`](./verbs/auth.md) — log in to a host (RFC 8628 device flow)
- [`agentproto browser`](./verbs/browser.md) — manage browser service sessions (Camofox, Bureau, Chromium)
- [`agentproto chat` / `chat-tui`](./verbs/chat.md) — interactive REPL on a daemon agent session
- [`agentproto config`](./verbs/config.md) — read/write `~/.agentproto/config.json`
- [`agentproto daemon`](./verbs/daemon.md) — install/start/stop the background service
- [`agentproto install`](./verbs/install.md) — install an adapter or a runtime profile
- [`agentproto mcp-bridge`](./verbs/mcp-bridge.md) — stdio MCP proxy to the daemon `/mcp` endpoint
- [`agentproto models`](./verbs/models.md) — list runnable models per adapter with provider-key status
- [`agentproto plugins`](./verbs/plugins.md) — manage runtime plugins
- [`agentproto run`](./verbs/run.md) — one-shot adapter turn
- [`agentproto run-swarm`](./verbs/run-swarm.md) — kernel-routed multi-agent loop
- [`agentproto serve`](./verbs/serve.md) — daemon mode (local-only or tunnelled)
- [`agentproto sessions`](./verbs/sessions.md) — browse/start/attach/stop daemon sessions
- [`agentproto setup`](./verbs/setup.md) — re-run an adapter's post-install pipeline
- [`agentproto tunnel`](./verbs/tunnel.md) — manage public Cloudflare/Ngrok tunnels
- [`agentproto workspace`](./verbs/workspace.md) — register local workspaces

### Concepts

- [Adapters](./concepts/adapters.md) — what `@agentproto/adapter-*` packages are
- [Plugins](./concepts/plugins.md) — extending the swarm kernel
- [Runtime profiles](./concepts/runtime-profiles.md) — `runtime-profile/<name>` scaffolding
- [Swarms](./concepts/swarms.md) — manifest + kernel cycle model
- [Credentials](./concepts/credentials.md) — how host tokens are stored
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
