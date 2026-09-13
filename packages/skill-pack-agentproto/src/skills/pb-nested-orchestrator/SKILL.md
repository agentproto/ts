---
name: pb-nested-orchestrator
description: Spawn a parent agent that spawns and supervises its own sub-agents, forming a two-level tree on the agentproto daemon. Trigger for delegation depth - 'agent that spawns sub-agents', 'two-level agent tree', 'let an agent orchestrate on its own'.
---

# pb-nested-orchestrator — an agent that spawns its own sub-agents

## Goal

Build a two-level tree: you spawn ONE parent; the parent spawns and
supervises its own children through a scoped orchestration gateway; you
inspect the whole tree from the root and tear it all down at the end.

## Golden rule

The nesting PARENT must be adapter `claude-code` or `claude-sdk`. A `hermes`
parent ignores the injected orchestration gateway (proven) and simply cannot
spawn. Children can be any adapter.

Prerequisites (reference by name): `ap-spawn-agent`, `ap-wait-fanin`,
`ap-lifecycle`, and the `drive-agents` group. Single-level supervision is
`pb-supervise-parallel-mission`.

## Steps

### 1. Spawn the parent as an orchestrator

```
agent_start({
  adapter: 'claude-code',
  cwd: '<ABSOLUTE host path>',
  label: 'orch-parent',
  orchestrator: true,
  prompt: '<parent brief - see step 3>'
})
```

`orchestrator: true` mounts a scoped sub-gateway in the parent: a curated
tool subset — start/prompt/wait/poll/output + session_tree + subtree kill —
with a per-child scope token that is revoked when the parent exits.

### 2. Prove the mount

The `agent_start` response carries an `mcpServers` entry whose ref ends in
`/mcp/orchestrator?scope=...`. That entry is the proof the gateway is
mounted. No entry, no nesting: re-spawn with `orchestrator: true` before
briefing further — a hermes parent fails silently here, not loudly.

### 3. Brief the parent to use its tools

The parent brief MUST:

- NAME the orchestration tools it should use (its mounted gateway's
  start/prompt/wait/poll/output plus session_tree and subtree kill).
- FORBID shell poll loops, verbatim: "Never wait with a shell/terminal
  sleep-poll loop. Use session_monitor. A killed poll loop corrupts the
  session permanently."
- Give children authentic, bounded tasks (see gotchas) with disjoint
  ownership and absolute `cwd`s — the same brief discipline as
  `pb-supervise-parallel-mission`, one level down.

### 4. Watch the tree grow from the root

From YOUR session:

```
session_tree({})
```

The parent shows `isOrchestrator: true` at depth 0; its children appear at
depth 1 with `parentSessionId` pointing at the parent. Re-poll as the parent
works. Scope isolation: the PARENT's own session_tree sees ONLY its subtree —
it cannot enumerate your other sessions.

### 5. Collect and tear down

When the parent's final turn ends, verify its deliverable yourself, then kill
the PARENT AND the CHILDREN — `agent_kill({sessionId})` for each id from
`session_tree({})`. Killing the parent alone leaves orphans in the tree.

## Narrowing the tool subset (optional)

`orchestrator: { tools: ['agent_start', 'agent_output'] }` narrows the
curated subset. Constraint: the DECLARED set must equal the REGISTERED set of
the daemon's orchestration gateway — a declared-but-unregistered tool makes
the parent's MCP handshake HANG forever (a silent, undebuggable stall). When
unsure, use `orchestrator: true` and take the default curated subset.

## Gotchas

- hermes parent = no nesting and no error, just a parent that chats. Catch it
  at step 2 (missing orchestrator mcpServers entry), not after ten minutes.
- Children get authentic, bounded tasks. A cautious child model refuses
  sentinel tasks like "repeat this token every turn" as prompt injection —
  give real work with a real deliverable.
- Absolute `cwd` for the parent AND for every child the parent spawns — put
  that requirement in the parent brief verbatim.
- The scope token is revoked at parent exit: after the parent dies, its
  gateway tools are dead. Read its transcript with `agent_export` if you need
  the detail afterwards.

## Verify

`session_tree({})` shows the parent (isOrchestrator, depth 0) plus children
(depth 1, parentSessionId set); each child produced a real deliverable you
verified; after teardown the tree lists NO member of this subtree. The
parent's `agent_start` response containing the `.../mcp/orchestrator?scope=`
mcpServers entry is the proof the nesting channel existed at all.
