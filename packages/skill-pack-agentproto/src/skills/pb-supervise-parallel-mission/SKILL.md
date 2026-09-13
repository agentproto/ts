---
name: pb-supervise-parallel-mission
description: Run N parallel worker agents on disjoint file/topic ownership and fan their results into one verified deliverable. Trigger when supervising - 'I am the supervisor', 'spawn parallel workers', 'fan-in several agents', 'decompose this mission and delegate'.
---

# pb-supervise-parallel-mission — N parallel workers, one result

## Goal

You are the supervisor. Decompose the mission so no two children touch the
same paths, spawn all workers in one batch, fan-in their turn-ends, verify
each result yourself, dispatch targeted fixes, then tear the fleet down and
synthesize the single deliverable you owe.

Prerequisites (reference by name): `ap-spawn-agent`, `ap-wait-fanin`,
`ap-read-output`, `ap-tasks`, `ap-lifecycle`. One worker only: see
`pb-new-agent-session`. A parent that spawns its own children: see
`pb-nested-orchestrator`.

## Steps

### 1. Decompose into disjoint ownership

Split the mission so each child owns a disjoint set of files or topics. Two
children writing the same paths means merge conflicts and blame loops. Write
the ownership down BEFORE spawning — it goes verbatim into each brief.

### 2. Take the cursor FIRST

```
session_events_poll({})
```

Arm the watch before any child exists: events emitted before your first poll
come back immediately with `since`, so a fast child can never slip past.

### 3. Spawn all N in ONE batch

Parallel `agent_start` calls in the same turn, distinct labels, each brief
self-contained:

```
agent_start({
  adapter: 'hermes',
  model: 'z-ai/glm-5.3-flash',
  cwd: '<ABSOLUTE host path>',
  label: 'worker-files',
  access: { profileRef: 'openrouter-env' },
  mcpServers: [{ name: 'agentproto', transport: 'http', ref: 'http://127.0.0.1:18790/mcp' }],
  prompt: '<child brief - see template below>'
})
```

`claude-code` children drop `mcpServers` (native tools are built in). Keep
every returned session id paired with its label.

### 4. Fan-in on turn-end

```
session_monitor({ sessionIds: ['id1', 'id2', 'id3'], event: 'turn-end', since: <cursor>, timeoutMs: 25000 })
```

The monitor returns on the FIRST watched session to fire. Repeat the call
with the fresh cursor until every child has fired.

### 5. Verify each result YOURSELF

A child's "done" is a self-report. Open the files it claims to have written,
run the command it claims passes, compare against the brief. Only your own
check counts as verification.

### 6. Targeted fix-tasks for failures

For each verified failure, re-prompt that child
(`agent_prompt({sessionId, prompt})`) with the exact defect and its ownership
scope — or create a tracked fix with `task_create({title, description})` and
have it claimed. Do not re-decompose the whole mission over one defect.

### 7. Kill children, synthesize

`agent_kill({sessionId})` for every child, then merge the verified outputs
into the single result.

## Child brief template (all three items are mandatory)

1. Tools: the EXACT tool names the child may use (the agentproto tools it may
   call through the mounted gateway, or its native tools for claude-code).
2. Ownership: the exact file paths it may create or edit — and nothing else.
3. This rule, VERBATIM: "Never wait with a shell/terminal sleep-poll loop.
   Use session_monitor for fan-in. A killed poll loop corrupts the session
   permanently."

Add one scope-disclaimer line: the child runs on a shared daemon and the user
may talk to it directly; it must stay inside its ownership and report status,
not drift beyond the brief.

## Gotchas

- The watch is armed at spawn — cursor FIRST, then spawn. The reverse order
  races a fast child.
- The user can talk directly to daemon sessions. Labels plus the disclaimer
  line in the brief keep that from confusing a child.
- An "in-flight prompt" error on a child means it is dead: pull its output
  with `agent_output`/`agent_export`, mark the slot failed, move on.
- Session ids come from the `agent_start` responses — keep them mapped to
  labels; a mix-up means verifying the wrong child.

## Verify

Every child's deliverable exists and passes YOUR check (files read back,
commands re-run), `session_tree({})` shows no leftover children of this
mission, and the synthesized result incorporates only verified pieces. A
child that "reports done" without your verification is not done.
