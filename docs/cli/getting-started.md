# Getting started

A 5-minute walkthrough from `npm install` to a running swarm.

## 1. Install the CLI

```bash
npm i -g @agentproto/cli
agentproto --version
# → agentproto 0.6.0
```

The binary is named `agentproto`. `--help` (no args, or `-h`) prints
the verb list.

## 2. Install your first adapter

Pick an adapter — the canonical set is `claude-code`, `hermes`,
`opencode`, `codex`, `mastra-agent` (the first-party agent), `openclaw`.
Each is published as `@agentproto/adapter-<slug>`.

```bash
agentproto install claude-code
```

What this does:

1. Resolves `@agentproto/adapter-claude-code` from npm (you can
   install the adapter package separately first; otherwise the install
   verb expects it on the resolution path).
2. Runs the adapter's declared install pipeline — `npm i -g
   @anthropic-ai/claude-code`, or a `brew`, `curl`, `download`, etc.
   step depending on the manifest.
3. Runs the adapter's post-install `setup[]` pipeline if it has one
   (skip with `--skip-setup`).

If the underlying CLI is already installed and the manifest's
`version_check` answers, `install` short-circuits and reports
`already installed`. Pass `--force` to re-run anyway.

Full flag reference: [`verbs/install.md`](./verbs/install.md).

## 3. Run a single turn

```bash
agentproto run claude-code --prompt "Summarise the README in this repo."
```

`run` spawns the adapter, sends one user turn, streams the response to
stdout, then exits. Useful for scripting and smoke-testing.

Pipe a prompt over stdin instead of `--prompt`:

```bash
git diff | agentproto run claude-code -p "Review this diff."
```

Use `--json` for one JSON event per line (`text-delta`, `tool-call`,
`tool-result`, `turn-end`, `error`). See [`verbs/run.md`](./verbs/run.md).

## 4. Run your first swarm

Swarms need a manifest. The reference `standard` profile drops one
ready-to-edit example next to a Claude Code scaffolding:

```bash
agentproto install runtime-profile/standard
```

This copies `.claude/agents/reviewer.md`, `.claude/hooks/…`,
`.claude/commands/ap-swarm.md`, and an example manifest at
`.claude/examples/swarm-local.md` into the cwd. Re-runs are idempotent
via a ledger at `~/.agentproto/profiles/standard.json`.

Adapt the example into a real manifest at `.runtime/multi-agent.yaml`,
then:

```bash
agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
```

The kernel runs cycles — read substrate → dispatch → execute → append —
until you Ctrl-C. See [`verbs/run-swarm.md`](./verbs/run-swarm.md) and
[`concepts/swarms.md`](./concepts/swarms.md).

## 5. Add a plugin

Built-ins (`file`, `mention`, `fs`, `agent-cli`) cover local file-mode
swarms. To use a transport-backed substrate (e.g. a hosted gateway),
install its plugin:

```bash
agentproto plugins install <plugin-package>
agentproto plugins list
```

A plugin extends the kernel's `kind` registry — new substrates,
dispatchers, executors, or state stores. See
[`verbs/plugins.md`](./verbs/plugins.md) and
[`concepts/plugins.md`](./concepts/plugins.md).

## What's next

- Persistent sessions you can detach + reattach:
  [`verbs/sessions.md`](./verbs/sessions.md)
- Gating whether a spawned agent may itself delegate to sub-agents:
  [`concepts/roles.md`](./concepts/roles.md)
- What a session's transcript captures and how to export it:
  [`concepts/session-transcripts.md`](./concepts/session-transcripts.md)
- Hosting your CLI for a remote agent over a tunnel:
  [`verbs/serve.md`](./verbs/serve.md) +
  [`verbs/auth.md`](./verbs/auth.md)
- Running the daemon as a managed service:
  [`verbs/daemon.md`](./verbs/daemon.md)
