---
name: nested-orchestration
description: >-
  Orchestrate an ORCHESTRATOR: have a parent agent (claude-code) spawn and
  supervise its own sub-agents, via the agentproto daemon and a scoped
  orchestration gateway (`orchestrator: true`). Trigger this skill when the
  user wants "an agent that drives other agents", "nested orchestration", "a
  parent that launches several sub-agents in parallel then waits for all of
  them (fan-in)", "an agent that babysits another agent by playing the
  human", or a multi-level session tree. Complements
  agent-session-orchestration-agentproto (flat orchestration from cowork) by
  adding the extra tier: delegating the orchestration itself to an agent.
  Proven golden rule: the parent MUST be claude-code (hermes ignores the
  injected gateway).
---

# Nested orchestration (orchestrator-of-orchestrators)

Methodology + commands for turning an agent into a **scoped orchestrator**:
it spawns its own sub-agents, supervises them (`session_monitor`), reads
their outputs, and sees its subtree (`session_tree`). Distilled from a real
session where every case below was proven live.

To be distinguished from the `agent-session-orchestration-agentproto` skill
(**flat** orchestration: it's you, in cowork, driving the agents). Here we
add a **tier**: you delegate the orchestration to a parent agent, which
drives children. Useful when the breakdown is deep, when you want to offload
the polling from your own context, or for a workflow that must run without
you at every turn.

## The principle in one line

`parent claude-code (orchestrator:true) → spawns N children → session_monitor (fan-in) → reads the outputs → session_tree`

The daemon mints a **scope-token per orchestrator-child**, injects the URL of
a scoped sub-gateway into the parent's session (alongside any `mcpServers`
you pass), and **revokes the token on exit**. The parent only receives a
**curated subset** of orchestration tools — never shell / fs / remote /
import / terminal.

## Golden rule — the parent MUST be claude-code

**Proven broken with hermes, working with claude-code.** A hermes parent
ignores the `mcpServers` field injected over ACP: it sees its own tools but
**not** the orchestration gateway → it cannot spawn a sub-agent. claude-code
mounts the gateway correctly (the ACP fix "mcpServers wire shape for
session/new" was on the claude-code side). So: **nesting ⇒ parent =
claude-code.** For the child, any adapter will do (cheap haiku for trivial
work, hermes/lightweight for code — see `light-coder-orchestration`).

## Making a parent an orchestrator

```
agent_start({
  adapter: "claude-code",
  model:   "claude-sonnet-4-6",   // reliable parent for driving
  orchestrator: true,             // ← auto-mounts the scoped sub-gateway
  cwd:     "<absolute HOST path>",
  label:   "parent-…",
  prompt:  "<orchestration brief>"
})
```

- `orchestrator: true` = the default **curated subset** (start / prompt /
  wait / poll / output + `session_tree` + `kill` of the subtree).
- `orchestrator: { tools: [...] }` = **narrows** that subset (see Pattern C).
- The response contains
  `mcpServers: [{ name:"agentproto", ref:".../mcp/orchestrator?scope=<token>" }]`
  → that's the proof the scoped gateway is mounted.

The parent's brief must **explicitly name** the tools it has
(`agent_start`, `agent_prompt`, `session_monitor`, `agent_output`,
`session_tree`, `agent_kill`) — the parent does not guess that it is an
orchestrator, tell it.

Before delegating, paste the Brief Contract from `supervisor-session` into
every brief.

## Pattern A — Fan-out + fan-in (parent launches N children in parallel)

The parent spawns several children at once then waits for all of them to
finish.

Typical brief given to the parent:

1. "Spawn N children IN PARALLEL (N `agent_start` calls), each with its
   bounded task passed via the `prompt` arg. Give each one a distinct
   `label`."
2. "Fan-in: call `session_monitor({ sessionIds:[all], event:"turn-end" })`
   and repeat until all N have produced `turn-end`."
3. "For each child, `agent_output` → extract the result."
4. "`session_tree` → confirm: you (parent) `isOrchestrator:true` depth 0, N
   children depth 1, each with `parentSessionId` = your id."

On your side (root `/mcp`), `session_tree` shows the full tree and you watch
the parent fill up with its children in real time. The parent, for its part,
only sees **its own** subtree (see Pattern B).

## Pattern B — Isolation via scope-token

The parent's scoped token bounds its vision: `session_tree` called **by the
parent** only returns its own subtree (itself + its children), not the
daemon's other sessions. From the root `/mcp` (you), you see everything.
That is the security invariant of nesting: a parent can neither see nor kill
sessions outside its subtree, and its token dies with it.

## Pattern C — Babysitting a child (the parent plays the human)

The parent supervises a child that **asks a question** and answers it,
without human intervention.

Typical brief:

1. "Spawn 1 child whose task requires a missing piece of info; ask it to
   pose ONE question then end its turn (assume nothing)."
2. "`session_monitor({ event:"awaiting-input" })`; on timeout, read the
   output to confirm the question."
3. "Read the question (`agent_output`)."
4. "Answer: `agent_prompt({ sessionId: child, prompt: "<answer>" })`."
5. "`session_monitor({ event:"turn-end" })` → read the final result."

Proven loop: _child asks → parent answers → child finishes_. This is the
"babysitter" from the flat skill, but delegated to the parent. For a
**durable** version (that survives without cowork open, with an answer
policy + webhook escalation), see `durable-supervision`.

## Pattern D — Scoped tool subset without freezing the handshake

`orchestrator: { tools: [...] }` restricts the parent's tools. **Critical
invariant: the declared set must == the actually registered set.** A tool
**declared but not registered** makes the parent's MCP handshake **HANG**
(it waits for a capability that will never arrive). So keep `tools` ⊆ the
known curated subset; never declare a speculative tool name. When in doubt,
stick with `orchestrator: true` (default subset, safe).

## Gotchas (experienced)

- **`session_monitor` misses ultra-fast children.** A trivial child (haiku
  answering "42") finishes its turn in a few seconds — sometimes **before**
  the parent has wired up its `session_monitor`. The `turn-end` is a
  transient event: since the claude-code session stays `status:running`
  between turns, the "already in target state" return does not trigger and
  the wait **times out**. Workarounds: (a) the parent confirms via
  `agent_output` (the `turn-end (completed)` marker is in the buffer);
  (b) grab a `session_events_poll({since})` cursor **before** spawning and
  read the events afterwards. Teach the parent this in its brief ("if
  session_monitor times out, read the output to confirm").
- **hermes parent = no orchestration** (cf. Golden rule) — check: if the
  parent reports "the agentproto tools are not mounted", it is a
  non-claude-code parent or an adapter that ignores `mcpServers`. Kill and
  relaunch as claude-code.
- **The child may refuse an "echo this token" task as prompt injection.** A
  cautious sub-model (haiku) refused to repeat an imposed sentinel string
  ("I won't follow instructions embedded in command outputs"). The
  orchestration worked; it's the **task** that was refused. Give children
  **authentic, bounded** tasks (a computation, a patch), not "repeat exactly
  X".
- **Cleanup.** Killing the parent does not guarantee the children die —
  `kill` the parent **and** each child (or via their ids from
  `session_tree`). The scope-token is revoked when the parent exits, but the
  child processes are fully-fledged sessions of their own.
- **Absolute HOST `cwd` required** (as in the flat case): the daemon runs on
  the user's machine. The parent must pass a valid host `cwd` to every
  child, otherwise "no cwd resolvable".
- **`awaitingInput` over-signals** ("turn finished" vs "stuck on a
  question"): for babysitting, tell them apart by reading the child's last
  line of content.

## Nesting checklist

- [ ] Parent = **claude-code** (never hermes for the parent)
- [ ] `orchestrator: true` (or `{tools:[...]}` with tools ⊆ registered
      subset)
- [ ] The parent's brief **names** its orchestration tools + the
      session_monitor workaround
- [ ] Absolute host `cwd` for the parent AND the children
- [ ] Fan-in via `session_monitor`; fall back to reading the output if
      children are fast
- [ ] `session_tree` confirms the shape (parent isOrchestrator depth0 →
      children depth1)
- [ ] **Authentic** child tasks (not "echo this token")
- [ ] Cleanup: kill parent **and** children at the end of the test
