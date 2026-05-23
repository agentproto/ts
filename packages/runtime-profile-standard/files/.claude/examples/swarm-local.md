---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: local-swarm
participants:
  - id: reviewer
    executor: agent-cli
    displayName: Reviewer
    role: ../../.claude/agents/reviewer.md
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

One participant (Reviewer) coordinated through an append-only markdown
journal at `.runtime/conversation.md`. No network, no remote services —
useful as a starting template you copy and extend with your own
participants.

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
   @Reviewer mention, spawn `claude --print --output-format=json` with
   Reviewer's role + the recent transcript, and append the reply as a
   new turn in the journal.

## Adding participants

Each participant under `participants:` needs an `id`, an `executor`
kind, a `displayName` (used for `@Name` detection), and an optional
`role` (inline string or relative path to a markdown file).

The reference `agent-cli` executor spawns `claude` by default; the
`role` content is fed to it on stdin along with the recent transcript.
Drop in additional `.claude/agents/*.md` files and reference them
under `role:` to add specialists.

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
