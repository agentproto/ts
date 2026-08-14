---
name: agent-session-orchestration-agentproto
description:
  "Drive and SUPERVISE other coding agents (claude-code, hermes, …) via the
  agentproto daemon from a cowork session: launch sessions, babysit a
  beginner agent step-by-step, export an agent conversation to readable
  markdown, resume a session with its context, and orchestrate several
  agents in parallel (launch-and-leave). Trigger this skill when the user
  wants to 'launch an agent / claude code / hermes', 'supervise an agent',
  'continue/resume a session', 'export a session', 'see where an agent
  stopped', 'babysit an agent', or orchestrate a long workflow with one agent
  coding while another (or Claude) plays the human."
---

# Agent Session Orchestration (agentproto)

Methodology + concrete commands for driving other coding agents via the
**agentproto** daemon (MCP tools `mcp__agentproto__*`). Drawn from a real
session.

## Principle

The orchestrator (you, in cowork) **does not code**: it **launches,
supervises, exports, resumes** agent sessions (claude-code, hermes). The
agents do the work; the orchestrator breaks it into small steps, re-reads
every diff, and hands out the next step.

Before delegating, paste `supervisor-session`'s Brief Contract into every
brief.

## Essential agentproto tools

- `adapter_list({filter})` — known adapters + status (`supported` not
  installed, `available` installed, `ready` setup done). Call before
  spawning.
- `agent_start({ adapter, cwd, label?, model?, prompt?, workspaceSlug? })` —
  spawn a persistent session. **`cwd` must be an absolute HOST path** (the
  daemon runs on the user's machine), otherwise error "no cwd resolvable".
  Returns `{ id: sess_xxx, adapterSessionId, cwd, … }`.
- `agent_prompt({ sessionId, prompt })` — next turn (multi-turn).
- `agent_output({ sessionId, since?, lastN?, waitForTurnEnd?, timeoutMs? })`
  — read the output. Pass `since: nextCursor` to read only what's new.
- `session_list({ kind?, onlyAlive?, status? })` — inventory.
- `agent_kill`, `command_list`, `command_execute` (host shell, basenames
  allowlisted in `<workspace>/.agentproto/allowed-commands.json` —
  typically `node, ls, cat, git, pnpm, npm, npx, gh, …`).

## Adapters (verified)

- **claude-code**: `available`. Spawned over ACP
  (`npx @agentclientprotocol/claude-agent-acp`). Native resume wired into
  agentproto. **Built-in tools** (Read, Write, Bash, Edit) — does NOT need
  `mcpServers` to code.
- **hermes** (binary `tirith`, Nous Research): `available`. Spawned as
  `hermes acp`. **Default model `x-ai/grok-4.3` → requires Nous credits**;
  otherwise `HTTP 404: requires available credits`. Fixes: add credits, or
  pass `model: "anthropic/claude-sonnet-4-6"` at spawn / `/model …` mid-run.

### ⚠️ CRITICAL — hermes WITHOUT mcpServers = chat-only (no tools)

**Pitfall #1, learned the hard way.** `claude-code` has built-in tools
(Read, Write, Bash, Edit) — it codes out of the box. **hermes has NONE over
ACP** — you must mount them explicitly via `mcpServers` at spawn time.

Without `mcpServers`, hermes receives the prompt, switches model, echoes
the brief, `turn-end (completed)` — but **0 tool calls**. It reads no
files, writes nothing, runs no commands. It looks like it understands but
does nothing.

**Mandatory fix for hermes**:

```json
{
  "adapter": "hermes",
  "mcpServers": [
    {
      "name": "agentproto",
      "transport": "http",
      "ref": "http://127.0.0.1:18790/mcp"
    }
  ]
}
```

Gives hermes `read_file`, `write_file`, `execute_command`, etc. from the
daemon.

**Verification**: after spawn, `agent_output` — if you see `[tool] read` or
`[tool] execute`, it works. If you only see text + `turn-end`, the
mcpServers are missing.

**Note**: spawning with `mcpServers` can take ~40s (the daemon mounts the
MCP inside the hermes process). Timeout ≥ 120s on the `agent_start` MCP
call.

## Pattern 1 — Launch-and-leave (light orchestration, zero polling)

1. Launch the session(s), **note the `sess_xxx`** (and `nextCursor`).
2. **Do NOT poll in a loop** (it burns tokens in YOUR context). Re-engage
   on: a user ping, a notify event, or a spaced-out check.
3. On re-engagement: `agent_output({ sessionId, since: <cursor> })` → new
   lines only. Transcripts persist → nothing lost after a restart.
4. `agent_output({ waitForTurnEnd:true, timeoutMs:45000 })` **only for ≤ 45
   s** and only when you're actively waiting for an imminent completion.
   The MCP request cuts off at ~60 s: beyond that you get "Request timed
   out", not a result.

## Pattern 2 — Babysitting a beginner agent step-by-step

For an agent that "stalls often along the way" (e.g. hermes/grok):

1. **Seed** a fresh session with the repo's `cwd` + the exact context
   (file, goal, pattern to follow, list of steps).
2. **One step per turn**: "migrate ONLY method X, then STOP and report back
   + compile status. Do nothing else."
3. `waitForTurnEnd` → **re-read the diff** → approve or correct →
   `agent_prompt` with the next step. Repeat.
4. Supervisor's golden rule: you **read** (the code, the state) but you
   **don't code**.

## Pattern 3 — Seeing where a session stopped WITHOUT paying for a resume

Resume reloads the whole history into context (expensive). To just
**re-read** where things stand, read the persisted source:

- **hermes**: `~/.hermes/state.db` (SQLite). Via read-only `node:sqlite`:
  ```js
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.env.HOME + "/.hermes/state.db", {
    readOnly: true,
  })
  // last lines of a session:
  db.prepare(
    "select role,tool_name,substr(content,1,600) c from messages where session_id=? order by id desc limit 8"
  ).all(id)
  ```
  Tables: `sessions` (meta:
  `title, model, message_count, input_tokens, output_tokens, estimated_cost_usd, …`) +
  `messages` (`role, content, tool_calls, tool_name, reasoning, timestamp`).
- **claude-code**: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
  (encoded-cwd = `cwd.replace(/\//g,"-")`), Anthropic message format
  (`text` / `tool_use` / `tool_result` blocks), one JSON event per line.

## Pattern 4 — Exporting a session to readable markdown

The live ACP stream (`agent_output`) is noisy (ANSI, `[thought]`, `[tool]`).
For **archiving/reading**, read the clean persisted source and render
markdown. Reference script provided: **`scripts/hermes-export.mjs`**
(hermes → markdown: meta header, turns 🧑/🤖/🔧, reasoning in `<details>`,
tool calls, truncated outputs). Usage:
`node scripts/hermes-export.mjs <sessionId> [out.md]`.

Hermes also has a native export (JSONL only):
`hermes sessions export --session-id <id> -` and `hermes sessions list`.

## Pattern 5 — Resuming a session with its context

- **hermes** (native CLI): `hermes --resume <id>` / `-r <id>` (by id or
  title), `hermes --continue` / `-c` (latest, or by name). Reloads
  everything from state.db.
- **claude-code**: `claude --resume <id>` (wired into agentproto via
  `RESUME_STRATEGIES`).
- Key mapping: in both stores, the source id == the `adapterSessionId` of
  the agentproto `SessionDescriptor` (hermes over ACP records the session
  under the same UUID, `source='acp'`).
- **Resume = continuing (expensive, reloads context); Export = re-reading
  (free, read-only).** Choose based on the need.

## Pattern 6 — Durable orchestration (long-term target)

A truly reliable "babysitter" doesn't live in cowork (depends on the app
staying open) but **inside agentproto**: an engine that subscribes
in-process to session events (`turn-end`, `awaiting-input`, `exited`),
chains steps, answers questions per a policy, and **only escalates to a
human (`notifyUrl` webhook) when genuinely stuck**. Delivered via
`workflow_*` (`workflow_start`/`workflow_status`/`workflow_cancel`/
`workflow_escalation_resolve`) — `routine_start` and the rest of
`routine_*` have been **removed** (the old imperative `RoutineRunner`
engine, then its alias, disappeared in Phase B2/B3). Surfaces to expose:
`session_monitor({sessionIds})`, `session_events_poll({since})`,
notification webhook. It's "an agent babysitting another agent by playing
the human", with no token-hungry polling.

## Pattern 7 — Multi-session supervision (session_monitor)

**2026-07-02 update: `wait_for_any` was renamed `session_monitor`** (same
shape — `sessionIds`, `timeoutMs`, `event` — plus an additional `since`
parameter, see gotcha below). The name `wait_for_any` no longer exists on
the daemon side; if a tool/skill still references it, that's stale text,
not a tool to look for.

To watch N sessions in parallel without token-hungry polling:

1. Spawn your N sessions, note the `sess_xxx`.
2. Call
   `session_monitor({ sessionIds: [...], timeoutMs: 45000, event: "turn-end" })`.
3. As soon as a session finishes its turn, retrieve its output, then call
   `session_monitor` again on the remaining sessions.
4. Do NOT build a custom polling script in `execute_code` — that's exactly
   what `session_monitor` does natively (multiplexed long-poll on the
   daemon's event bus).

**Current limitation**: `session_monitor` returns on the FIRST hit only
(same limit as the old `wait_for_any` — the rename didn't change this
semantics). For monitoring that returns ALL fired sessions + pendings in a
single call, there is still no single blocking equivalent — the correct
way to cover this today is to combine: `session_monitor` to block on the
first hit, then `session_events_poll({ since })` right after to sweep up,
non-blocking, everything else that also fired in the meantime on the other
sessions (instead of re-looping `session_monitor` one at a time). `since`
takes the cursor returned by a previous `session_events_poll` call.

## Pattern 7-bis — Waiting from the CLI without the 45 s drop (`agentproto sessions wait`)

`session_monitor` (MCP) blocks for **at most ~45-49 s** then times out —
under the MCP request ceiling. On a long turn (an agent coding for 20 min
with no intermediate turn-end), you'd have to **re-launch it in a
foreground loop**, which burns the orchestrator's context (real case: ~15
re-calls on a single deepseek turn).

The CLI has the equivalent WITHOUT that ceiling:

```bash
agentproto sessions wait <sessionId|name> \
  --until turn-end|awaiting-input|exited|any \
  --timeout 1800000 --json         # total budget 30 min, not 45 s
# or: --policy <policyId>  → waits for a policy to resolve instead of an event
```

Internally it **chains ~50 s server slices with an advancing `since`
cursor** until the `--timeout` budget is exhausted — so ONE call waits 30
min (or more). Two decisive gains:

1. **Run it in the background** (from cowork: a background Bash task).
   You're notified when it fires, **zero foreground polling, zero context
   burned**. This is THE right way to wait for a long turn.
2. **Robust to the daemon going down**: if the daemon dies mid-wait, the
   HTTP request fails and the command exits (non-zero) → you're notified
   of the outage too, instead of staying stuck.

When to use which: `session_monitor` (MCP) for a quick multiplexed check
WITHIN a turn (N sessions, first hit); `agentproto sessions wait` (CLI,
backgrounded) for a **long** wait on a turn/session without holding
context. Exit codes: `0` = event matched, non-zero = budget timeout /
session missing / daemon unreachable.

## Pattern 8 — Delegating a real PR-worktree (implementation → merged PR)

Learned in a real full orchestration session, 2026-07-01: 4 plans
implemented in parallel, 8 worktrees, 6 merged PRs, several cascading
conflicts. This pattern covers the full spawn → merged PR cycle, beyond
Pattern 1 (launch-and-leave, which only covers the spawn).

1. **Dedicated worktree, always** (covered elsewhere already, reminder):
   `_agentproto-worktrees/<feature>/` + branch `feat/<feature>` off `main`,
   never in the main tree.
2. **PLAN.md must NEVER be committed.** Any worktree that writes a PLAN.md
   at the root (an established convention) collides with EVERY OTHER
   PLAN.md already merged to main under the same name — seen 4× in the
   same session (cron-scheduler vs session-liveness, #142's plan vs
   cron's, etc.). Instruction to give explicitly to every session: keep
   PLAN.md untracked (or `git rm` it if it was accidentally committed in
   an earlier planning phase), and fold the useful content into the PR
   body (`gh pr create --body`) rather than a committed file.
3. **No AI attribution in commits/PRs.** claude-code sessions add
   `Co-authored-by: Claude...` to commits and `🤖 Generated with...` to the
   PR body by default — the same default as Claude Code itself. If you
   want commits/PRs that read as ordinary human work, the instruction must
   be **explicit in EVERY spawn prompt** (nothing holds it back at the
   daemon level today): "no Co-authored-by trailer, no Generated-with
   footer." Cleaning up an already-merged PR body is risk-free (`gh pr
   edit --body-file`, a pure GitHub text edit); NEVER rewrite an
   already-merged commit history for this (rebase + force-push are
   disproportionate for a cosmetic fix).
4. **NEVER trust a "done" without independent verification.** Always
   re-derive the truth via
   `git log`/`git merge-base --is-ancestor origin/main HEAD`/`gh pr view --json mergeable,mergeStateStatus, reviewDecision`/`gh pr checks`
   — NOT just reading the session's text summary. Real case: a CI bot
   ("Auto-fix from review") reported `pass` without pushing anything; an
   automated review first flagged a real bug and then two subsequent
   reviews incorrectly "approved" it without the code having changed — the
   only way to settle it was to read the diff yourself.
5. **Cascading conflicts = expected, not exceptional.** Several sibling
   branches sharing crossroads files (`http-server.ts`,
   `orchestration-tools.ts`, `index.ts`, `define-agent-cli.ts` on the
   agentproto/ts side) conflict **sequentially** as each one merges before
   the others. Write a precise resolution brief (which block to keep, why,
   which side is just a textual artifact vs. a real logic divergence)
   rather than leaving the session to guess — especially when two branches
   independently implemented the same plumbing in textually different but
   semantically identical ways.
6. **Specific pitfall: "cherry-pick an unmerged sibling branch to avoid
   waiting" guarantees a second, harder conflict once that branch actually
   merges via GitHub** (the GitHub merge commit has a different
   hash/shape than a raw branch-to-branch merge, even when the logical
   content is identical). This is a real trade-off (starting sooner vs. a
   guaranteed later conflict), not a mistake in itself — but document/
   anticipate it in the prompt for the session that will have to resolve
   it, rather than being surprised.
7. **Before believing that code merged to `main` is "in prod" on the local
   daemon: verify the daemon is running a fresh build.**
   `ps aux | grep agentproto` → note the PID and start time; compare to
   `ls -la packages/runtime/dist` (build mtime). A daemon started before
   your latest merges is running an old build — none of the freshly merged
   features are actually testable through the MCP tools until you've
   rebuilt + relaunched (see the "Post-reboot" gotcha below). **Do NOT
   restart the daemon if it's supervising a still-active session** — that
   kills it with no clean recovery (resume reloads the context, it isn't
   free).

## Pattern 9 — Resurrecting a killed session WITH continuity (session_restart)

Learned in real use 2026-07-01/02: a daemon restart kills sessions mid-work
(`error: "session absent at reload"`), but **the conversation isn't
lost** — `adapterSessionId` stays in the descriptor even when `killed`, and
claude-code/hermes have persisted their state on the adapter side.

- **CLI** (available for a while, the only route until #151 was merged):
  `agentproto sessions restart <id-or-name>` — re-reads the descriptor
  (memory OR history), picks the resume strategy (PTY-native > ACP resume
  via `adapterSessionId` > plain PTY > error for a generic `command`
  session), and spawns a NEW `sess_xxx` that picks up the thread. Proven in
  real use: two sessions killed by a daemon restart, relaunched via this
  command, resumed with their full brief.
- **MCP** `session_restart({ idOrName, cols?, rows? })` — same in-process
  logic (PR #151, merged 2026-07-02), for an orchestrator with no shell
  access. Returns `{ id, resumedFrom, resumeVia }`. **Root `/mcp` only, not
  in the default scoped subset** (same posture as
  `terminal_start`/`command_execute` — privileged). Verified in real use
  with a real call: `resumedFrom` + `resumeVia:"resumed via ACP"` correct,
  same `adapterSessionId` as the original session.
- **Before #151**, an MCP-only orchestrator (no Bash/CLI access) had **no
  way** to resurrect a session with continuity — just a fresh
  `agent_start`, without the conversation thread. That's now covered.

## Gotchas (learned the hard way)

- **Model**: the `model` enum depends on the daemon; check via the error
  message if rejected.
- **Post-reboot**: `agentproto serve` can relaunch an old published build.
  Redo `pnpm -r build` (in `projects/agentproto/ts`) + relaunch the daemon
  with `--cli workspace` + reconnect the connector.
- **`awaitingInput` over-signals**: it means "turn finished, I'm waiting"
  just as much as "stuck on a question". To tell them apart, read the last
  content line (a real question often ends with `?` / "confirm / decision /
  ok for you").
- **Killed sessions**: only badge `awaitingInput` on `running` sessions.
- **`node:sqlite`**: Node ≥ 22, experimental API; always open with
  `{readOnly:true}` (the DB is locked by hermes while in use; handle
  `SQLITE_BUSY`).
- **MCP HTTP Accept header**: the MCP daemon requires
  `Accept: application/json, text/event-stream`. Without both, error `Not
  Acceptable`. If you do raw curl/Python.
- **`session_monitor` looping on an already-idle session**: if a session
  already finished its turn before the first call, the tool returns
  immediately (race-free replay via the ring). But in a loop, it can
  return the SAME already-idle session on every iteration if you don't
  pass `since` — filter already-processed sessions in your code, or
  better, pass the `nextCursor` from the last
  `session_events_poll`/`session_monitor` as `since` so the daemon only
  replays what's genuinely new.
- **A changeset with a copied filename = guaranteed conflict.** Seen
  2026-07-02: a session briefed to "add a changeset" saw
  `.changeset/pr-147-review.md` (already merged to main, added by the
  reviewer bot on ANOTHER PR) and reused **the exact same literal name**
  instead of a unique slug — add/add collision at merge time
  (`mergeable: CONFLICTING`). The `pr-<N>-review.md` name is THE name the
  reviewer bot generates itself per PR, not a convention to copy by hand.
  Instruction to give: either let `pnpm changeset` generate a random name,
  or explicitly pick a feature-specific slug (`fix-<feature>.md`).
- **`gh pr view --json mergeable`: `CONFLICTING` can be a transient GitHub
  cache artifact, not a real conflict.** Seen 2×: (PR #134
  changeset-release after a force-push, PR #147 right after a merge):
  `mergeable`/`mergeStateStatus` show an inconsistent state for a few
  seconds after a push/force-push, before GitHub recomputes. Before
  concluding there's a real conflict: `git merge-tree <base> <ours>
  <theirs>` (zero `<<<<<<<` = mechanically clean) and re-check a few
  seconds later. Same for `statusCheckRollup`: a context named "Agentic
  review" can appear duplicated (stale FAILURE + fresh SUCCESS) on
  successive commits of the same PR — the one clean source of truth is
  `gh api repos/<repo>/commits/<sha>/status` on the exact HEAD sha, or the
  CI run triggered by the `push` to `main` after the merge (not the PR
  rollup).
- **APPROVED + green checks ≠ merged.** This repo has a "maintainer" layer
  (AI judge, `.github/agentic-review.json` → `merge.maintainer:true`) that
  can withhold auto-merge on a change judged consequential (a shared-logic
  refactor, a large new script) even after an APPROVED review — it posts
  an explicit comment
  `🛑 Auto-merge withheld by the maintainer — @<escalateTo> please review`
  and waits for a manual human merge. Don't assume "review OK + CI green =
  it'll merge on its own"; check the PR comments for this message before
  concluding a PR is blocked by a real error.
- **`pnpm -r build` + relaunching the daemon right after can race the dist
  write.** Seen 2026-07-02: a restart launched almost simultaneously with
  a `pnpm -r build` started the daemon on a not-yet-fully-updated dist
  (process uptime ≈ dist mtime within a few seconds) — a freshly added
  tool (`session_restart`, PR #151) didn't show up in `tools/list` despite
  clean source code and a merged commit. Not a wiring bug — just too early
  a restart. ALWAYS verify via the daemon's own `tools/list` (`POST /mcp`
  `{"method":"tools/list"}`) after a post-merge restart, rather than
  trusting the client-side ToolSearch (which can itself be cached on an
  old manifest).
