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
disk, nothing is spawned, and `ses_abc12` is not modified, so it is safe to run
as often as you like. Add `--json` for the structured response
(`{ dryRun, approximate, approximateNote, checkpoint, prompt }`).

The preview is an **approximation**. To stay read-only, a dry run never asks the
source session to summarise itself; it extracts what it can from the transcript
alone, so `goal`, `decisions`, `tests` and `nextStep` may be thinner than in the
real handoff. The output says so (`approximate content: ...`). The real handoff
(step 3) interrogates the session first.

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
| `schemaVersion`, `checkpointId`, `sourceSessionId`, `createdAt` | Format version, identity and timestamp. |
| `contextPct` | How full the source session's context window was. |
| `sections` | The handoff content: `goal`, `plan`, `decisions`, `changedFiles`, `gitStatus`, `tests`, `errors`, `risks`, `nextStep`, `notes`, `config`. Which sections are captured follows the session's context-continuity policy. |
| `recentDigest` | Bounded digest of the most recent turns. The daemon's own plumbing is left out: the handoff question and its JSON reply, and the role/AGENTS.md preamble injected at spawn. |
| `originalTranscriptPath` | The source session's full `events.jsonl` — preserved; the checkpoint is a summary, never a replacement. |
| `checkpointPath` | Where this file lives. |
| `policy`, `nextAction` | The effective context-continuity policy and the suggested next action. `compact_then_continue` only appears while the context is in the compact band (`compactAtPct` up to `continueFreshAtPct`, 65 to 75 % by default); anywhere else it is `continue`. |

`--note` text is stored verbatim in `sections.notes` and rendered in the resume
prompt under "notes (from the operator)". When the source session is idle, a real
handoff (not `--dry-run`, which never talks to the source session) also asks it to
summarise itself; sections the extraction can't fill may read `(… captured in recent
digest)`, in which case the content is in `recentDigest`.

The prompt the new agent receives is this checkpoint rendered as text:
`--dry-run` prints the same rendering, built from the approximate extraction
described in step 2.

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
  `harness`). agentproto only suggests it — see below.
- **The old session is not stopped**, and its working tree is shared — see
  step 3.

## When agentproto suggests a handoff

agentproto tells you when a handoff is worth it; you decide. There are three
triggers, and in each one **the switch is never automatic**: a suggestion
spawns nothing, and the new session only exists once you run the command or
answer the question yourself.

A harness is only suggested when it is installed, has a usable credential
(the same discovery `harness_capabilities` reports), and is not the harness
the session already runs on. With no such harness, nothing is suggested.

**Context threshold (`ask` mode).** When the context window crosses the
`compactAtPct` / `continueFreshAtPct` band, the session's question gains one
`handoff:<harness>` option per eligible harness, next to `continue-fresh` and
`keep-going`:

```
Context is at 78%. Continue fresh to avoid losing continuity?
options: continue-fresh · handoff:codex · keep-going
```

Answering `handoff:codex` is the same as `agentproto sessions handoff <id> --to
codex`. This only fires for adapters whose usage frames carry both a context
window size and the tokens used: `claude-code`, `claude-sdk`, `pi` and
`opencode` do. Adapters that report `size: 0` (`antigravity`, `jcode`) never reach the
threshold, so no question is raised there; for any other ACP-backed adapter it
depends on whether its server sends a `usage_update` with both figures.

**Provider usage limit.** When a session dies on a provider cap (Claude Code's
"You've hit your usage limit" / "session limit"), besides the
`provider-limit` end reason agentproto emits a `session:handoff-suggested`
event and writes a transcript line with the command in clear:

```
[handoff] Claude Code hit its usage limit. Hand off to Codex? agentproto sessions handoff ses_abc12 --to codex
```

The event rides the normal event bus (`GET /events`, `session_events_poll`), so
the CLI, VS Code and the panel all see it:

```json
{
  "type": "session:handoff-suggested",
  "sessionId": "ses_abc12",
  "fromHarness": "claude-code",
  "reason": "provider-limit",
  "suggestions": [
    { "harness": "codex", "command": "agentproto sessions handoff ses_abc12 --to codex" }
  ]
}
```

**Quota threshold (opt-in).** Set `handoffAtQuotaRemaining` in the
context-continuity policy and agentproto reads the session's auth profile
quota after each turn (at most every 5 minutes). When the remaining quota is at
or below the threshold it emits the same event with `"reason":
"quota-threshold"`, once per quota window:

```bash
agentproto config set defaults.contextContinuity '{"handoffAtQuotaRemaining": 10}'
```

The unit is the `remaining` figure Anthropic's rate-limit headers report, the
same number `usage_rollup` shows per profile: a count, not a percentage, since
the header carries no limit to divide by. Only sessions pinned to an Anthropic
auth profile (`access`) are watched. Unset, the check never runs and makes no
provider call; when set, each read is a one-token probe that uses a sliver of
that profile's own budget.

## See also

- [`sessions` verb reference](../verbs/sessions.md#checkpoint-id-or-name)
- [Session transcripts](../concepts/session-transcripts.md)
