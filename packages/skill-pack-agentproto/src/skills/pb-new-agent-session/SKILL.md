---
name: pb-new-agent-session
description: Spawn one worker agent on the agentproto daemon, drive it with a brief and follow-ups to a verified result, then tear it down cleanly. Trigger when delegating a single task - 'spawn an agent', 'delegate this to a worker', 'run an agent to completion', 'drive an agent session'.
---

# pb-new-agent-session — spawn a worker and drive it to a result

## Goal

One delegated task, one session: pick the adapter and model, spawn the worker
with a self-contained brief, wait for its turn to end, read and verify the
result, then kill the session so the tree stays clean.

Prerequisites (reference by name, not re-explained here): `ap-spawn-agent`,
`ap-read-output`, `ap-wait-fanin`, `ap-lifecycle`, `ap-models-auth`,
`ap-adapters`. The family map is the `agentproto` skill; the cheap-model
picking guidance lives in the `cheap-coders` group.

## Steps

### 1. Pick the adapter and model

- Cheap bulk work: `hermes` + `z-ai/glm-5.3-flash`, billed through the
  `openrouter-env` access profile. Note: hermes has NO built-in file/shell
  tools.
- Work that must edit files or run commands natively: `claude-code` (Read,
  Write, Bash, Edit are built in — no gateway mount needed).
- Check what is installed before choosing (adapter listing from
  `ap-adapters`); model eligibility and access profiles go to
  `ap-models-auth`.

### 2. Take the event cursor BEFORE spawning

Grab a cursor first so the spawn event cannot slip past your wait:

```
session_events_poll({})
```

Use the returned `nextCursor` in every later `session_monitor` call. Events
emitted before this first poll are returned immediately with `since`, so the
ordering is race-free.

### 3. Spawn with a self-contained brief

The child knows nothing about your conversation — put paths, constraints,
deliverable, and done-criteria in the prompt:

```
agent_start({
  adapter: 'hermes',
  model: 'z-ai/glm-5.3-flash',
  cwd: '<ABSOLUTE host path>',
  label: 'worker-audit',
  access: { profileRef: 'openrouter-env' },
  mcpServers: [{ name: 'agentproto', transport: 'http', ref: 'http://127.0.0.1:18790/mcp' }],
  prompt: '<self-contained brief: goal, exact file paths, constraints>'
})
```

For `claude-code`, drop `mcpServers` (native tools) and keep the rest. The
call returns the session id — keep it with the label.

### 4. Wait for the turn to end

```
session_monitor({ sessionIds: ['<sessionId>'], event: 'turn-end', since: <cursor>, timeoutMs: 25000 })
```

A long task spans several turns: repeat the monitor, feeding back the latest
cursor each time. If nothing seems to be happening,
`agent_output({sessionId, lastN: 200, clean: true})` shows the last thing it
said — quiet usually means mid-turn, not stuck.

### 5. Read the result

- Quick tail: `agent_output({sessionId, lastN: 200, clean: true})`.
- Full transcript, readable even after the session stopped:
  `agent_export({sessionId})`.

### 6. Follow up, or tear down

Send corrections with `agent_prompt({sessionId, prompt})` — it rejects while
a turn is still in flight. When the deliverable is verified and no more turns
are needed: `agent_kill({sessionId})`.

For a scripted wait outside the daemon API, the CLI
`agentproto sessions wait <id> --until turn-end` runs as a background terminal
with completion notification (v0.16.0; 15-minute default) — see
`ap-wait-durable`.

## Gotchas

- `cwd` must be an ABSOLUTE host path — a relative one fails or lands the
  worker somewhere unintended.
- A `hermes` worker without the agentproto gateway mounted can only chat: no
  files, no shell. Mount the mcpServer or switch to `claude-code`.
- Always set a `label` — the user sees labels in the sessions tree and needs
  to know who is who.
- Kill the session when done. An idle session burns nothing, but it lingers
  forever and clutters the tree.
- Never wait with a shell/terminal sleep-poll loop; use `session_monitor` or
  the CLI `sessions wait`.

## Verify

`session_tree({})` no longer lists the session (it was killed), and the
deliverable it produced exists on disk or answers the brief — checked by YOU,
not taken from the worker's own "done" claim. During the run, proof of
progress is `agent_output` showing real tool calls, not just text.
