# Tool hooks & enrichers

Status: **design — docs only, no code landed yet.**
Scope: agentproto daemon (`packages/runtime`), English docs.

**Where the AIP prose lives.** Citations of the form `specs/aip-*.mdx`
below refer to the canonical **`agentproto/agentproto`** repository — the
prose registry — and *not* to this tree (`agentproto/ts` carries only the
`specs/resources/**` JSON drafts). Read them there: clone it as a sibling
(`git clone https://github.com/agentproto/agentproto ../agentproto`) or
through `gh api repos/agentproto/agentproto/contents/specs`. Every AIP
citation in this doc was verified against that repo's prose.

---

## Existing (field survey)

Three hook mechanisms already run today, in three different places. This
design is deliberately made of their reusable parts, and of no new
vocabulary.

### 1. Simone's tool hooks (Mastra) — the in-the-loop pattern

> **Note on sources:** the `agentik-studio` repo (which hosts Simone) is
> private — `git clone --depth 1` fails with `Repository not found` for the
> token this session runs with, so **we could not read our own code here**.
> The description below is reconstructed from Mastra's public docs
> (mastra.ai, `Agent.hooks`, "@mastra/core ≥ 1.49", tool hooks shipped
> 2026-07, PR #17637); anything Simone does locally and invisibly in those
> docs must be re-verified by someone with read access.

Mastra gives an agent-level two-point hook around **every** tool call the
agent makes (assigned tools, memory tools, toolsets, client tools, workspace
tools alike):

- `beforeToolCall({ toolName, input, context, metadata })` runs just before
  the tool executes; it can return `{ proceed: false, output }` to **skip
  the call entirely** and hand the agent a synthetic result — that is a
  *gate*.
- `afterToolCall({ toolName, input, output, error })` runs after the call,
  success or failure, and cannot alter the outcome (errors are re-thrown
  after it runs).
- Tool-level hooks (`onInputStart` / `onInputDelta` / `onInputAvailable` /
  `onOutput`) observe streaming stages; per-execution hooks passed to
  `generate()` / `stream()` override agent-level hooks per key.

**What we reuse:** the *two points* (before / after a tool call) and the
never-fail-the-loop posture. The event shapes map cleanly onto our
`ToolHookEvent` (`toolName`/`input` → `on`/`args`, `output` → `$result`).

**What we do NOT reuse:** the placement. Mastra's hooks live *inside the
agent loop* of one adapter (one `Agent` instance — the shape Simone would
plug into). Our hooks must live **below any adapter, at the daemon's MCP
server surface**: one implementation covers opencode, Mastra, Claude Code
and any other client, and enrichment output routes through the *daemon's*
session objects (prompt queue, inbox slices, task meta), which an in-loop
hook cannot reach. So: pattern yes, seam no — the same before/after shape is
threaded through the registration-time server proxy (`withToolHooks`, §1
and §9.1) instead.

### 2. Claude Code native hooks — PreToolUse / PostToolUse

Claude Code fires `PreToolUse` **before** the agent invokes a tool (it can
block the operation, require approval, or modify the tool input) and
`PostToolUse` **after** the tool completes successfully (formatters,
logging, follow-up actions). Hooks are declared declaratively in settings
(`hooks: { PreToolUse: [{ type: "command", command: "…" }] }`), and each
hook process receives a JSON payload on stdin (`timestamp`, `cwd`,
`tool_name`, tool input…) — shell commands run by the client, synchronously,
per matching tool. Other hook points (`PreCompact`, …) cover session
lifecycle rather than tool calls.

**What we reuse:**

- the **declarative config posture**: our `hooks` block in
  `~/.agentproto/config.json` (§2.7) is the same "declare matchers, the host
  runs the logic" arrangement, with per-hook `enabled` and a hot kill
  switch matching Claude Code's toggleable hooks;
- the **matcher shape**: "this tool name / this input area" is the degenerate
  form of our `match` spec (AIP-60 clause shape, §2.2) — strictly more
  expressive;
- the **out-of-band delivery stance**: Claude Code's `PostToolUse` output
  reaches the model without being asked for — the same route our three
  `deliver` arms (§2.5) formalize as queue / context-slice / meta.

**What we do NOT reuse:** the execution model. Claude Code hooks are user
scripts run per-tool, synchronously, able to block or rewrite input — exactly
the AIP-40 sandbox problem (§8: user-authored code waits for a sibling AIP).
v1 hooks are config entries whose `run` names a daemon-bundled enricher; no
third-party script runs, and the only blocking is the bounded `sync` mode
(§2.4).

### 3. This daemon's own policies and gates — policy_attach

`policy_attach` / `policy_status` / `policy_list` / `policy_cancel`
(`packages/runtime/src/orchestration-tools.ts`, documented in
`docs/cli/verbs/policy.md`) are the daemon's existing gate system: a
completion policy attached to one or several sessions, with a gate that is
either a **shell check** (exit 0 = pass) or a **judge agent**, `onFail`
nudge+retry, subtree-scoped targets, and `policy:passed` / `policy:failed`
events on the session event bus.

Reading it against this design:

- the gate fires at **turn end** and blocks there — deliberately *not* the
  seam for enrichment (§0's row three; §1's verdict row reaches the same
  conclusion from the other side);
- it targets a session or subtree, never a tool call, and has no
  run-then-deliver-elsewhere concept.

**What we reuse:**

- the **judge-gate form** as the precedent for "one model pass producing a
  bounded verdict" — our optional summary step (§3.2 step 7) is the same
  animal without the verdict semantics;
- the **event pair** (`policy:passed`/`policy:failed`) as the model for
  `hook:ran` / `hook:skipped` (§4-R8) — same bus, same best-effort contract;
- the **opt-in, config-block, off-by-default** posture that `policy_attach`
  shares with `titler` (§1).

**What we do NOT reuse:** the blocking contract and turn-end timing. A hook
never holds a turn (R1) and never ends it (R2-R3): a failing hook is skipped
and logged, never retried and never escalated.

### What we reuse — one sentence

From the field: the before/after two-point shape (Mastra/Simone), the
declarative-config + matcher shape (Claude Code, hardened into AIP-60
clauses), and the event-pair observability + judge-pass + opt-in-config
shape (this daemon's policies). None of the in-context execution models, and
no blocking contract. The internal primitives these shapes thread into are
listed in §1.

---

## 0. The problem this solves

An orchestrator (the Pygmalion brain) delegates work to agents without first
checking what already exists in the workspace. It re-launched, as a "new
feature", work that had already been merged five days earlier. Three
non-solutions were rejected up front:

| Non-solution | Why not |
|---|---|
| A prompt rule ("always check for prior art") | Prompts are advisory; agents forget, and a rule that only *sometimes* holds is worse than no rule. |
| A reviewer agent on every message | Far too many tokens per delegation — the cost scales with traffic, not with risk. |
| Blocking the tool call until enrichment returns | Makes every `agent_start`/`agent_prompt` slow, and turns an enricher failure into a failed delegation. |

What is wanted instead: a **generic, configurable tool-hook system inside the
daemon**. Hooks attach to chosen MCP tools (`agent_start`, `agent_prompt`,
`task_create`, `delegate`) or to lifecycle events, and run **enrichers**
automatically, **asynchronously**, delivering their output somewhere useful
*after* the tool call has already returned.

The first enricher is `prior-art`: deterministic searches (zero tokens) that
produce a short « Existing work detected » block and land it in the spawned
session's queue a few seconds after start — steered into turn 1 when the
adapter supports steering, at the next natural turn boundary otherwise (§2.5)
— so the agent answers **modify existing** or **new** before it commits to a
design, ideally as its first step.

---

## 1. What exists today, and what we reuse

Nothing here should be built twice. Every row below was read before this
design was written; the "verdict" column is the reuse decision.

| Mechanism | What it already does | Verdict for this design |
|---|---|---|
| **Tool-registration proxies** — `withToolSubset` / `withToolExclusion` (`packages/runtime/src/tool-subset.ts`), `withDeferredTools` (`packages/runtime/src/deferred-tools.ts`) | `Proxy` around the MCP server that intercepts `server.tool(...)` / `server.registerTool(...)` registration: today it **gates** (drop/allowlist) or **records** (`name`, `description`, `inputSchema`) — never yet a wrapped callback, but both pass `...rest` straight through, so the trailing argument *is* the handler. Proven to survive the stateless, per-request `mcpServerFactory` model. | **Reuse the seam, one step further.** `withToolHooks(server, dispatcher)` is the same `Proxy`: same two entry points, same `...rest` forwarding — but it pops the trailing handler, wraps it, and forwards. (Alternative considered: wrapping the SDK's single `tools/call` request handler instead — one place for every tool, but it sits below registration, so scoping to daemon tools and reading registration metadata gets harder. Registration-time wins.) |
| **Daemon-side fire-and-forget enricher** — `maybeTitleSession` (`packages/runtime/src/session-titler.ts`) | Opt-in config block (`titler: { enabled, model }`, default off), once-only in-memory guard set *before* any `await`, every failure degrades to a logged no-op, seams injected for tests. | **Reuse the contract, verbatim.** This is the template for an enricher run: never throws, never blocks the turn that triggered it, default-off. |
| **Background job registry** — `createBackgroundJobRegistry` (`packages/runtime/src/background-jobs.ts`) | Module-scope job map + on-disk result files, specifically because a fresh `McpServer` is built per request and a registry created inside `register*` would be invisible to the next connection. | **Reuse the statelessness rule** for hook/dedup state: dispatcher and dedup sets live at module scope, not inside the registration closure. |
| **Prompt queue** — `registry.enqueuePrompt(id, msg, opts)` (`packages/runtime/src/sessions.ts`, the `enqueuePrompt` arm) with `queue`, `steer`, `coalesceKey`, `deliverWithinMs`, `deliverVia` | FIFO queue behind an in-flight turn; `coalesceKey` replaces a waiting item in place instead of stacking a second one; optional steer into the running turn when the adapter supports it. | **This is `deliver: append-to-session-queue`.** Call it directly — no new queue. `coalesceKey` is the dedup for the queue arm. |
| **Turn-start context slices** — `renderInboxDigest` (`packages/runtime/src/session-message.ts`) applied at `packages/runtime/src/sessions.ts` in `runAgentTurn` (the `fyi` digest, the interrupt notice, `pendingResumeContext`) | Text prepended to the *next* turn as a `system-prompt` slice (never glued into the human's text), once per item, string-turns only. | **This is `deliver: prepend-to-prompt`.** Same slot, same once-per-item bookkeeping. |
| **Task meta** — `task_create`'s `meta: Record<string,string>` input and `task_update`'s `note → meta.note` (`packages/runtime/src/task-tools.ts`), internal `setMeta` helper in `packages/runtime/src/task-ledger.ts` | Free-form provenance on a task, last-write-wins per key, persisted with the ledger, emits `task:changed`. | **This is `deliver: attach-to-task-meta`**, via one new internal ledger verb (§2.5) — a namespaced key (`hook:prior-art`) is naturally idempotent. |
| **`session_follow`** (`packages/runtime/src/session-follow-tools.ts`, `FOLLOW_EVENTS` in `packages/runtime/src/session-follow-store.ts`) | Declarative `selector` / `exclude` / `events` / `batchMs` coalescing — "wake me when X matches, digest bursts into one notice, never interrupt a busy follower". | **Reuse the vocabulary for `match`** (selector-style clauses + burst coalescing). Not a delivery path: it wakes the *follower*, we push into the *target*. |
| **`session_queue_deliver` / `session_queue_promote`** (`packages/runtime/src/session-tools.ts`) | Deliver-now (interrupt) and promote-to-front of a queued prompt. | **Explicit non-goal.** A hook never interrupts. These names exist in this doc only to say we do not use them; `session_queue_list` is reused for observability. |
| **`policy_attach` / completion policies** (`packages/runtime/src/supervisor.ts`, `orchestration-tools.ts`, `docs/cli/verbs/policy.md`) | Turn-**end** gates: shell/judge verdict, `next` chaining, fan-in, `onFail` nudge+retry, `policy:passed`/`policy:failed` bus events. | **Wrong seam for enrichment** (it fires after a turn, not at delegation time) and deliberately blocking. **Reuse**: the judge-gate form as the precedent for "a model pass with a verdict", and the policy event pair as the model for hook observability events. |
| **AIP-46 events & messages** (canonical repo `agentproto/agentproto` — `specs/aip-46.mdx`; impl `packages/runtime/src/sessions.ts`, `session-message.ts`, `http-server.ts`) | Prompt queue semantics, typed `SessionMessage` envelope, delivery tiers `fyi \| next-turn \| steer \| interrupt`, bounded durable inbox, attestation + delimiter escaping. | **Reuse for delivery**: append-to-session-queue rides the queue; prepend-to-prompt rides the `fyi` slice; the envelope/attestation rules tell us how to render enrichment text safely. |
| **AIP-41 routines** (`packages/routine/src`, `packages/runtime/src/routine-registrar.ts`) | `ROUTINE.md` frontmatter: `schedule: {kind: "cron"\|"interval"\|"calendar"\|"manual"\|"event", on, filter}` + `target: action\|agent\|workflow\|tool`. | **Reuse the shape, not the dispatcher.** `schedule.kind:"event"` validates but only `cron` fires today (`routine-registrar.ts:232`), and a routine `target` has no `deliver` concept. v1 hooks are config-declared and dispatched in-process; the routine/event path is the future declarative home (§8). |
| **AIP-37 LIFECYCLE vocabulary** (canonical repo `agentproto/agentproto` — `specs/aip-37.mdx`) | Standard event names incl. `tool-call` (before), `tool-result` (after), `tool-error`; hosts MAY fire extra namespaced (`<host>:<event>`) names; events are best-effort, configs MUST tolerate never firing. | **Reuse for `on`.** No new event names required. |
| **AIP-42 AGENT.md `on:` hooks** (canonical repo `agentproto/agentproto` — `specs/aip-42.mdx`) | `on: {<AIP-37 event>: [action-ref…]}`; "Errors in hooks are logged but do NOT abort the conversation." | **Reuse the semantics**: best-effort, error-contained. This is the normative backing for our "never fail the tool call" rule. |
| **AIP-60 SENTINEL `match`** (canonical repo `agentproto/agentproto` — `specs/aip-60.mdx`) | `SentinelSpec.match`: array of `{subject, types?}` clauses, OR across clauses, prefix + glob semantics. | **Reuse the clause shape** for `match`, extended with tool-arg predicates (sentinel subjects are external objects; ours are tool args). |
| **AIP-68 clerk watch core** (canonical repo `agentproto/agentproto` — `specs/aip-68.mdx` §5) | Out-of-band, never-wake, single-flight + debounce, bounded passes, **free-tier-first** model budget (`budget.max_llm_calls_per_pass`, `budget.max_cost_usd_per_day`), refusal when no free route exists. | **Reuse the async + budget contract wholesale** — it is the same problem with a different trigger. |
| **`workspace_brain_query`** (`packages/runtime/src/brain-tools.ts`, `packages/workspace-brain/src`) | BM25 keyword search over ingested transcripts, per workspace bucket, zero tokens. | **This is the memory search** for `prior-art`. |
| **`gh` / `git` runners** — `execGh` (`packages/runtime/src/review-pr.ts`), `git(...)` in `review-worktree.ts`, allowlist for the *tool* path (`packages/runtime/src/command-tools.ts`) | Daemon-side `execFile` runners with timeouts; the MCP `command_execute` allowlist governs agent-invoked commands, not daemon-internal ones. | **Reuse `GhRunner` (injectable) and the `execFile`+cwd-anchored pattern.** |
| **`agentproto hook`** (`docs/cli/verbs/hook.md`) | A **Claude Code client-side** hook command that pulls the AIP-46 inbox. | **Name collision only** — unrelated mechanism. Config namespace is `hooks`, CLI (if any) is `agentproto hooks`. |
| **Free model roles** (`packages/runtime/src/model-roles.ts`) | Presets incl. `go-free` → `opencode-go/longcat-2.5-preview-free`; entries carry an optional `route` hint (`route: "openrouter"`) and `resolveLlmModelRoute` decides how a model is reached. | **The free-model *catalogue*** — it says which model counts as free and through which route. The call itself rides the titler's OpenRouter fetch, because `@agentproto/runtime` has no inference client (see the `summarize-session-tool.ts` header). An adapter-spawned "free" model (the `go-free` preset) is **rejected** for hooks — spawning an agent per hook is the expensive path. |

**The gap none of these fill:** a single place that says *"when **this** tool
is called with **these** args, run **this** enricher in the background and
put its output **there**"*. That is the new thing — a dispatcher, not a new
queue, not a new event system.

---

## 2. Model

```ts
interface ToolHook {
  id: string                       // stable, kebab-case, unique per config
  on: OnRef                        // what fires it
  match?: MatchSpec                // optional narrowing filter
  run: string                      // enricher id from the registry
  mode?: "async" | "sync"          // default "async"; v1 installs the async path only (§2.4)
  deliver: DeliverSpec             // where the block goes
  delayMs?: number                 // default 0; prior-art uses ~4000
  dedup?: DedupScope               // "task" | "session" | "none", default "task" (§4-R4);
                                   // §10.1 extends the set with "subject" for external triggers
  budget?: Budget                  // default: { timeoutMs: 20000, maxLlmCalls: 0 }
  enabled?: boolean                // default true when the block is present
}
```

### 2.1 `on` — the trigger

An `OnRef` is one of:

| Form | Fires | Result available? |
|---|---|---|
| `"agent_start"` \| `"agent_prompt"` \| `"task_create"` \| … | **After that tool's handler returns successfully** (a named-tool trigger is post-success by definition — that is where `$result` lives). | yes (`$result`) |
| `"tool-call"` | Around invocation for *any* tool (AIP-37's "before a tool is invoked"), narrowed by `match.tools`. | no |
| `"tool-result"` \| `"tool-error"` | After any tool returns success / error (AIP-37). | yes / yes |
| `"session:spawned"` \| `"task:changed"` \| `"session:turn-end"` … | When that daemon bus event fires (`SessionEventType`, `packages/runtime/src/session-event-bus.ts`). Same dispatcher, different feed. | event payload |

Named-tool triggers must be members of `DAEMON_TOOL_NAMES`
(`packages/runtime/src/daemon-tool-names.generated.ts`); anything else is a
config error reported at load.

`delegate` is not a distinct daemon tool name in this repo — a delegation *is*
an `agent_start` / `agent_prompt` from a session that holds a supervisor role
(`packages/runtime/src/role.ts`, `DELEGATION_TOOL_NAMES`). A hook that says
"on: agent_start, match: caller.role = supervisor" **is** the delegate hook.
(If a future AIP spells `delegate` as its own verb, `OnRef` takes it without
schema change.)

### 2.2 `match` — the filter

```ts
interface MatchSpec {
  tools?: string[]                 // OR-list of tool names
  args?: Record<string, unknown>   // subset match against the call args
  argsText?: string[]              // ALL of these substrings (case-insensitive)
                                  // must appear somewhere in the prompt-ish args
  caller?: { sessionId?: string; id?: string; role?: string
             label?: string; depth?: number; agentId?: string }
  result?: Record<string, unknown> // subset match against the tool result (post-call hooks only)
  workspace?: string               // workspace slug the call resolves to
}
```

Semantics follow AIP-60: **AND across fields, OR inside a field's list**;
absent field = no constraint. `label`/`argsText` accept `*` globs. The whole
spec is evaluated against one plain object:

```ts
interface ToolHookEvent {
  on: string                       // resolved trigger name
  args: Record<string, unknown>
  result?: Record<string, unknown> // PARSED tool result (see §2.5) —
                                  // e.g. agent_start → { id, cwd, … }
                                  // (the body IS the flattened descriptor,
                                  //  agent-tools.ts:553-561 — no `descriptor` wrapper)
  caller?: { sessionId?: string; id?: string; label?: string
             role?: string; depth?: number; agentId?: string }
  workspaceSlug?: string
  ts: string
}
```

**How `caller` is filled (the only non-literal part of `match`).** No
descriptor carries a role field today — `SessionDescriptor` has `depth`
(`sessions.ts`, always recorded `?? 0`) and, for AIP-42 manifest callers, a
`meta.agentId` / `meta.agentManifestPath` / `meta.agentRoleHash` triple
written at spawn (`session-spawn.ts`). The dispatcher therefore derives
`caller` in three steps, all reusing code that already exists:

1. `sessionId`, `label`, `depth` — straight off the caller descriptor.
2. `agentId` — `caller.meta.agentId`, the daemon-resolved AIP-42 manifest
   identity ("trusted because the daemon resolved it at spawn"). This is the
   field a Pygmalion-style allowlist should actually match on.
3. `role` — resolved with `resolveRole(explicit, depth, cutoff, registry)`
   (`role.ts`), the *same* function spawn uses: `explicit` comes from
   `OrchestratorScope.role` when the call arrived through the orchestrator
   sub-gateway ("the resolved role of the SPAWNING session"), otherwise
   omitted so the depth-derived default applies. Because that same cutoff is
   used at spawn (`session-spawn.ts` `resolveRole(input.role, childDepth,
   …)`), hook-time role ≡ spawn-time role for every depth-derived session.
   Explicitly-passed spawn roles that were never persisted cannot be
   re-derived — for those, match `label` / `sessionId` / `agentId` instead
   (the v1.1 config does exactly this; §7).

Matching is pure and synchronous (no I/O) — a `match` that throws is a config
error, reported once at load, not at call time.

### 2.3 `run` — the enricher

A name in the **enricher registry** (`prior-art` at §3). Unknown id ⇒ hook
skipped with a `hook:skipped` bus event; never a tool error. Enrichers are
registered in code (daemon-bundled) in v1; a config-declared *enricher* body
is deliberately out of scope (it would be remote code execution by JSON —
see §8 for where user-authored hooks belong).

### 2.4 `mode`

| Mode | Behaviour | Used by |
|---|---|---|
| `async` (default) | Dispatcher fires and returns; the tool call's own result is never awaited on it. Enrichment lands `delayMs` later. | `prior-art`, `spec-echo`, `security-check`. |
| `sync` | Dispatcher awaits the enricher, bounded by `budget.timeoutMs` (clamped ≤ 2000 ms), and folds the block into the tool's own response. Failure/timeout ⇒ the block is simply absent. | Only `attach-to-task-meta` shapes where the caller must see the meta in the same response — and only post-v1 (§7); no v1 consumer needs it. |

`sync` never *fails* the tool call either — it can only make it ≤2s slower in
the worst case. The brief's "without blocking the tool call" is therefore
`async` for everything on the spawn/prompt path; `sync` exists for the meta
case and is documented as the bounded exception.

**v1 installs the `async` path only.** The `sync` arm is fully specified
here and in the §9.2 interface, but the v1 `withToolHooks` wrapper (§9.1)
never awaits hook work: no v1 delivery arm's consumer reads enrichment from
the tool's own response — all three arms are out-of-band by R6 — so a
blocking-shaped code path would ship unused and invite configs that slow
delegations for nothing. A v1 config that sets `mode: "sync"` is therefore
**refused at load** (same posture as an unknown `deliver.to`, §4-R6), not
silently downgraded. The named trigger for installing the sync branch is in
§7's post-v1 table.

### 2.5 `deliver` — the three arms

| Value | Primitive reused | When |
|---|---|---|
| `append-to-session-queue` | `registry.enqueuePrompt(target, text, { queue: true, origin: "hook:<hookId>", coalesceKey, steer: true })` — **no `interrupt`, and deliberately no `deliverWithinMs`** (see the sweep note below) | Default for spawn/prompt hooks: lands after (or steered into) the target's first turn. |
| `prepend-to-prompt` | `registry.sendMessage({ to, body, urgency: "fyi", … })` — the AIP-46 `fyi` tier: it **never wakes** the session, sits in `desc.inbox`, and the next string turn flushes it once as a `system-prompt` slice via `renderInboxDigest` (never glued into the human's text) | When the block must be *context*, not a user-visible message, and must not start or steer a turn. Note the flush lands on the **next** string turn — a 4 s hook always misses turn 1, so only a hook on `session:spawned` (the spawn-time window, before the initial prompt dispatches — an ordering check for the implementation) can put context in turn 1 itself. |
| `attach-to-task-meta` | A new `TaskLedger` verb — `setMeta(taskId, key, value, caller)` — modeled on the ledger's existing internal wiring verb `linkApproval` (no `rev` / no CAS, idempotent, last-write-wins, emits `task:changed`). Needed because today only `TaskCreateInput.meta` accepts arbitrary `Record<string, string>`; `TaskUpdateInput` exposes just `note → meta.note` (`task-ledger.ts`). | `task_create` / `task_update` hooks: provenance rides the task record and `task:changed`. |

**The sweep trap.** `enqueuePrompt`'s `deliverWithinMs` lets the
pending-prompt sweep force a queued item out, and that force follows
`deliverVia`, whose default is `auto` = *steer, else **interrupt***. A hook
that set a deadline would therefore reintroduce exactly the interruption
this design forbids. v1 hooks never set `deliverWithinMs`; if a deadline is
ever added, it must be paired with `deliverVia: "steer"` so a non-steerable
recipient simply keeps the item queued until the turn ends naturally.

Target selection is a tiny binding expression over the event, so one hook
shape works for every tool:

```yaml
deliver:
  to: append-to-session-queue
  sessionId: "$result.id"          # spawned child (agent_start — the body is the
                                   # flattened descriptor, agent-tools.ts:553-561)
  # sessionId: "$caller.sessionId"     # push back to the delegator
  # taskId:    "$result.task.taskId"   # attach-to-task-meta (task_create)
  # taskId:    "$args.taskId"          # attach-to-task-meta (task_update)
```

`$…` paths resolve against `ToolHookEvent`; an unresolvable path ⇒ delivery
skipped (event logged), never an error.

**`$result` is the *parsed* payload.** These handlers return MCP wire
results — `agent_start` → `{ content: [{ type: "text", text: JSON.stringify(body) }] }`
where `body = { ...result.descriptor, output?, warnings?, deduped?,
dedupeSource?, costBudgetPolicyId? }` (`packages/runtime/src/agent-tools.ts:553-561`:
the handler **spreads the descriptor into the body**, so the parsed `$result`
*is* the flattened descriptor — `{ id, cwd, … }` — with **no `descriptor`
wrapper**; the module comment documents the return the same way,
`agent-tools.ts:120`), `task_create` → `{ content: [{ text: "{ task: … }" }] }`
(`task-tools.ts` `writeResultContent`) — with no `structuredContent`. The
dispatcher therefore sets `result` to `structuredContent` when the tool
returns one, else JSON-parses the first text item, else leaves it
`undefined` (so `$result.*` simply fails to resolve → delivery skipped,
logged). That is what makes `$result.id` (agent_start's flattened
descriptor) and `$result.task.taskId` (task_create) work as written — and
why `$result.descriptor.id` would silently resolve to nothing.

### 2.6 `budget`

```ts
interface Budget {
  timeoutMs?: number        // hard wall clock per run; default 20000, max 60000
  maxLlmCalls?: number      // default 0 = deterministic only
  maxTokens?: number        // per LLM call; default 0 (unset ⇒ enricher default)
  maxCostUsd?: number       // optional day-window cap, AIP-68 style
  model?: string | "free"   // "free" ⇒ a free OpenRouter route from model-roles
                            // (route hint, `:free` id) — never an adapter-spawned model
}
```

### 2.7 Where it is declared

**(a) Daemon config — primary, shipped first.** `~/.agentproto/config.json`:

```jsonc
{
  "hooks": {
    "enabled": true,
    "hooks": [
      {
        "id": "prior-art-on-delegation",
        "on": "agent_start",
        "match": { "caller": { "role": "supervisor", "label": "pygmalion*" } },
        "run": "prior-art",
        "mode": "async",
        "delayMs": 4000,
        "dedup": "task",
        "deliver": { "to": "append-to-session-queue", "sessionId": "$result.id" },
        "budget": { "timeoutMs": 20000, "maxLlmCalls": 1, "maxTokens": 400, "model": "free" }
      }
    ],
    "enrichers": {
      "prior-art": { "keywords": 8, "prWindowDays": 30, "maxBlockLines": 15, "summary": "auto" }
    }
  }
}
```

Wiring follows the existing config machinery: a `hooks` top-level block in
`agentprotoConfigSchema` (`packages/runtime/src/config-schema.ts`), a matching
`AgentprotoConfig.hooks` field in `config.ts`, and `CONFIG_KEYS` entries
(`path: "hooks.enabled"`, `path: "hooks.hooks"`, `apply: "hot"`, `writable: true`
— a hook edit takes effect on the next call, like a spawn-time key), plus
`"hooks"` added to the `ConfigKeySection` union (the same union
`config-tools.ts` iterates when it lists sections) so `config_get` / `config_set`
can address the block like any other. Forgetting a `CONFIG_KEYS` entry fails
the existing `findUnclassifiedConfigPaths` drift test
(`__tests__/config-schema.test.ts`), so the block cannot go unclassified.

**(b) An AIP-shaped doc — optional, second.** `<workspace>/.agents/hooks/HOOK.md`
with frontmatter `schema: "hook/v1"` (same markdown+frontmatter posture as
`ROUTINE.md` / `AGENT.md`), merged **over** the daemon config for that
workspace. It is pending, not canonical: the JSON draft would land at
`specs/resources/pending/hook/draft/HOOK.schema.json`, beside
`specs/resources/pending/memory/draft/MEMORY.schema.json` — no AIP number is
consumed, and no generated file is hand-edited (the regen rule in
`AGENTS.md` applies the moment a package owns that doctype).

Precedence: **workspace doc > daemon config > built-in defaults.** A hook id
present in both is replaced, not merged field-by-field.

---

## 3. First enricher: `prior-art`

Goal: after a delegation, within a few seconds, the spawned session's queue
holds a ≤15-line block that makes "we already did this" impossible to miss.

### 3.1 Input

```ts
{
  promptText: string        // the delegated prompt (agent_start.prompt / agent_prompt.prompt / task description)
  workspaceRoot: string     // target cwd/ground of the spawn
  workspaceSlug?: string
  taskId?: string           // for dedup + meta attach
  targetSessionId?: string  // delivery target
}
```

### 3.2 Pipeline (all deterministic unless step 7 opts in)

| # | Step | How | Cost |
|---|---|---|---|
| 1 | **Keywords** from the delegated prompt | Pure function: strip stopwords + code punctuation, keep tokens ≥3 chars, prefer quoted spans / `snake_case` / `camelCase` / `kebab-case` identifiers and Title-ish nouns, dedupe, cap at 8. No LLM. (Free model permitted as an *optional* re-ranker; off by default.) | **0 tokens** |
| 2 | **`git grep` in the target workspace** | `execFile("git", ["grep","-n","-I","--fixed-strings","-e",k1,"-e",k2,…,"--","*.ts","*.md","*.json"], { cwd: workspaceRoot, timeout })` — cwd anchored like `command-tools.ts`, `maxBuffer` capped; collapse hits → top 5 files by hit count with one representative line each. Runs on the workspace the spawn will use (the worktree if `agent_start.worktree` resolved one). | **0 tokens** |
| 3 | **`gh pr list --search`**, merged **and** open, last 30 days | Two calls through the injectable `GhRunner` type (`packages/runtime/src/review-pr.ts`): `gh pr list --state merged --search "<kw> merged:>=<YYYY-MM-DD>" --limit 8 --json number,title,mergedAt,url` and the same with `--state open --search "<kw> updated:>=<YYYY-MM-DD>"` (GitHub search qualifiers, run from the spawn cwd so the repo comes from the git remote — no `--repo` hardcoding). `gh` missing ⇒ step skipped, block still produced. | **0 tokens** (one `gh` process each) |
| 4 | **Memory search** | (a) BM25 brain, same call the `workspace_brain_query` tool makes: `brains.getBrain(slug).getProvider().query({ query, topK: 5 })` (`packages/runtime/src/brain-tools.ts`); (b) keyword pass over the workspace's `memory/**/MEMORY.md` (memory/v1 draft doctype) when present. | **0 tokens** |
| 5 | **Read `PROJECT.md` / `RAPPORT.md`** | Head-read both from `workspaceRoot` if present (≤80 lines / 4 KB each); extract section headings + any line containing a step-4 keyword. Missing file ⇒ skipped. | **0 tokens** |
| 6 | **Compose** the block (§3.3) | Template + truncation to `maxBlockLines` (15). Deterministic order: files → PRs → memory → decisions. | **0 tokens** |
| 7 | **Optional summary line** | Only if `budget.maxLlmCalls ≥ 1` **and** a free route resolves: one call on the runtime's *only* existing daemon-side LLM primitive — `generateTitleViaLlm` (`session-titler.ts:164`: direct `POST https://openrouter.ai/api/v1/chat/completions`, `OPENROUTER_API_KEY`, `AbortSignal.timeout`) — with `max_tokens ≤ 400`, `timeoutMs ≤ 8000`, model from `budget.model` resolved via model-roles' `route: "openrouter"` hint (a free / `:free` id). **Deliberately not** `ModelLike.complete`: `@agentproto/runtime` has no inference client, and driver-agent-cli's `ModelLike.complete` spawns a fresh agent session per call (`summarize-session-tool.ts` header) — one spawn per hook is the anti-pattern this design exists to avoid. Missing key, no free route, or a free route that is adapter-spawn-only ⇒ **refuse the summary and ship the deterministic block** (AIP-68 §5: a host without a free-route catalogue refuses the model pass rather than falling back to a paid one). | 0 or ~400 tokens, hard-capped |

Partial failure is the normal case: any step can drop out (no `gh`, no repo,
no brain, no PROJECT.md) and step 6 still composes a block from whatever
survived. All steps share one `AbortSignal` from `budget.timeoutMs`.

### 3.3 Output block

Hard ceiling **15 lines** including the envelope. Shape (deliberately
mirrors AIP-46's attested-delimiter posture — this text is *data*, not an
instruction, and the daemon says so):

```text
<agentproto-enrichment enricher="prior-art" untrusted="true" from="daemon">
Existing work detected — confirm BEFORE you start:
- files: packages/runtime/src/tool-hooks.ts ("tool hook" ×7); docs/design/tool-hooks-enrichers.md
- PRs: #1858 "tool hooks: queue delivery" merged 5d ago; #1902 open (same topic)
- memory: "Pygmalion prior-art check" — memory/hooks/MEMORY.md §Prior-art
- decisions: PROJECT.md §Hooks; RAPPORT.md 2026-10-15 — "async enrichers, no per-message reviewer"
- summary: prior art is design-doc + merged PR 1858; extend rather than re-add.
First step: reply "modify existing" (name the file/PR) or "new" — then proceed.
</agentproto-enrichment>
```

(The `- summary:` bullet exists only when §3.2 step 7 ran; with
`maxLlmCalls: 0` — the v1.1 rollout default — the example above is 8 lines
instead of 9. Either way, well inside the 15.)

Rules: one bullet kind per line; evidence is quoted/verbatim (file path, PR
number + title, memory id + title) — no free-form claims about what the
existing work *does* beyond the optional step-7 line; if nothing at all was
found, the block is *replaced* by a single line
`Existing work detected: none — this looks new (checked git, PRs last 30d, memory).`
so silence is never ambiguous.

### 3.4 Delivery timing

1. `agent_start`'s handler returns normally (the caller already has the
   spawned session's id — the wire body is the flattened descriptor,
   `agent-tools.ts:553-561`, so `$result.id` is the child).
2. Dispatcher schedules the run at `delayMs` (default **4000 ms** — "a few
   seconds after start", long enough for the child to enter its first turn
   and short enough to beat a fast first tool call).
3. Enricher runs (steps 1–7) inside `budget.timeoutMs`.
4. Delivery: `enqueuePrompt(targetSessionId, block, { queue: true,
   steer: true, origin: "hook:prior-art",
   coalesceKey: "hook:prior-art:<taskId ?? sessionId>" })` — no
   `deliverWithinMs`, no `interrupt` (see §2.5's sweep note).

   - Child busy in turn 1 (the usual case 4 s in) ⇒ queued, or steered into
     turn 1 when the adapter advertises steering, dispatched after a
     *natural* turn end. **Never** `interrupt`, never `session_queue_deliver`.
   - Child not yet in a turn ⇒ the block dispatches as its own turn — the
     same cost posture as AIP-46's `next-turn` tier on an idle recipient
     (start a turn). This is the *only* way enrichment costs a turn (R6).
   - Child gone / killed during the window ⇒ delivery dropped, logged.
5. The agent's next visible instruction is the block's `First step:` line:
   answer **modify existing** (naming the file/PR) or **new**, then work.

---

## 4. Async semantics (normative)

| # | Rule |
|---|---|
| **R1 — never block** | The tool handler is never awaited on hook work. `mode: "async"` dispatch is a `void` promise started after the handler resolves; `mode: "sync"` is clamped to `min(budget.timeoutMs, 2000)` and still cannot fail the call. v1 installs the async arm only — the sync arm is specified but not shipped (§2.4, §7). |
| **R2 — never fail** | The whole dispatch path (`match` → enricher → deliver) is wrapped in one `try/catch`. Any throw, rejection, bad binding, missing session, or timeout resolves to a bus event + `console.warn` — identical posture to `maybeTitleSession`. A hook bug can never turn a valid `agent_start` into an error. |
| **R3 — timeout ⇒ no block** | Every subprocess has `timeout` and every LLM call `AbortSignal.timeout`; on expiry the partial result is discarded and the hook ends with `hook:skipped {reason:"timeout"}`. There is no retry by default (a retry would re-spend the budget on a delegation that already happened). |
| **R4 — dedup** | Default scope `"task"`: key = `"<hookId>:<taskId ?? targetSessionId ?? argsHash>"`. Implementation mirrors the titler's *set-before-await* guard (so concurrent triggers can't double-fire), plus `coalesceKey` on the queue arm so a burst collapses to one queued item with `coalescedCount++`. Scope `"session"` keys on the target session; `"none"` disables. `attach-to-task-meta` dedups for free (same meta key, last write wins). Persisted keys are optional in v1 (in-memory set, module scope, so it survives the per-request server rebuild and resets on daemon restart — acceptable: a restart also loses the window that mattered). |
| **R5 — containment** | No unhandled rejections: every dispatched promise gets its own `.catch`. Enricher authors get the guarantee for free by returning `null` instead of throwing. |
| **R6 — delivery safety** | Arms are only `queue` / `context-slice` / `meta`. A hook never interrupts, never force-delivers (`deliverWithinMs` unset), never steers into a turn the session started autonomously, never kills, and never spawns or re-prompts anything itself. The one cost it can incur is a queued item dispatching as a turn on an *idle* recipient — identical to AIP-46 `next-turn` on an idle recipient, and never forced. The dispatcher refuses a config that names an unknown `deliver.to` or pairs a deadline with `deliverVia: "interrupt" \| "auto"`. |
| **R7 — statelessness-safe** | Dispatcher, dedup sets, the enricher registry and the wrapper-install `WeakSet` are module-scope (`background-jobs.ts` rule). Installing the wrapper *binds* that module-scope state to one request's deps — no hook state is ever created inside `registerSessionTools`'s closure, and two servers never share dedup state accidentally. |
| **R8 — observable** | Bus events `hook:ran {hookId, enricher, deliverTo, ms, lines, llmCalls}` and `hook:skipped {hookId, reason}` on `session-event-bus.ts`; inspectable via `session_events_poll`, and (optional tool) `hook_list` returning the resolved config. `session_queue_list` shows the delivered item. |
| **R9 — injection hygiene** | The block is wrapped in an `agentproto-enrichment` envelope with `untrusted="true"`, sentinels escaped exactly like `escapeMessageBody`, capped at 15 lines / ~1500 chars, and carries only quoted evidence + a directive to *check*, never an instruction to *skip* checks. A prompt-injection attempt inside a PR title or memory body arrives as quoted data inside the envelope. |

---

## 5. Cost

| Path | Tokens | Money |
|---|---|---|
| keywords, `git grep`, 2× `gh pr list`, BM25 brain, file reads, block compose | **0** | 0 |
| optional step-7 summary | ≤400 out, ~1–1.5k in | free-route model only (`budget.model: "free"` → OpenRouter free id; adapter-spawn models rejected), hard `maxLlmCalls: 1` per run |
| no free route configured | 0 — summary refused, deterministic block still delivered | 0 |
| per delegation, worst case with summary | one free call | 0 |

Contrast with the rejected reviewer-agent option: a per-message reviewer costs
one full agent turn (tens of thousands of tokens) on *every* message; this
costs zero on every message and, at most, one capped free call when the
summary is enabled. `budget.maxCostUsd` (day window, AIP-68 style) is the
operator's hard stop and is never silently reset by the daemon.

---

## 6. Extensibility

Adding an enricher = one file + one registry entry; no dispatcher change.

```ts
export interface EnricherContext {
  event: ToolHookEvent
  promptText?: string
  workspaceRoot?: string
  signal: AbortSignal
  cfg: Record<string, unknown>          // hooks.enrichers.<id>
  // injected deterministic ports (all injectable for tests)
  gitGrep(patterns: string[], paths?: string[]): Promise<GrepHit[]>
  gh(args: readonly string[]): Promise<string>          // GhRunner
  brainSearch(query: string, topk: number): Promise<BrainHit[]>
  readWorkspaceFile(rel: string, maxBytes?: number): Promise<string | null>
  llm(system: string, prompt: string, budget: Budget): Promise<string | null>  // titler-shaped OpenRouter fetch; free route only
}
export type Enricher = (ctx: EnricherContext) => Promise<EnrichmentBlock | null>
```

Shipped or planned:

| Enricher | Trigger (typical) | Steps | Deliver | LLM |
|---|---|---|---|---|
| **`prior-art`** (§3) | `agent_start` from a supervisor | grep + PRs + memory + PROJECT/RAPPORT | append-to-session-queue | optional, free |
| **`spec-echo`** — for user-facing features | `task_create` whose title/description matches `user-facing\|feature\|UX\|api` | read the workspace's spec/docs index (`specs/`, `docs/`, `WORK.md`), list ≤10 existing spec sections that already constrain the ask, so the agent implements *the* spec instead of inventing one | attach-to-task-meta (or prepend-to-prompt on a spawn) | optional one-line free summary |
| **`security-check`** | `agent_start` when args/files touch `auth\|token\|secret\|migrations\|.env\|workflows` | deterministic: `git grep` over the touched paths' auth/secret neighbours, cross-referenced with the escalation globs the merge flow already enforces — `merge.alwaysEscalateGlobs` (migrations, SQL, auth, security, workflows, `.env*`; `scripts/maintainer.mjs`, documented in `AGENTS.md`) and `SELF_MODIFICATION_RE` (`scripts/agentflow/merge-gate.mjs`) — producing a "these paths always escalate" note | prepend-to-prompt | none (0 tokens by construction) |

Rules for new enrichers: deterministic-first; LLM only for a summarising
sentence; must return `null` (not throw) on partial data; must fit
`maxBlockLines`; must be safe to run twice (dedup handles the rest).

---

## 7. Rollout

**v1 is one shipping unit, not the first rung of an open-ended phase
ladder:** the deterministic hook dispatcher — the permanent foundation
every later feature installs into — together with the `prior-art` async
enricher, landed and enabled as a single increment. The dispatcher is not
a proof of concept to be discarded: §10's clerk unification, the further
delivery-arm consumers and every future enricher ride *it*. Everything
not in v1 is listed below with an explicit reason and a named trigger —
there is no undefined "later".

### v1 — what ships

| Stage | Config | Gate / exit criterion |
|---|---|---|
| **v1.0 — land, off** | Dispatcher + `withToolHooks` (async path only, §2.4) + the `prior-art` enricher + the `hooks` config block; `hooks.enabled: false` (absent ⇒ off, `titler` precedent). The optional §3.2 step-7 summary path is *code-complete in v1* (it rides the titler's existing OpenRouter fetch) but config-off: the shipped default budget is `maxLlmCalls: 0`. | `pnpm test` + `pnpm check-types` green (repo gate per `AGENTS.md`). |
| **v1.1 — Pygmalion first** | One hook: `on: "agent_start"`, `match: { caller: { role: "supervisor", label: "pygmalion*" } }` (role is the coarse gate resolved per §2.2; the label — or `caller.agentId` for the AIP-42 manifest session — is what actually narrows to the Pygmalion brain), `run: "prior-art"`, `mode: "async"`, `delayMs: 4000`, `deliver: { to: "append-to-session-queue", sessionId: "$result.id" }`, `budget.maxLlmCalls: 0` (deterministic pipeline only). | Watch a dozen delegations: block appears in `session_queue_list`, no change to tool latencies, zero `hook:*` errors. |
| **v1.2 — breadth, config-only** | Same shipped unit, more config: `task_create` → `attach-to-task-meta`; `agent_prompt` (re-prompts of an existing child) → queue append with dedup `"task"`; a second brain opts in the same way. | Each added hook gets the same dozen-delegation watch as v1.1. |

From v1.1 on, the rollout is config-only — no code change to widen or
narrow a hook. Kill switch: `hooks.enabled: false` (hot) — next call
dispatches nothing. Observability: `hook:ran` / `hook:skipped` on the
bus, `session_queue_list` for delivery, `config_get` over the `hooks.*`
registry keys for the resolved config.

### Post-v1 — out of v1, each with a reason and a named trigger

| Item | Why it is out of v1 | Named trigger / milestone |
|---|---|---|
| **`mode: "sync"` installed** — the `fireSync` branch (§9.1, §9.2) | No v1 delivery arm's consumer reads enrichment from the tool's own response; all three arms are out-of-band by R6, so the blocking-shaped path would ship unused. v1 refuses a `mode: "sync"` config at load rather than honouring it silently (§2.4). | The first `attach-to-task-meta` hook whose caller is a non-polling consumer that reads meta only from the create response — until then the ledger write plus `task:changed` suffices (task meta is durable; a late write loses nothing). Demand-gated on a real consumer asking. |
| **Step-7 summary enabled** (`maxLlmCalls: 1, model: "free"`) | v1 must prove the deterministic block's value before spending any model budget; free-route resolution also depends on `OPENROUTER_API_KEY` being configured. The code ships in v1 — enabling it is a config flip, not a build. | The v1.1 watch shows the deterministic block missing decisions a one-line free summary would catch, or an operator opts in per workspace. Free route present ⇒ summary line; absent ⇒ refusal logged, block unchanged (AIP-68 §5 posture). |
| **`hook_list` tool** | `config_get` over the `hooks.*` keys already exposes the resolved config in v1; a dedicated tool would add a daemon tool name plus generated-registry churn for no new information. | The workspace `HOOK.md` merge (below) lands, and `config_get` can no longer show the *merged* view across sources — the tool ships with that milestone. |
| **`spec-echo` enricher** (§6) | v1 proves the seam with one enricher; each further enricher is one file plus one registry entry (§6), additive the moment the dispatcher is proven in production. | The first workspace with a real spec index (`specs/`, `docs/`, `WORK.md`) whose agents are asked to implement *the* spec — a concrete demand for the "existing spec sections" block. |
| **`security-check` enricher** (§6) | Same posture: additive, zero dispatcher change, ships when someone will read it. | The first pre-delegation incident of the class the maintainer judge only catches at merge — an `agent_start` already touching `auth\|token\|migrations\|.env\|workflows` that would have escalated anyway. The note pays for itself exactly then. |
| **Workspace `HOOK.md` loading** (§2.7b) | Two-source precedence (workspace doc > daemon config) is a config-surface change with drift risk; the daemon config alone covers Pygmalion (v1.1) and the second brain (v1.2). | The first real per-workspace divergence: a brain/team that needs a *different* hook set than the daemon-wide config. |
| **User/agent-authored enrichment scripts** | AIP-40's parked sandbox problem: a config-declared script body is remote code execution by JSON. Config plus bundled enrichers do not cross that line; a `HOOK.md` that can run third-party scripts would (candidate AIP-69). | A sibling AIP with a sandbox-mediated execution model — AIP-40's explicit parking condition. |
| **Clerk triggers on `fireExternal`** (§10.4 v2) | The clerk keeps its independently built AIP-68 §5 path in v1 so nothing breaks; the §10 shapes (record, dispatcher, dedup, budget, delivery) are already the ones it will join. | §10.4's v2 milestone: clerk integrations publish into `fireExternal` and their play passes register as enrichers. |
| **Shared day-window cost accounting** (§10.4 v3) | Per-hook `maxCostUsd` exists in v1; one operator-wide day window spanning both populations is only worth building once both spend against it. | §10.4's v3 milestone: clerk passes and enricher runs share one hard stop. |

---

## 8. Does this need an AIP amendment?

**Verdict (owner-decided): one short amendment to AIP-46 — not a new AIP.**
The amendment is kept in this doc as a ready-to-port section — §8.1,
**"Proposed AIP-46 amendment"** — written as normative spec prose with no
repo-specific references, so porting it into the canonical
`agentproto/agentproto` AIP-46 is a copy, not a rewrite.

Why not new: every *vocabulary* piece already exists and is canonical —
AIP-37 registers `tool-call` / `tool-result` / `tool-error`; AIP-42 already
defines `on: <AIP-37 event> → action-refs` with "errors are logged but do not
abort"; AIP-41 already has `schedule.kind: event` + `filter`; AIP-60 defines
the `match` clause shape; AIP-68 defines out-of-band, single-flight, budgeted,
free-tier-first passes. A new AIP would re-litigate all five.

Why AIP-46 *does* need the amendment: the two things this design adds that
no AIP says yet are (a) **the delivery contract** — daemon-authored text
injected into a session's queue/context from *outside* any prompt, with a
never-interrupt guarantee — and (b) **the non-blocking guarantee** — a host
MUST NOT let a hook delay or fail a delegation. Both are statements about the
AGENT-SESSIONS surface (its queue, its multi-turn semantics, its message
tiers), which AIP-46 owns normatively today. Without the amendment a
conformant host could legally treat hook output as a normal prompt (interrupt
allowed) or gate `agent_start` on it.

**New AIP later, only if:** hooks become user-authored *code* with a sandbox
execution model — AIP-40 explicitly parks that ("runtime hooks … belong in a
sibling AIP … that includes a sandbox-mediated execution model"). Config +
bundled enrichers do not cross that line; a `HOOK.md` doctype that can run
third-party scripts would (candidate: AIP-69). Until then the doc form in
§2.7(b) stays pending (`specs/resources/pending/hook/`), like `memory`.

### 8.1 Proposed AIP-46 amendment (ready to port)

````markdown
### Tool hooks and enrichers (proposed AIP-46 amendment, 2026-10-20)

A host MAY run **enrichers** — read-only background passes over the
workspace, PR history, memory or project docs — triggered by a tool
invocation or a lifecycle event, without the caller asking for them and
without delaying the call they came from.

#### Hook record

```ts
interface ToolHook {
  id: string
  on: string            // a tool name, an AIP-37 event (tool-call | tool-result | tool-error),
                        // or a host event name (host-namespaced per AIP-37)
  match?: object        // AND across fields, OR within a field (AIP-60 clause shape)
  run: string           // enricher id, host-bundled in v1
  mode?: "async" | "sync"   // default "async"
  deliver: { to: "append-to-session-queue" | "prepend-to-prompt" | "attach-to-task-meta", … }
  delayMs?: number
  dedup?: "task" | "session" | "none"   // default "task"
  budget?: { timeoutMs?: number, maxLlmCalls?: number, maxTokens?: number, model?: string }
}
```

#### Host requirements

1. **Non-blocking.** A host MUST NOT await an `async` hook before returning
   the tool's own result. A `sync` hook is bounded by `budget.timeoutMs`
   (hosts SHOULD clamp it to ≤ 2000 ms) and MUST still be unable to fail the
   tool call.
2. **Failure containment.** A hook error, timeout, unknown enricher id or
   unresolvable delivery binding MUST degrade to a host log/event; it MUST
   NOT surface as a tool error, and MUST NOT retry by default.
3. **Never interrupt.** Enrichment is delivered by queueing, by a
   turn-start context slice, or by record metadata. A host MUST NOT
   deliver enrichment via interrupt, MUST NOT drain a queue on an
   interrupted turn to place it, MUST NOT steer into a turn the
   session started autonomously, and MUST NOT arm a force-delivery
   deadline whose fallback mode is an interrupt (queue it and wait for
   the natural turn end instead).
4. **Dedup.** Hosts MUST dedup per task by default: one block per
   (hook, task/session) in a window; a burst collapses to one queued item.
5. **Budget & free-tier.** Deterministic steps MUST be token-free. Any model
   step defaults to `maxLlmCalls: 0`; when enabled it MUST resolve a
   free-tier model and MUST refuse (rather than fall back to a paid model)
   when the host has no free route — same rule as AIP-68 §5.
6. **Attribution & untrusted marking.** Enrichment is host-authored text
   delivered outside any human prompt; hosts MUST mark it untrusted, bound
   its size (hosts SHOULD cap at 15 lines), escape its delimiters, and
   attribute it to the daemon — never to the human and never to the target
   session. Consumers MUST treat it as data.
7. **Observability.** Hosts SHOULD emit a hook outcome event
   (`ran` / `skipped` with reason) and SHOULD expose the resolved hook list.
   Hook outcomes are AIP-37-style events: best effort, never required for
   conformance of any other event.

#### Relationship to existing AIPs

Vocabulary from AIP-37; binding shape from AIP-42 `on:`; filter clause
shape from AIP-60 `match`; budget posture from AIP-68 §5; delivery rides the
queue, context-slice and metadata surfaces this AIP defines. AIP-41
`schedule.kind: "event"` MAY reference the same events for scheduled
replays; a routine target does not carry `deliver` and is not required to.
````

---

## 9. Reference implementation sketch

### 9.1 Files

**New**

| File | Contents |
|---|---|
| `packages/runtime/src/tool-hooks.ts` | `ToolHook`, `MatchSpec`, `ToolHookEvent`, `Budget`, `DeliverSpec`; config loader/validator; `matches(event, spec)`; `resolveBindings`. Pure — no I/O, unit-testable. |
| `packages/runtime/src/tool-hook-dispatcher.ts` | Module-scope dispatcher: dedup sets (titler-style set-before-await), timer for `delayMs`, one `try/catch` around match→run→deliver, `hook:ran`/`hook:skipped` emission, `AbortSignal` budget wiring. (The `sync` clamp lives with the post-v1 `fireSync` branch, §7 — v1 ships `fire` only.) |
| `packages/runtime/src/with-tool-hooks.ts` | `withToolHooks(server, dispatcher, deps)` — the `tool-subset.ts`/`deferred-tools.ts` proxy: same `Proxy`, same `tool` / `registerTool` interception, same `...rest` forwarding, but it pops the trailing argument **only when it is a function** (both SDK overloads take the handler last — `registerTool(name, config, cb)` as used by `agent-tools.ts` / `mcp-apps-adapter.ts`) and wraps it: `await original(...)`, then `dispatcher.fire(...)` fire-and-forget, then return the untouched result. **v1 wraps the async path only** (§2.4): the wrapper never awaits hook work, so the tool's own promise is never extended by a hook. The `fireSync` branch (≤2 s clamp, block folded into the response) is one later addition behind the same seam — installed only when its §7 trigger fires. |
| `packages/runtime/src/tool-hook-enrichers/types.ts` | `Enricher`, `EnricherContext`, `EnrichmentBlock`. |
| `packages/runtime/src/tool-hook-enrichers/prior-art.ts` | §3 pipeline; ports injected (`gitGrep`, `gh`, `brainSearch`, `readWorkspaceFile`, `llm`). |
| `packages/runtime/src/tool-hook-enrichers/index.ts` | Registry `Map<string, Enricher>` + `registerEnricher`. |
| `packages/runtime/src/__tests__/tool-hooks.test.ts` | match/bind/dedup/timeout/never-fail/never-block (asserts the tool result is identical with hooks on/off). |
| `packages/runtime/src/__tests__/prior-art.test.ts` | keyword extraction, block ≤15 lines, partial-failure composition, free-route refusal. |
| `docs/design/tool-hooks-enrichers.md` | This document. |
| *(post-v1 — §7, named trigger)* `packages/runtime/docs/mcp-tools/hook_list.md` + `hook_list` tool | Resolved-config inspection; regenerate `daemon-tool-names.generated.ts` via `pnpm --filter @agentproto/runtime gen:daemon-tool-names`. Not needed in v1: `config_get` over the `hooks.*` keys already exposes the resolved config. |
| *(§2.7b, second step)* `specs/resources/pending/hook/draft/HOOK.schema.json` | The `hook/v1` frontmatter draft, pending like `memory`. |

**Modified**

| File | Change |
|---|---|
| `packages/runtime/src/config-schema.ts` | `hooksConfigSchema` + top-level `hooks` key + `CONFIG_KEYS` entries (`apply: "hot"`). |
| `packages/runtime/src/config.ts` | `AgentprotoConfig.hooks?: HooksConfig` (+ the compile-time key check). |
| `packages/runtime/src/session-event-bus.ts` | `hook:ran` / `hook:skipped` event types. |
| `packages/runtime/src/task-ledger.ts` | One internal wiring verb, `setMeta(taskId, key, value, caller)`, cloned from `linkApproval`'s shape: no `rev`, last-write-wins on the `meta` map, `task:changed` on success. (`task-tools.ts` unchanged — hooks write through the ledger, not through a new MCP tool.) |
| `packages/runtime/src/session-follow-store.ts` | *(only if hooks should be followable)* append `"hook-ran"` / `"hook-skipped"` to `FOLLOW_EVENTS` (kebab, like every entry there); `session-follow-tools.ts` derives its `z.enum(FOLLOW_EVENTS)` from that one constant, so it needs no edit of its own. |
| `packages/runtime/src/index.ts` | **Where the wrapper installs.** On the server built for each MCP surface, right alongside the existing `withDeferredTools` / `withToolExclusion` / `withToolSubset` calls (`index.ts:3494-3514`, *before* the `registerSessionTools` / `registerAgentTools` / `registerTaskTools` passes). Everything a hook needs is in that scope already: `callerSessionId` (the per-request `?callerSessionId=` identity, `index.ts:3431`), the `sessions` registry, `taskLedger` (`index.ts:3095`), `workspaceBrains`, and the config reader. The dispatcher itself is built once at module scope. |
| `packages/runtime/src/session-tools.ts` | **No change** for install — its own `withToolSubset(rawServer, opts.toolSubset)` (`session-tools.ts:1332`) is a *different* wrapper, applied to a possibly different server object (orchestrator sub-gateway). `withToolHooks` is therefore written to be installed at more than one site safely (note below), and any registration pass built outside the `index.ts` path installs it itself with its own deps. |
| `packages/runtime/src/http-server.ts` | *(parity)* the handful of REST routes that duplicate a hooked tool (`POST /sessions/agent`, `POST /sessions/:id/prompt`) call `dispatcher.fire` too — MCP and REST must not diverge. |

**Install exactly once per server.** `index.ts` *and* `session-tools.ts`
already apply proxies to overlapping server objects, so `withToolHooks`
carries its own idempotence: a module-scope `WeakSet<McpServer>` of already
wrapped servers (same statelessness posture as the dispatcher), checked at
install. Double-wrapping would double-fire every hook, so this is a
correctness requirement, not hygiene.

### 9.2 Interfaces (sketch)

```ts
// tool-hooks.ts
export interface ToolHook {
  id: string
  on: string
  match?: MatchSpec
  run: string
  mode?: "async" | "sync"
  deliver: { to: "append-to-session-queue" | "prepend-to-prompt" | "attach-to-task-meta"
             sessionId?: string; taskId?: string }
  delayMs?: number
  dedup?: "task" | "session" | "none"
  budget?: Partial<Budget>
  enabled?: boolean
}
export interface CallerRef { sessionId?: string; id?: string; label?: string
  role?: string; depth?: number; agentId?: string }
export interface ToolHookEvent { on: string; args: Record<string, unknown>
  result?: Record<string, unknown>; caller?: CallerRef
  workspaceSlug?: string; ts: string }

export interface ToolHookDispatcher {
  /** Fire-and-forget. Never throws, never awaits on the caller's behalf. */
  fire(event: ToolHookEvent): void
  /** Reserved — post-v1 (§7), not shipped or installed in v1: the
   *  mode:"sync" path, bounded by min(budget.timeoutMs, 2000), resolving
   *  null on timeout/failure. v1 refuses mode:"sync" configs at load (§2.4). */
  fireSync(event: ToolHookEvent): Promise<EnrichmentBlock | null>
  list(): readonly ToolHook[]       // config_get shape in v1; the hook_list
                                    // tool that would surface it is post-v1 (§7)
}

// with-tool-hooks.ts
export function withToolHooks(server: McpServer, d: ToolHookDispatcher, deps: HookDeps): McpServer
// deps (from the per-surface gateway scope — see §9.1): callerSessionId,
//   registry (enqueuePrompt / sendMessage), taskLedger, brains, config reader

// prior-art.ts
export const priorArt: Enricher = async ctx => { … }  // returns null ⇒ skip delivery
```

### 9.3 Test / gate plan

`pnpm --filter @agentproto/runtime test` while iterating, then the repo gate
per `AGENTS.md` with real exit codes:

```sh
pnpm check-types > /tmp/ct.log  2>&1; echo "CT_EXIT=$?"
pnpm test        > /tmp/gate.log 2>&1; echo "TEST_EXIT=$?"
```

Key assertions: tool results byte-identical with hooks on vs off; a throwing
enricher changes nothing but the bus; a 20 s budget with a hung `git` yields
no block and no delay; two delegations for the same task yield one queued
item; the block never exceeds 15 lines.

---

## 10. One event/hook mechanism, shared with AIP-68 (clerk)

AIP-68's clerk is *the same problem with a different trigger*: an
out-of-band, never-wake, single-flight + debounced, budgeted, free-tier-first
background pass whose output is delivered into a session/task without being
asked for. Today the doc treats the two as siblings by citation only (§1
rows for AIP-68, §5's budget posture, §8.1 rule 5 "same rule as AIP-68 §5").
If they stay code-siblings only, we will end up with **two trigger
plumbings, two dedup regimes and two budget accounting systems** for one
concept. They should share **one** event/hook mechanism.

### 10.1 The shared record and shared dispatcher

Both populations reduce to the same record — "when **X** happens, run **Y**
in the background and deliver the result **Z**-wards" — so both are declared
and dispatched through the §2 machinery, extended in two small places:

1. **One event record, generalised.** `ToolHookEvent` (§2.2) becomes
   `HookEvent`: `{ on, subject?, meta?, args?, result?, caller?, ts }`. A
   clerk trigger publishes into the **same field names**: a v1 clerk
   trigger event is `{ on: "clerk:pr-merged", args: { repo, pr, taskIds
   from inbox } }`-shaped — `subject` (a URI: repo path, task id, session
   id) is the AIP-68 watch target, and the tool-call fields stay optional.
   Nothing already specced changes: AIP-37 already allows host-namespaced
   (`<host>:<event>`) event names, so `clerk:pr-merged` and
   `agentproto:tool-call` are legal names in one namespace.
2. **One dispatcher, two feeds.** The module-scope dispatcher (§9.1,
   `tool-hook-dispatcher.ts`) gains a second public entry point
   `fireExternal(event: HookEvent)` that the clerk's existing integrations
   (task lifecycle `task:changed`, PR webhooks, branch events, cron passes —
   the AIP-41 `schedule.kind: event` surface) call. Every hook — enricher
   or clerk play — is matched with the same pure `matches(event, match)`,
   deduped by the same set-based regime, and run through the same
    `try/catch` + budget envelope. The clerk's *single-flight + debounce*
    (AIP-68 §5) is this doc's dedup (R4) with a longer debounce window and
    one extra scope, **`subject`** — the unification's single, defined
    extension to the v1 enum (`task | session | none`): it keys on
    `event.subject` (the watch-target URI from §10.1's `HookEvent`) instead
    of a task or session, and is legal **only** for hooks on
    external/host events — a `subject`-scoped hook bound to a named tool
    trigger (which carries no `subject`) is a config error at load, the
    same refusal posture as §2.1's unknown-tool rule. One implementation,
    tunable per hook.

### 10.2 What stays clerk-owned

The *pass* stays AIP-68's: a clerk play is still the bounded, prioritised,
watch-driven workflow from its spec (§5), with its own richer frontmatter
(`watch:` goals, pass ordering, escalation). What changes is the **entry
and the envelope**: a clerk pass is invoked as an enricher would be —
`run: "<play-id>"`, `budget` uses the shared `Budget` type, and its output
uses the shared delivery contract — via AIP-46's queue/`fyi` slice, or,
when the play produces a task change, `task:changed` — never an interrupt,
never a wake (AIP-68's never-wake ≙ this doc's R6 never-interrupt).

### 10.3 Concrete shared components (checklist)

| Component | Shared by | Already exists? |
|---|---|---|
| Event names incl. `clerk:*` | AIP-37 host-namespaced events (canonical), `on` in both configs | yes (§2.1) |
| One dispatcher with `fire` / `fireExternal` | §9.1 dispatcher | new but one file; `fire` today, `fireExternal` is the same code path minus `$result` binding |
| One match grammar | AIP-60 clause shape (§2.2) | yes |
| One dedup regime (single-flight/debounce) | R4 + AIP-68 §5 single-flight/debounce | same mechanism, per-hook window |
| One budget type | §2.6 `Budget` + AIP-68 `budget.max_llm_calls_per_pass` / `max_cost_usd_per_day` — v3 note: `maxCostUsd` should move to a *day-window* that BOTH clerk passes and enricher runs spend against, so the operator has one hard stop (§5 already leans this way) | half — `maxCostUsd` per-hook exists, day-window aggregation is one counter |
| One delivery contract | AIP-46 queue / `fyi`-slice / task-meta (§2.5) | yes |
| One observability pair | `hook:ran` / `hook:skipped` ≙ clerk pass outcomes on the same bus (R8, policy-event posture) | yes, by construction |

### 10.4 Phasing of the unification

**v1 (this doc):** the dispatcher + enricher hooks ship; the clerk keeps
its today-stance (independently built to AIP-68 §5) and nothing breaks.
The v2 and v3 milestones below are the named triggers in §7's post-v1
table — not an undefined later. **v2:** clerk triggers publish into
`fireExternal` and their play passes are *registered enrichers*; config
stays separate (clerk frontmatter declares `on:`/`match:` in the shared
shape). **v3:** shared day-window cost accounting and one observability
surface for both populations (the `hook_list` tool itself ships with the
§7 `HOOK.md` milestone; v3 extends that surface to clerk passes). No new
event names, no new queue, no new event system — the "gap" sentence at
the end of §1 is satisfied exactly once.

---

## 11. Summary

1. The daemon has no tool-call hook today; the reusable pieces are the
   registration-time server proxies (`tool-subset`/`deferred-tools`), the
   fire-and-forget enricher contract (`session-titler`), the module-scope job
   rule (`background-jobs`) and three delivery arms that already exist —
   prompt queue, turn-start context slice, task `meta`.
2. A hook is `{on, match, run, mode, deliver, delayMs, dedup, budget}`,
   declared in `~/.agentproto/config.json` (`hooks`, hot-apply, config-key
   drift-guarded) with an optional pending `HOOK.md` doc overriding it per
   workspace; `on` reuses AIP-37 tool/lifecycle names, `match` reuses the
   AIP-60 clause shape, `deliver` reuses AIP-46's queue and slices.
3. `prior-art` extracts keywords with zero tokens, then `git grep`, two
   `gh pr list --search` calls (merged + open, 30 days), a BM25 memory query
   and a `PROJECT.md`/`RAPPORT.md` read — composing a ≤15-line « Existing
   work detected » block delivered ~4 s after spawn (steered into turn 1 when
   the adapter steers, else the next turn), so the agent answers "modify
   existing" or "new" before it designs.
4. Async is normative: never await, never fail, timeout ⇒ no block, dedup
   per task (set-before-await + `coalesceKey`), delivery only via
   queue/context-slice/meta — never `interrupt`.
5. Deterministic steps cost 0 tokens; the only model step is optional —
   `≤400` output tokens on a **free OpenRouter route** through the titler's
   own fetch (the runtime has no inference client), `maxLlmCalls: 1`, with an
   explicit refusal when no free route or `OPENROUTER_API_KEY` exists.
6. **No new AIP (owner-decided):** a ready-to-port, normative *Proposed
   AIP-46 amendment* (§8.1) covers the delivery and non-blocking
   guarantees; a standalone AIP waits until hooks can be user-authored
   code (AIP-40's parked sibling, candidate AIP-69). v1 = the
   deterministic dispatcher **plus** the `prior-art` async enricher,
   shipped together (§7) — and everything out of v1 carries an explicit
   reason and a named trigger, never an undefined "later".

---

## 12. Decisions recorded (v1 scope freeze & AIP-46 amendment)

Both owner decisions are in. This section is the record; it no longer
blocks anything, and nothing elsewhere in the doc contradicts it.

**1) AIP-46 amendment — decided; kept ready-to-port in §8.1.** The §8
verdict is final: **one short amendment to AIP-46, not a new AIP**.
Every vocabulary piece is already canonical (AIP-37 events, AIP-42 `on:`,
AIP-41 `schedule.kind: event`, AIP-60 `match`, AIP-68 budget); the two
genuinely new normative statements — the never-interrupt / never-block
delivery-and-run guarantees for daemon-authored enrichment — are
statements about the AIP-46 session surface. The amendment lives in this
doc as §8.1, **"Proposed AIP-46 amendment"** — normative spec prose with
no repo-specific references, ready to be copied into the canonical
`agentproto/agentproto` AIP-46. The `HOOK.md` doctype stays **pending**
(`specs/resources/pending/hook/`, like `memory`) and consumes no AIP
number until user-authored hook *code* (AIP-40's parked sibling) forces
a real spec — then it is a candidate AIP-69. *One operational ask left:*
name the reviewer for the §8.1 text before the port.

**2) v1 scope — frozen: deterministic dispatcher + `prior-art`, together.**

- **In:** the module-scope hook dispatcher + `withToolHooks` proxy, async
  path only (§2.4) — the permanent foundation every later feature
  installs into, not a proof of concept; the three delivery arms from
  existing primitives (queue append, `fyi` prepend-to-prompt,
  `attach-to-task-meta`); config-only hooks in `~/.agentproto/config.json`
  (hot, killable); the `prior-art` enricher with its deterministic
  pipeline — shipped default `maxLlmCalls: 0`, with the optional
  free-model summary code-complete but config-off (§7 v1.0) — on
  Pygmalion/delegations first (§7 v1.1); in-memory module-scope dedup
  (survives the per-request server rebuild, resets on daemon restart).
- **Out of v1 — each item carries an explicit reason and a named trigger,
  spelled out in §7's post-v1 table:** `mode: "sync"` installed (the
  `fireSync` branch stays reserved behind the same seam; v1 refuses the
  config at load), the `hook_list` tool, the `spec-echo` /
  `security-check` enrichers, workspace `HOOK.md` loading,
  user/agent-authored enrichment scripts, and the clerk unification
  beyond the shared §10 shapes (clerk triggers join `fireExternal` at
  §10.4's v2; day-window cost accounting at v3). Enabling the step-7
  summary is likewise a named-trigger config flip (§7), not a phase —
  and, like everything in v1, the rollout stays deterministic-first and
  free-route-only.
