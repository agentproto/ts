---
name: agentproto
description: "Drive and supervise agentproto, the AIP-45 host daemon that runs agent CLIs. Use when spawning sessions (claude-code, claude-sdk, hermes, codex), reading output, waiting on agents, arming gates or cron check-ins, or extending the daemon with apps, workflows, MCP servers, and adapters. Triggers: agentproto, spawn an agent, supervise sessions, daemon health."
---

# agentproto

Master map for the agentproto skill family. Route here first, then open the
grouper or primitive you need.

## What agentproto is

agentproto is an AIP-45 agent-CLI host daemon. It spawns and supervises agent
sessions (claude-code, claude-sdk, hermes, codex, …) as first-class processes
with a turn lifecycle, and also provides a real PTY terminal, one-shot shell
commands, cron, task boards, completion policies, apps, and workflows.

- The daemon runs on the user's host at `http://127.0.0.1:18790`.
- When things feel dead, check `daemon_health` (or `GET /health`) FIRST before
  blaming an adapter or a model.
- Sessions register under a workspace root; the workspace groups sessions,
  transcripts, worktrees, and the session brain.

## Three surfaces to the same daemon

1. **MCP tools** (preferred): ~150 tools. Use for everything interactive.
2. **`agentproto` CLI**: for long waits, attach, mirror, export — anything a
   single MCP call cannot outlive.
3. **Plain HTTP GET routes**: `/health`, `/sessions`, `/sessions/:id`,
   `/sessions/:id/events` — cheap checks with no ceremony.

## This skill family: 3 layers

- **Layer 1 — primitives (`ap-*`)**: one action each. The ONLY place where
  mechanics live — tool signatures, flags, call recipes.
- **Layer 2 — groupers**: thin indexes that route you to primitives. No
  mechanics, only pointers.
- **Layer 3 — playbooks (`pb-*`)**: end-to-end processes, start to finish.

## Reading order for a new task

1. Match your goal in the routing table below.
2. Open the grouper — it names the primitive that owns the mechanics.
3. Open the primitive for tool signatures and recipes.
4. Playbooks chain several primitives end-to-end when the process is fixed.

## Routing table: goal → where to go

| Goal | Open |
| ---- | ---- |
| Drive one or more agents right now | `drive-agents` |
| Long mission needing durable waiting or check-ins | `supervise-long-missions` |
| Cheap code workers instead of expensive Claude | `cheap-coders` |
| Extend agentproto (apps, workflows, MCP, adapters) | `extend-agentproto` |
| Run a whole process start-to-finish | a `pb-*` playbook below |

## Skill index

### Primitives — mechanics live here

| Skill | One-liner |
| ----- | --------- |
| ap-spawn-agent | Create a session for an adapter CLI, with options. |
| ap-prompt-agent | Send follow-up prompts, queue turns, interrupt. |
| ap-read-output | Read a session's output and transcripts safely. |
| ap-wait-fanin | Block until one or many sessions end their turn. |
| ap-wait-durable | Non-blocking completion watching with notification. |
| ap-lifecycle | Kill, archive, GC, rename, pin, restart sessions. |
| ap-policies | Completion gates, retry nudges, commit policies. |
| ap-run-command | One-shot allowlisted shell command runs. |
| ap-terminal | Real PTY sessions for interactive TUIs. |
| ap-cron | Cron jobs: command, agent spawn, or session re-prompt. |
| ap-reactions | React when a session completes: event routines, AGENT.md `on` maps, `session:archive`, receipts, `GET /reactions`. |
| ap-tasks | Task boards with claims and rev-CAS updates. |
| ap-import-mcp | Import and call external MCP servers. |
| ap-tunnels | Publish local ports as public HTTPS tunnels. |
| ap-adapters | Install and inspect agent CLI adapters. |
| ap-models-auth | Model catalog, auth profiles, presets, usage. |
| ap-apps | Bundle, install, and run agents+workflows as APPs. |
| ap-workflows | Multi-stage, multi-session pipelines. |
| ap-transmit | Send outbound messages from sessions. |

### Groupers — thin indexes

- `drive-agents` — spawn → prompt → read → wait → lifecycle.
- `supervise-long-missions` — missions that outlive your attention.
- `cheap-coders` — route code work to cheap capable models.
- `extend-agentproto` — make the platform do new things.

### Playbooks — end-to-end processes

| Playbook | One-liner |
| -------- | --------- |
| pb-new-agent-session | Spawn one agent, brief it, verify its output. |
| pb-supervise-parallel-mission | Fan out parallel workers with fan-in and gates. |
| pb-nested-orchestrator | An orchestrator session that spawns its own workers. |
| pb-boss-checkins | Scheduled cron check-ins re-pinging your session. |
| agentproto-apps | Author, build, and package an agentproto APP. |
| pb-build-pack | Author and import company/agency/knowledge packs. |

## Rules and permissions

Rules the daemon enforces, with where. Paths are relative to the
`agentproto/ts` repo (`packages/runtime/src/...` unless noted). When a call is
refused, read the error text, find the rule here, apply the conduct.

**Task board writes** (`task-ledger.ts`)
- Rule: a session writes a task only if it is its owner, its creator, or the
  operator (`isManager` :725, `isOwner` :730; refusal :1019). Editing fields,
  reassigning, cancelling and reopening a done task are creator/operator only
  (:1034, :1073, :1081). A `tree:*` board is reachable only inside the caller's
  own lineage (:713).
- Status moves (`ALLOWED_TRANSITIONS` :910): `pending` -> `in_progress` or
  `cancelled`; `in_progress` -> `pending`, `done`, `failed`, `cancelled`,
  `awaiting_approval`; `done` -> `pending` (reopen); `failed` and `cancelled`
  are terminal. `pending` -> `done` is refused (`invalid transition`, :1065);
  `in_progress` on an unowned task is refused (:1093).
- Conduct: the worker calls `task_claim` first (CAS on `rev`, :991), then
  `task_update` to `done`. A child that did not claim and did not create the
  task gets "only owner, creator or operator": either create the task with
  `owner: <child sessionId>`, or reassign it (`task_update owner`) as the
  creator, or have the child claim it. On a `conflict` answer, re-read the
  returned record and retry with its `rev`.

**Driving a session** (`session-owner.ts:116`, `checkSessionOwnerGate`)
- Rule: `agent_prompt`, `agent_kill`, `agent_interrupt`, `session_restart`
  accept only the target's owner (the session that spawned it), one of its
  ancestors, the session itself, the human operator, or a caller listed in the
  target's `allowPromptFrom` (`sessions.ts:2282`; ids, `"any"`, `label:<x>`;
  a `label:` grant matches root sessions only). Everyone else gets "may only be
  driven by its owner".
- Conduct: spawn the child yourself, or pass `allowPromptFrom` at `agent_start`,
  or change it afterwards with `agent_set_prompt_policy` (owner, the session
  or the operator only). After a successor replaces a parent, use
  `session_adopt` so the children move to the new owner
  (`lineage-handover.ts`).

**`message_parent`** (`agent-tools.ts:1339-1500`)
- Rule: reports up to `parentSessionId`. No parent (a root session): refused
  (:1453). Parent id gone from the registry: refused (:1459). Parent dead:
  the daemon re-parents the caller to the declared successor or nearest live
  ancestor and delivers there (`resolveLiveParent`, `lineage-handover.ts:94`,
  call :1466); if none is alive, "is not running ... no live successor or
  ancestor" (:1479).
- Conduct: a refusal is a final state, not a retry loop. Write the result to a
  durable place (file, task `evidence`, PR) and end the turn; the supervisor
  reads it with `session_follow` or `agent_output`. A root session has no one to
  `message_parent`: use `message_send` to a named session instead.

**`sessions restart` on a cold session** (`cli/src/commands/sessions.ts:5666`,
`session-tools.ts:5866`, `session-restart-core.ts:1005`)
- Rule: restart looks the id up in the registry and in history (cold rows the
  registry dropped at boot, `session_list includeCold`). "no session ... found
  in registry or history" means the id or name matches neither: typo, a short
  prefix, or a row that is gone. A row killed in this daemon lifetime is not
  lazy-resumable and falls back to a new-id restart (:1005). Restart is gated
  by the same drive rule as above.
- Conduct: locate the real id first (`session_list` with `includeCold`, or
  `session_search`), then `session_restart <id>`; the answer carries
  `resumedFrom` and the NEW id, so follow the new id. If the history is truly
  gone, start a fresh session with a recap instead (`session_continue_fresh`).

**Host guard and idle reaper** (`idle-reaper.ts:163-190`,
`cli/src/commands/host-guard.ts:25-75`, `config-schema.ts:1247`)
- Rule: the idle reaper retires an `agent-cli` session that is `running`, idle
  past `daemon.idleReapAfterMs` (default 0 = never runs), not busy, not
  awaiting input or permission, not `keepAlive`, not `pinned`, and whose parent
  is not alive (:163-188). `agentproto host guard` closes the oldest idle
  sessions on host WARN/CRIT through `/sessions/:id/reap` (tag `guard-reaped`,
  row stays lazy-resumable), never a busy, `keepAlive`, `pinned`, watched
  session or an ancestor of a live one. On CRIT it also blocks
  `agentproto workflow start|run-file` (`heavyWorkflowBlockReason` :494).
- Conduct: a reaped session is not lost: prompt it (lazy resume) or
  `session_restart`. On a workflow blocked by the guard, free the host and
  re-check `agentproto host health`; `--force` only with the operator's go.

**`keepAlive`** (`sessions.ts:2264`, `idle-reaper.ts:167`)
- Rule: `keepAlive: true` exempts a session from the idle reaper and the host
  guard's sweep. Set at `agent_start` or later with `session_set_keepalive`.
  It does not stop an explicit kill, a crash, or a daemon restart. `pinned`
  exempts from the idle sweep too but is a separate flag.
- Conduct: set it on a supervisor that parks while waiting on children or a
  scheduled wake; do not set it on workers (it keeps them in RAM for nothing).

## CLI orientation

- `agentproto sessions` — list/attach/mirror/export/story/stop.
- `agentproto sessions start` — spawn a session from the shell.
- `agentproto sessions wait <id> --until turn-end` — blocking wait (v0.16.0,
  hidden from --help).
- `agentproto models` / `agentproto adapters` — catalogs.
- `agentproto usage rollup` — local spend estimates.
- `agentproto daemon status` — health and configuration.

Golden rule: never wait with a shell sleep-poll loop — blocking waits go
through session_monitor or `agentproto sessions wait` only.
