# Hand off from Claude Code to Codex

Move a session's work to a different harness without starting over:
`agentproto sessions handoff` writes a **checkpoint** of the source session and
starts a new session on the target harness whose first prompt is that
checkpoint. This guide takes a Claude Code session to Codex, step by step.

Requires a running daemon ([`serve`](../verbs/serve.md) /
[`daemon`](../verbs/daemon.md)) and both harnesses installed and logged in
(`agentproto adapters list`).

## 1. Find the session

```bash
agentproto sessions
```

Note the id (or name) of the Claude Code session, e.g. `ses_abc12`. Handoff
only applies to agent sessions (`agent-cli`), not PTY terminals.

## 2. Preview with `--dry-run`

```bash
agentproto sessions handoff ses_abc12 --to codex --dry-run
```

Prints the checkpoint prompt Codex **would** receive. Nothing is written to
disk, nothing is spawned, and `ses_abc12` is not modified — safe to run as
often as you like. Add `--json` for the structured response
(`{ dryRun, checkpoint, prompt }`).

## 3. Hand off

```bash
agentproto sessions handoff ses_abc12 --to codex \
  --note "decision: keep the zod schema; the migration in 0042 is already applied"
```

```text
agentproto sessions handoff: ses_abc12 (claude-code) → ses_def34 (codex)
  checkpoint: /Users/you/.agentproto/sessions/ses_abc12/checkpoints/ckpt_ses_abc12_1788371280000.json
```

What happens:

1. The daemon builds a checkpoint of `ses_abc12` and writes it to the path
   shown.
2. It starts `ses_def34` on Codex in the same working directory, with that
   checkpoint rendered as the initial prompt. The source session's model and
   access profile are carried over unless you override them with
   `--model <id>` / `--profile <ref>`; the route is re-derived for the new
   harness. If Codex can't reach the carried-over model, or the profile isn't
   eligible for it, the spawn is rejected (nothing is silently billed to the
   wrong wallet) — pass `--model` / `--profile` explicitly.
3. The source session keeps running, untouched, with `continuedTo` pointing at
   `ses_def34`. The new session records `continuedFrom`, the checkpoint id and
   `handoff: { fromHarness: "claude-code", toHarness: "codex", at }`.

Attach to the new session as usual:

```bash
agentproto sessions --attach ses_def34
```

You will usually want to stop the source session once you're satisfied
(`agentproto sessions stop ses_abc12`) so two agents don't edit the same
tree. agentproto doesn't do that for you.

## Reading the checkpoint

Only want the file, without spawning anything?

```bash
agentproto sessions checkpoint ses_abc12 --note "context for whoever picks this up"
```

The checkpoint is a JSON file at
`~/.agentproto/sessions/<session-id>/checkpoints/<checkpoint-id>.json`:

| Field | Meaning |
|-------|---------|
| `checkpointId`, `sourceSessionId`, `createdAt` | Identity and timestamp. |
| `contextPct` | How full the source session's context window was. |
| `sections` | The handoff content: `goal`, `plan`, `decisions`, `changedFiles`, `gitStatus`, `tests`, `errors`, `risks`, `nextStep`, `config`. Which sections are captured follows the session's context-continuity policy. |
| `recentDigest` | Bounded digest of the most recent turns. |
| `originalTranscriptPath` | The source session's full `events.jsonl` — preserved; the checkpoint is a summary, never a replacement. |
| `checkpointPath` | Where this file lives. |
| `policy`, `nextAction` | The effective context-continuity policy and the suggested next action. |

`--note` text is stored with the checkpoint and appended to the resume prompt as
operator notes. Depending on your version, some `sections` entries may be placeholders such as
`(captured in recent digest)` — the actual content is then in `recentDigest`.

The prompt the new agent receives is this checkpoint rendered as text:
`--dry-run` prints exactly that.

## When does a handoff happen?

Only when you ask for one. The `contextContinuity` policy that watches a
session's context window has three modes (set under
`defaults.contextContinuity.mode` in `~/.agentproto/config.json`, or per
adapter/session):

| Mode | At `continueFreshAtPct` (default 75%) |
|------|----------------------------------------|
| `ask` (**default**) | The session asks whether to continue fresh; nothing happens until it's confirmed. |
| `auto` | The daemon continues fresh automatically, on the **same** harness. |
| `manual` | No nudges at all. |

Two limits worth knowing:

- **Switching harness is never automatic.** The policy's continue-fresh keeps
  the same harness; moving to a *different* one (`--to codex`) is always an
  explicit `sessions handoff` (or the `session_continue_fresh` MCP tool with
  `harness`). agentproto does not hand off when a quota is hit.
- **The old session is not stopped**, and its working tree is shared — see
  step 3.

## See also

- [`sessions` verb reference](../verbs/sessions.md#checkpoint-id-or-name)
- [Session transcripts](../concepts/session-transcripts.md)
