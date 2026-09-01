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
| pb-build-app | Author, install, and run an agentproto APP. |
| pb-build-pack | Author and import company/agency/knowledge packs. |

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
