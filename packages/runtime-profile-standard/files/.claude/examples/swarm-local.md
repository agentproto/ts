---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: local-swarm
participants:
  - id: reviewer
    executor: agent-cli
    displayName: Reviewer
    role: ../../.claude/agents/reviewer.md
    config:
      model: sonnet
  - id: skeptic
    executor: agent-cli
    displayName: Skeptic
    role: ../../.claude/agents/skeptic.md
    config:
      model: opus
substrate:
  kind: file
  path: ./conversation.md
dispatcher:
  kind: mention
state:
  kind: fs
  dir: ./state
---

# Local swarm — file substrate

Two participants (Reviewer and Skeptic) coordinated through an
append-only markdown journal at `.runtime/conversation.md`. No network,
no remote services — useful as a starting template you copy and extend
with your own participants.

## How to run

1. Copy this file to `.runtime/multi-agent.yaml` (the `.runtime/` dir is
   gitignored, so manifests there are per-developer):

   ```bash
   mkdir -p .runtime && cp .claude/examples/swarm-local.md .runtime/multi-agent.yaml
   ```

2. Start the swarm in one terminal:

   ```bash
   agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
   ```

3. In another terminal, seed the journal with a turn that mentions one
   of the participants:

   ```bash
   cat <<'EOF' >> .runtime/conversation.md
   === TURN id=t_seed participant=user ts=2026-05-23T10:00:00Z ===
   @Reviewer please take a look at <file or topic>
   EOF
   ```

4. The swarm process polls every 2s. Within one cycle it will detect the
   @Reviewer mention, spawn `claude --print --output-format=json
   --permission-mode bypassPermissions` with Reviewer's role + the
   recent transcript, and append the reply as a new turn in the journal.

## Adding participants

Each participant under `participants:` needs an `id`, an `executor`
kind, a `displayName` (used for `@Name` detection), and an optional
`role` (inline string or relative path to a markdown file).

The reference `agent-cli` executor spawns `claude` by default; the
`role` content is fed to it on stdin along with the recent transcript.
Drop in additional `.claude/agents/*.md` files and reference them
under `role:` to add specialists.

Use `config:` to override the executor for a single participant without
changing the global default. For example:

```yaml
participants:
  - id: strategist
    executor: agent-cli
    displayName: Strategist
    role: ../../.claude/agents/strategist.md
    config:
      model: opus
  - id: skeptic
    executor: agent-cli
    displayName: Skeptic
    role: ../../.claude/agents/skeptic.md
    config:
      model: sonnet
```

`config.model` is only honoured when `command` is `claude` (the
default); it appends `--model <model>` to the spawned argv. Use
`config.command` and `config.args` to point a participant at a different
CLI binary entirely.

## Other substrates

`substrate.kind` resolves through the agentproto CLI's adapter
registry. Built-in: `file`. Third-party substrates (chat servers,
MCP bridges, …) register themselves when loaded — pass
`--plugin <module-id>` to `run-swarm`, or list them under `plugins[]`
in `~/.agentproto/config.json`.

## Path conventions

Paths in this manifest resolve relative to the manifest file itself.
- `role: ../../.claude/agents/reviewer.md` works when the manifest is at
  `.runtime/multi-agent.yaml`.
- `substrate.path: ./conversation.md` resolves to `.runtime/conversation.md`.
- `state.dir: ./state` resolves to `.runtime/state/`.

If you put the manifest somewhere else, adjust the relative paths.

## Permission mode

The default `agent-cli` args for `claude` include
`--permission-mode bypassPermissions`. Swarm participants run unattended
over piped stdin/stdout, so an interactive permission prompt would hang
forever rather than be answerable. Keep this in mind if you override
`config.args`: you either need an equivalent non-interactive permission
mode or must ensure the participant's role never triggers a tool request.