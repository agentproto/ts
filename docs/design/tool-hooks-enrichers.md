# Tool hooks & enrichers

Status: **design — docs only, no code landed yet.**
Scope: agentproto daemon (`packages/runtime`), English docs.

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
session's queue a few seconds after start, so the agent's first step is to
confirm **modify existing** or **new**.

---

## 1. What exists today, and what we reuse

Nothing here should be built twice. Every row below was read before this
design was written; the "verdict" column is the reuse decision.

| Mechanism | What it already does | Verdict for this design |
|---|---|---|
| **Tool-registration proxies** — `withToolSubset` / `withToolExclusion` (`packages/runtime/src/tool-subset.ts`), `withDeferredTools` (`packages/runtime/src/deferred-tools.ts`) | `Proxy` around the MCP server that intercepts `server.tool(...)` / `server.registerTool(...)` registration and can wrap or drop registrations. Proven to survive the stateless, per-request `mcpServerFactory` model. | **Reuse as the seam.** `withToolHooks(server, dispatcher)` is the same shape: wrap the handler at registration time, so each fresh per-request server re-installs the wrapper. |
| **Daemon-side fire-and-forget enricher** — `maybeTitleSession` (`packages/runtime/src/session-titler.ts`) | Opt-in config block (`titler: { enabled, model }`, default off), once-only in-memory guard set *before* any `await`, every failure degrades to a logged no-op, seams injected for tests. | **Reuse the contract, verbatim.** This is the template for an enricher run: never throws, never blocks the turn that triggered it, default-off. |
| **Background job registry** — `createBackgroundJobRegistry` (`packages/runtime/src/background-jobs.ts`) | Module-scope job map + on-disk result files, specifically because a fresh `McpServer` is built per request and a registry created inside `register*` would be invisible to the next connection. | **Reuse the statelessness rule** for hook/dedup state: dispatcher and dedup sets live at module scope, not inside the registration closure. |
| **Prompt queue** — `registry.enqueuePrompt(id, msg, opts)` (`packages/runtime/src/sessions.ts`, the `enqueuePrompt` arm) with `queue`, `steer`, `coalesceKey`, `deliverWithinMs`, `deliverVia` | FIFO queue behind an in-flight turn; `coalesceKey` replaces a waiting item in place instead of stacking a second one; optional steer into the running turn when the adapter supports it. | **This is `deliver: append-to-session-queue`.** Call it directly — no new queue. `coalesceKey` is the dedup for the queue arm. |
| **Turn-start context slices** — `renderInboxDigest` (`packages/runtime/src/session-message.ts`) applied at `packages/runtime/src/sessions.ts` in `runAgentTurn` (the `fyi` digest, the interrupt notice, `pendingResumeContext`) | Text prepended to the *next* turn as a `system-prompt` slice (never glued into the human's text), once per item, string-turns only. | **This is `deliver: prepend-to-prompt`.** Same slot, same once-per-item bookkeeping. |
| **Task meta** — `task_create`'s `meta: Record<string,string>` input and `task_update`'s `note → meta.note` (`packages/runtime/src/task-tools.ts`), internal `setMeta` helper in `packages/runtime/src/task-ledger.ts` | Free-form provenance on a task, last-write-wins per key, persisted with the ledger, emits `task:changed`. | **This is `deliver: attach-to-task-meta`**, via one new internal ledger verb (§2.5) — a namespaced key (`hook:prior-art`) is naturally idempotent. |
| **`session_follow`** (`packages/runtime/src/session-follow-tools.ts`, `FOLLOW_EVENTS` in `packages/runtime/src/session-follow-store.ts`) | Declarative `selector` / `exclude` / `events` / `batchMs` coalescing — "wake me when X matches, digest bursts into one notice, never interrupt a busy follower". | **Reuse the vocabulary for `match`** (selector-style clauses + burst coalescing). Not a delivery path: it wakes the *follower*, we push into the *target*. |
| **`session_queue_deliver` / `session_queue_promote`** (`packages/runtime/src/session-tools.ts`) | Deliver-now (interrupt) and promote-to-front of a queued prompt. | **Explicit non-goal.** A hook never interrupts. These names exist in this doc only to say we do not use them; `session_queue_list` is reused for observability. |
| **`policy_attach` / completion policies** (`packages/runtime/src/supervisor.ts`, `orchestration-tools.ts`, `docs/cli/verbs/policy.md`) | Turn-**end** gates: shell/judge verdict, `next` chaining, fan-in, `onFail` nudge+retry, `policy:passed`/`policy:failed` bus events. | **Wrong seam for enrichment** (it fires after a turn, not at delegation time) and deliberately blocking. **Reuse**: the judge-gate form as the precedent for "a model pass with a verdict", and the policy event pair as the model for hook observability events. |
| **AIP-46 events & messages** (canonical prose `specs/aip-46.mdx`; impl `packages/runtime/src/sessions.ts`, `session-message.ts`, `http-server.ts`) | Prompt queue semantics, typed `SessionMessage` envelope, delivery tiers `fyi \| next-turn \| steer \| interrupt`, bounded durable inbox, attestation + delimiter escaping. | **Reuse for delivery**: append-to-session-queue rides the queue; prepend-to-prompt rides the `fyi` slice; the envelope/attestation rules tell us how to render enrichment text safely. |
| **AIP-41 routines** (`packages/routine/src`, `packages/runtime/src/routine-registrar.ts`) | `ROUTINE.md` frontmatter: `schedule: {kind: "cron"\|"interval"\|"calendar"\|"manual"\|"event", on, filter}` + `target: action\|agent\|workflow\|tool`. | **Reuse the shape, not the dispatcher.** `schedule.kind:"event"` validates but only `cron` fires today (`routine-registrar.ts:232`), and a routine `target` has no `deliver` concept. v1 hooks are config-declared and dispatched in-process; the routine/event path is the future declarative home (§8). |
| **AIP-37 LIFECYCLE vocabulary** (canonical `specs/aip-37.mdx`) | Standard event names incl. `tool-call` (before), `tool-result` (after), `tool-error`; hosts MAY fire extra namespaced (`<host>:<event>`) names; events are best-effort, configs MUST tolerate never firing. | **Reuse for `on`.** No new event names required. |
| **AIP-42 AGENT.md `on:` hooks** (canonical `specs/aip-42.mdx`) | `on: {<AIP-37 event>: [action-ref…]}`; "Errors in hooks are logged but do NOT abort the conversation." | **Reuse the semantics**: best-effort, error-contained. This is the normative backing for our "never fail the tool call" rule. |
| **AIP-60 SENTINEL `match`** (canonical `specs/aip-60.mdx`) | `SentinelSpec.match`: array of `{subject, types?}` clauses, OR across clauses, prefix + glob semantics. | **Reuse the clause shape** for `match`, extended with tool-arg predicates (sentinel subjects are external objects; ours are tool args). |
| **AIP-68 clerk watch core** (canonical `specs/aip-68.mdx` §5) | Out-of-band, never-wake, single-flight + debounce, bounded passes, **free-tier-first** model budget (`budget.max_llm_calls_per_pass`, `budget.max_cost_usd_per_day`), refusal when no free route exists. | **Reuse the async + budget contract wholesale** — it is the same problem with a different trigger. |
| **`workspace_brain_query`** (`packages/runtime/src/brain-tools.ts`, `packages/workspace-brain/src`) | BM25 keyword search over ingested transcripts, per workspace bucket, zero tokens. | **This is the memory search** for `prior-art`. |
| **`gh` / `git` runners** — `execGh` (`packages/runtime/src/review-pr.ts`), `git(...)` in `review-worktree.ts`, allowlist for the *tool* path (`packages/runtime/src/command-tools.ts`) | Daemon-side `execFile` runners with timeouts; the MCP `command_execute` allowlist governs agent-invoked commands, not daemon-internal ones. | **Reuse `GhRunner` (injectable) and the `execFile`+cwd-anchored pattern.** |
| **`agentproto hook`** (`docs/cli/verbs/hook.md`) | A **Claude Code client-side** hook command that pulls the AIP-46 inbox. | **Name collision only** — unrelated mechanism. Config namespace is `hooks`, CLI (if any) is `agentproto hooks`. |
| **Free model roles** (`packages/runtime/src/model-roles.ts`) | Presets incl. `go-free` → `opencode-go/longcat-2.5-preview-free`; `adapterForModelId` derives the adapter. | **This is the free-model route** for the optional summary. |

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
  mode?: "async" | "sync"          // default "async"
  deliver: DeliverSpec             // where the block goes
  delayMs?: number                 // default 0; prior-art uses ~4000
  dedup?: DedupScope               // default "task" (see §4-R4)
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
  result?: Record<string, unknown> // e.g. agent_start → { descriptor: { id, cwd, … } }
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
   (phase-1 config does exactly this; §7).

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
| `sync` | Dispatcher awaits the enricher, bounded by `budget.timeoutMs` (clamped ≤ 2000 ms), and folds the block into the tool's own response. Failure/timeout ⇒ the block is simply absent. | Only `attach-to-task-meta` shapes where the caller must see the meta in the same response. |

`sync` never *fails* the tool call either — it can only make it ≤2s slower in
the worst case. The brief's "without blocking the tool call" is therefore
`async` for everything on the spawn/prompt path; `sync` exists for the meta
case and is documented as the bounded exception.

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
  sessionId: "$result.descriptor.id"   # spawned child (agent_start)
  # sessionId: "$caller.sessionId"     # push back to the delegator
  # taskId:    "$args.taskId"          # attach-to-task-meta
```

`$…` paths resolve against `ToolHookEvent`; an unresolvable path ⇒ delivery
skipped (event logged), never an error.

### 2.6 `budget`

```ts
interface Budget {
  timeoutMs?: number        // hard wall clock per run; default 20000, max 60000
  maxLlmCalls?: number      // default 0 = deterministic only
  maxTokens?: number        // per LLM call; default 0 (unset ⇒ enricher default)
  maxCostUsd?: number       // optional day-window cap, AIP-68 style
  model?: string | "free"   // "free" resolves through model-roles' free preset
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
        "deliver": { "to": "append-to-session-queue", "sessionId": "$result.descriptor.id" },
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
| 3 | **`gh pr list --search`**, merged **and** open, last 30 days | Two calls through the injectable `GhRunner` type (`packages/runtime/src/review-pr.ts`): `gh pr list --state merged --search "<kw> merged:>='<date>'" --limit 8 --json number,title,mergedAt,url` and the same with `--state open --search "<kw> updated:>=…"`. `gh` missing ⇒ step skipped, block still produced. | **0 tokens** (one `gh` process each) |
| 4 | **Memory search** | (a) BM25 brain, same call the `workspace_brain_query` tool makes: `brains.getBrain(slug).getProvider().query({ query, topK: 5 })` (`packages/runtime/src/brain-tools.ts`); (b) keyword pass over the workspace's `memory/**/MEMORY.md` (memory/v1 draft doctype) when present. | **0 tokens** |
| 5 | **Read `PROJECT.md` / `RAPPORT.md`** | Head-read both from `workspaceRoot` if present (≤80 lines / 4 KB each); extract section headings + any line containing a step-4 keyword. Missing file ⇒ skipped. | **0 tokens** |
| 6 | **Compose** the block (§3.3) | Template + truncation to `maxBlockLines` (15). Deterministic order: files → PRs → memory → decisions. | **0 tokens** |
| 7 | **Optional summary line** | Only if `budget.maxLlmCalls ≥ 1` **and** a free route resolves: one `ModelLike.complete({ system, prompt })` call (the shape `summarize-session-tool.ts` / `session-activity.ts` already use), `max_tokens ≤ 400`, `timeoutMs ≤ 8000`, model `"free"` → `model-roles` free preset (`opencode-go/longcat-2.5-preview-free`) or the OpenRouter path `session-titler.ts` already uses. No free route ⇒ **refuse the summary and ship the deterministic block** (AIP-68 §5 rule: a host without a free-route catalogue refuses the model pass rather than falling back to a paid one). | 0 or ~400 tokens, hard-capped |

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
- memory: mem_qc8f407g "Pygmalion prior-art check" (sess_5f9a3c38)
- decisions: PROJECT.md §Hooks; RAPPORT.md 2026-10-15 — "async enrichers, no per-message reviewer"
- summary: prior art is design-doc + merged PR 1858; extend rather than re-add.
First step: reply "modify existing" (name the file/PR) or "new" — then proceed.
</agentproto-enrichment>
```

(The `- summary:` bullet exists only when §3.2 step 7 ran; with
`maxLlmCalls: 0` — phase 1 of the rollout — the example above is 8 lines
instead of 9. Either way, well inside the 15.)

Rules: one bullet kind per line; evidence is quoted/verbatim (file path, PR
number + title, memory id + title) — no free-form claims about what the
existing work *does* beyond the optional step-7 line; if nothing at all was
found, the block is *replaced* by a single line
`Existing work detected: none — this looks new (checked git, PRs last 30d, memory).`
so silence is never ambiguous.

### 3.4 Delivery timing

1. `agent_start`'s handler returns normally (the caller already has
   `{ descriptor: { id } }`).
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
| **R1 — never block** | The tool handler is never awaited on hook work. `mode: "async"` dispatch is a `void` promise started after the handler resolves; `mode: "sync"` is clamped to `min(budget.timeoutMs, 2000)` and still cannot fail the call. |
| **R2 — never fail** | The whole dispatch path (`match` → enricher → deliver) is wrapped in one `try/catch`. Any throw, rejection, bad binding, missing session, or timeout resolves to a bus event + `console.warn` — identical posture to `maybeTitleSession`. A hook bug can never turn a valid `agent_start` into an error. |
| **R3 — timeout ⇒ no block** | Every subprocess has `timeout` and every LLM call `AbortSignal.timeout`; on expiry the partial result is discarded and the hook ends with `hook:skipped {reason:"timeout"}`. There is no retry by default (a retry would re-spend the budget on a delegation that already happened). |
| **R4 — dedup** | Default scope `"task"`: key = `"<hookId>:<taskId ?? targetSessionId ?? argsHash>"`. Implementation mirrors the titler's *set-before-await* guard (so concurrent triggers can't double-fire), plus `coalesceKey` on the queue arm so a burst collapses to one queued item with `coalescedCount++`. Scope `"session"` keys on the target session; `"none"` disables. `attach-to-task-meta` dedups for free (same meta key, last write wins). Persisted keys are optional in v1 (in-memory set, module scope, so it survives the per-request server rebuild and resets on daemon restart — acceptable: a restart also loses the window that mattered). |
| **R5 — containment** | No unhandled rejections: every dispatched promise gets its own `.catch`. Enricher authors get the guarantee for free by returning `null` instead of throwing. |
| **R6 — delivery safety** | Arms are only `queue` / `context-slice` / `meta`. A hook never interrupts, never force-delivers (`deliverWithinMs` unset), never steers into a turn the session started autonomously, never kills, and never spawns or re-prompts anything itself. The one cost it can incur is a queued item dispatching as a turn on an *idle* recipient — identical to AIP-46 `next-turn` on an idle recipient, and never forced. The dispatcher refuses a config that names an unknown `deliver.to` or pairs a deadline with `deliverVia: "interrupt" \| "auto"`. |
| **R7 — statelessness-safe** | Dispatcher, dedup sets and the enricher registry are module-scope (`background-jobs.ts` rule); nothing hook-shaped lives inside `registerSessionTools`'s closure. |
| **R8 — observable** | Bus events `hook:ran {hookId, enricher, deliverTo, ms, lines, llmCalls}` and `hook:skipped {hookId, reason}` on `session-event-bus.ts`; inspectable via `session_events_poll`, and (optional tool) `hook_list` returning the resolved config. `session_queue_list` shows the delivered item. |
| **R9 — injection hygiene** | The block is wrapped in an `agentproto-enrichment` envelope with `untrusted="true"`, sentinels escaped exactly like `escapeMessageBody`, capped at 15 lines / ~1500 chars, and carries only quoted evidence + a directive to *check*, never an instruction to *skip* checks. A prompt-injection attempt inside a PR title or memory body arrives as quoted data inside the envelope. |

---

## 5. Cost

| Path | Tokens | Money |
|---|---|---|
| keywords, `git grep`, 2× `gh pr list`, BM25 brain, file reads, block compose | **0** | 0 |
| optional step-7 summary | ≤400 out, ~1–1.5k in | free-tier model only (`budget.model: "free"`); hard `maxLlmCalls: 1` per run |
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
  llm(system: string, prompt: string, budget: Budget): Promise<string | null>  // free-tier only
}
export type Enricher = (ctx: EnricherContext) => Promise<EnrichmentBlock | null>
```

Shipped or planned:

| Enricher | Trigger (typical) | Steps | Deliver | LLM |
|---|---|---|---|---|
| **`prior-art`** (§3) | `agent_start` from a supervisor | grep + PRs + memory + PROJECT/RAPPORT | append-to-session-queue | optional, free |
| **`spec-echo`** — for user-facing features | `task_create` whose title/description matches `user-facing\|feature\|UX\|api` | read the workspace's spec/docs index (`specs/`, `docs/`, `WORK.md`), list ≤10 existing spec sections that already constrain the ask, so the agent implements *the* spec instead of inventing one | attach-to-task-meta (or prepend-to-prompt on a spawn) | optional one-line free summary |
| **`security-check`** | `agent_start` when args/files touch `auth\|token\|secret\|migrations\|.env\|workflows` | deterministic: `git grep` for the touched paths' auth/secret neighbours + AIP-7/AGENTS.md escalation globs already used by the merge gate (`scripts/agentflow/merge-gate.mjs`), producing a "these paths always escalate" note | prepend-to-prompt | none (0 tokens by construction) |

Rules for new enrichers: deterministic-first; LLM only for a summarising
sentence; must return `null` (not throw) on partial data; must fit
`maxBlockLines`; must be safe to run twice (dedup handles the rest).

---

## 7. Rollout

| Phase | Config | Gate |
|---|---|---|
| **0 — land, off** | Code + `hooks.enabled: false` (absent ⇒ off, `titler` precedent) | `pnpm test`, `pnpm check-types` |
| **1 — Pygmalion first** | One hook: `on: "agent_start"`, `match: { caller: { role: "supervisor", label: "pygmalion*" } }` (role is the coarse gate resolved per §2.2; the label — or `caller.agentId` for the AIP-42 manifest session — is what actually narrows to the Pygmalion brain), `run: prior-art`, `delayMs: 4000`, `deliver: append-to-session-queue`, `budget.maxLlmCalls: 0` (deterministic only) | Watch a dozen delegations: block appears in `session_queue_list`, no change to tool latencies, zero `hook:*` errors |
| **2 — cost opt-in** | Same hook with `maxLlmCalls: 1, model: "free"` | Free route present ⇒ summary line; absent ⇒ refusal logged, block unchanged |
| **3 — breadth** | `task_create` → `attach-to-task-meta`; `agent_prompt` (re-prompts of an existing child) → queue append with dedup `"task"` | — |
| **4 — other brains / other enrichers** | Per-workspace `HOOK.md`, `spec-echo`, `security-check` | — |

Kill switch: `hooks.enabled: false` (hot) — next call dispatches nothing.
Observability: `hook:ran` / `hook:skipped` on the bus, `session_queue_list`
for delivery, `config_get` over the `hooks.*` registry keys for the resolved
config. Rollout is
config-only from phase 1 on: no code change to widen or narrow.

---

## 8. Does this need an AIP amendment?

**Verdict: one short amendment to AIP-46 — not a new AIP.**

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

### 8.1 Draft amendment text (paste-ready, AIP-46)

````markdown
### Tool hooks and enrichers (draft, 2026-10-20)

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
  dedup?: "task" | "session" | "hook" | "none"   // default "task"
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
| `packages/runtime/src/tool-hook-dispatcher.ts` | Module-scope dispatcher: dedup sets (titler-style set-before-await), timer for `delayMs`, one `try/catch` around match→run→deliver, `hook:ran`/`hook:skipped` emission, sync clamp, `AbortSignal` budget wiring. |
| `packages/runtime/src/with-tool-hooks.ts` | `withToolHooks(server, dispatcher)` — the `tool-subset.ts`/`deferred-tools.ts` proxy: wraps the handler passed to `tool()`/`registerTool()`, awaits the *original* handler, then fires `dispatcher.fire({on: name, args, result, caller…})` and returns the untouched result. |
| `packages/runtime/src/tool-hook-enrichers/types.ts` | `Enricher`, `EnricherContext`, `EnrichmentBlock`. |
| `packages/runtime/src/tool-hook-enrichers/prior-art.ts` | §3 pipeline; ports injected (`gitGrep`, `gh`, `brainSearch`, `readWorkspaceFile`, `llm`). |
| `packages/runtime/src/tool-hook-enrichers/index.ts` | Registry `Map<string, Enricher>` + `registerEnricher`. |
| `packages/runtime/src/__tests__/tool-hooks.test.ts` | match/bind/dedup/timeout/never-fail/never-block (asserts the tool result is identical with hooks on/off). |
| `packages/runtime/src/__tests__/prior-art.test.ts` | keyword extraction, block ≤15 lines, partial-failure composition, free-route refusal. |
| `docs/design/tool-hooks-enrichers.md` | This document. |
| *(optional)* `packages/runtime/docs/mcp-tools/hook_list.md` + `hook_list` tool | Resolved-config inspection; regenerate `daemon-tool-names.generated.ts` via `pnpm --filter @agentproto/runtime gen:daemon-tool-names`. |
| *(§2.7b, second step)* `specs/resources/pending/hook/draft/HOOK.schema.json` | The `hook/v1` frontmatter draft, pending like `memory`. |

**Modified**

| File | Change |
|---|---|
| `packages/runtime/src/config-schema.ts` | `hooksConfigSchema` + top-level `hooks` key + `CONFIG_KEYS` entries (`apply: "hot"`). |
| `packages/runtime/src/config.ts` | `AgentprotoConfig.hooks?: HooksConfig` (+ the compile-time key check). |
| `packages/runtime/src/session-event-bus.ts` | `hook:ran` / `hook:skipped` event types. |
| `packages/runtime/src/task-ledger.ts` | One internal wiring verb, `setMeta(taskId, key, value, caller)`, cloned from `linkApproval`'s shape: no `rev`, last-write-wins on the `meta` map, `task:changed` on success. (`task-tools.ts` unchanged — hooks write through the ledger, not through a new MCP tool.) |
| `packages/runtime/src/session-follow-store.ts` | *(only if hooks should be followable)* append `"hook-ran"` / `"hook-skipped"` to `FOLLOW_EVENTS` (kebab, like every entry there); `session-follow-tools.ts` derives its `z.enum(FOLLOW_EVENTS)` from that one constant, so it needs no edit of its own. |
| `packages/runtime/src/index.ts` | Build the dispatcher at gateway construction (module scope), wrap the registration server with `withToolHooks` next to where `withDeferredTools` / `withToolSubset` are applied. |
| `packages/runtime/src/http-server.ts` | *(parity)* the handful of REST routes that duplicate a hooked tool (`POST /sessions/agent`, `POST /sessions/:id/prompt`) call `dispatcher.fire` too — MCP and REST must not diverge. |

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
  dedup?: "task" | "session" | "hook" | "none"
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
  /** mode:"sync" path: bounded by min(budget.timeoutMs, 2000); resolves null on timeout/failure. */
  fireSync(event: ToolHookEvent): Promise<EnrichmentBlock | null>
  list(): readonly ToolHook[]       // hook_list / config_get shape
}

// with-tool-hooks.ts
export function withToolHooks(server: McpServer, d: ToolHookDispatcher, deps: HookDeps): McpServer
// deps: resolveCaller(), registry (enqueuePrompt / sendMessage), taskLedger, brains, config reader

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

## 10. Summary

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
   work detected » block delivered ~4 s after spawn, so the agent's first
   step is answering "modify existing" or "new".
4. Async is normative: never await, never fail, timeout ⇒ no block, dedup
   per task (set-before-await + `coalesceKey`), delivery only via
   queue/context-slice/meta — never `interrupt`.
5. Deterministic steps cost 0 tokens; the only model step is optional,
   `≤400` output tokens on a **free** model with `maxLlmCalls: 1` and an
   explicit refusal when no free route exists.
6. **No new AIP**: one paste-ready AIP-46 amendment covers the delivery and
   non-blocking guarantees (§8.1); a standalone AIP waits until hooks can be
   user-authored code (AIP-40's parked sibling) — rollout starts config-only
   for the Pygmalion brain's delegations.
