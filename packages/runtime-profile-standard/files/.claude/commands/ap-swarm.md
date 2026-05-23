---
description: Run a MultiAgentRuntime swarm in file mode — local journal at .runtime/conversation.md, no network
argument-hint: [--manifest=<path>] [--once] [--verbose]
allowed-tools: Read, Write, Bash
---

You are starting a local-mode MultiAgentRuntime swarm using `@agentproto/agent-runtime` via the `pnpm agentproto run-swarm` verb.

## Quick path

1. If `.runtime/multi-agent.yaml` does not exist, copy the template:

   ```bash
   mkdir -p .runtime && cp .claude/examples/swarm-local.md .runtime/multi-agent.yaml
   ```

   Then read it back and tell the user what's wired (participants, substrate kind, state dir).

2. Build the agent-runtime + cli packages if they haven't been built yet:

   ```bash
   pnpm --filter @agentproto/agent-runtime build && pnpm --filter @agentproto/cli build
   ```

   You only need this on first run or after pulling changes — `tsup --watch` (from `pnpm dev`) keeps it fresh.

3. Start the swarm. Pass through any user-supplied args (`--once`, `--interval`, `--verbose`). Default:

   ```bash
   pnpm agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
   ```

   This is a long-running loop. Suggest the user open a separate terminal for it, OR run with `--once` to do a single dispatch cycle and exit.

4. Seeding the journal: tell the user that participant turns only fire on `@Mention` of a known participant. Show them how to add a seed turn manually:

   ```bash
   cat <<'EOF' >> .runtime/conversation.md
   === TURN id=t_seed participant=user ts=$(date -u +%FT%TZ) ===
   @Reviewer please look at <file or topic>
   EOF
   ```

   Or just edit `.runtime/conversation.md` directly in the editor.

## Notes

- The journal at `.runtime/conversation.md` is the source of truth for file mode. It's gitignored. Resetting = deleting the file.
- Per-participant scratch state lives at `.runtime/state/<participantId>.json`. Also gitignored.
- Other substrates (chat servers, MCP bridges, …) ship as separate plugin packages. Register them via `--plugin <module-id>` on `run-swarm`, or list them under `plugins[]` in `~/.agentproto/config.json`.

## Errors to watch

- "unknown substrate kind '<kind>'. Registered kinds: […]" → the manifest's `substrate.kind` has no matching factory. Either fix the kind, or install the plugin that provides it and pass `--plugin <module-id>`.
- "manifest file not found" → check the path; the verb resolves it from the current cwd.
- Spawned `claude` returning non-zero → the participant agent's command failed. Check stderr in the swarm process output.
