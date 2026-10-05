# Supervision & events: never miss what matters, never spam

Status: design proposal (no runtime change in this PR). Prototype of the
central primitive: [`prototype/`](prototype/) (`node --test .plans/supervision-events/prototype/supervision-router.test.ts`).
Measurements: [`measure.py`](measure.py), [`measure_sentinels.py`](measure_sentinels.py).

## 1. Problem

A supervisor — a human through an assistant session, or an agent driving
other agents — has to know when a session it is responsible for needs it:
a turn ended and the session is waiting, it crashed, it asks a question, the
PR it opened is ready / merged / red. Today the daemon only *pushes* such
facts along a few hard-wired edges, each with its own semantics:

| Path | Who receives | Durable? | Notes |
|---|---|---|---|
| `message_parent` / `message_send` (`message-tools.ts`, `session-message.ts`) | the parent (siblings opt-in) | yes — `SessionDescriptor.inbox` (`sessions.ts:2035`) | **voluntary**: the child must call it |
| `[child-crashed]` (`supervisor-notify.ts`) | the parent | via `promptQueue` | only if spawned with `notifyParentOnCrash` (default false) |
| sentinels (AIP-60, `sentinel-runtime.ts`) | exactly **one** `target.sessionId` per watch | dedup `seen`, parked journal, webhook outbox | auto-watch targets the PR **author** (`sentinel-autolink.ts`) |
| completion policies (`supervisor.ts`) | the attaching session | `policies.json` | per-gate, explicit attach |
| `notifyUrl` / global webhook (`webhook-notifier.ts`) | an HTTP URL | no (fire-and-forget, 1 retry) | |
| `session_monitor`, `session_events_poll`, `sessions wait` | whoever is polling *right now* | no — in-memory bus + 1 000-event ring (`event-ring.ts`) | pull; lost on restart |

There is **no** automatic notice to anyone when a session's turn ends (only
crash, opt-in), **no** supervisor for a root session (a session with no parent
reaches no one), **no** way to add a second recipient except by creating a
second watch by hand, **no** "PR opened" or "PR ready" event, and **no** notion
of who is allowed to drive a session (any caller can `agent_prompt` anyone).

### Observed on 2026-10-05 (field report, generic shape)

1. A persistent assistant "brain" session is woken only by its own children's
   `message_parent` and by sentinels that target it. Root sessions started by a
   *different* supervisor (an external Claude Code session acting as a bridge)
   never wake it. Workaround: an LLM "watcher" session looping on
   `session_monitor` over a hand-maintained list of 4 sessions. Two PRs became
   ready without any notification because their author session was not in the
   list.
2. PR watches target the author; adding a second subscriber is manual; "PR
   opened" is not an event; watches stay `active` on PRs closed long ago.
3. A message to a busy session waits in the queue until the turn ends; two
   supervisors drove the same sessions in parallel without knowing it.
4. After a daemon restart or a compaction the supervisor rebuilds its picture
   from a summary — and loses the thread.

## 2. Measurements (real data, `~/.agentproto`, 2026-10-01 → 2026-10-05 16:35 UTC)

Window = the live registry (569 sessions: 237 roots, 131 children, 119 review
lanes, 82 cron runs). Scripts are in this folder; numbers below are their output.

**Definitions.** An *attention point* is a `turn-end` after which the session
sat idle ≥ 60 s (someone has to look). It is *pushed* if the session itself
sent a typed message during that turn (or a crash notice went out). It is
*observed* at the first of: next prompt/message into the session, or any
daemon session's tool call naming its id. Observation by an *external* client
that only reads (e.g. `session_list` from outside the daemon) is invisible, so
"never observed" is an upper bound and delays are upper bounds.

### 2.1 Session lifecycle events: almost nothing is pushed

| class | attention points | pushed to anyone | observed > 10 min later | never observed | p50 / p90 delay |
|---|---:|---:|---:|---:|---:|
| root | 843 | **1 (0 %)** | 310 (37 %) | 95 (11 %) | 5.6 min / **76 min** |
| child | 194 | 58 (30 %) | 35 (18 %) | 20 (10 %) | 1.5 min / 19 min |
| review lane | 117 | 8 | 3 | 107* | — |
| cron run | 100 | 0 | 34 | 44 | 17 min / 2 h |

\* review lanes are consumed in-process by the review runner, so "never
observed" is expected there; listed for completeness.

- Roots: 0 % pushed is structural — a root has no parent and nothing else
  routes its events. Part of the 843 are human-driven chats where the human
  *is* the observer; the rest (bridge-launched, CLI-launched work sessions) are
  exactly failure #1.
- Children: 70 % of their idle points relied on the parent polling, because
  the daemon never tells a parent a child's turn ended.
- 114 of 329 sessions' **last** turn-end was never followed up by anyone
  (14 of them ended on `error`/`aborted`).
- The two PRs of failure #1: the author (a root) ended its turn seconds after
  opening the first one; the next time anyone touched that session was 29.6
  min later, and the brain learned of the PR **66 min** after it opened (from a
  manual audit, not from an event).

### 2.2 Typed-message delivery latency (queued behind a busy turn)

| sender | n | p50 | p90 | max | > 10 min |
|---|---:|---:|---:|---:|---:|
| system (sentinels) | 637 | 0 s | 2.7 min | 43 min | 27 |
| child → parent | 125 | 0 s | **9.4 min** | 24 min | 11 |

Interruption side-effects in the same week (`notice` events): 119 turns cut by
a queue *deliver-now*, 77 by an `interrupt: true` prompt, 30 by stop requests;
60 sessions resumed after a daemon restart; 344 idle reaps.

### 2.3 PR watches: coverage holes, stuck watches, noise

- 103 PRs opened by daemon sessions: **19 (18 %) had no watch at all**, 71 had
  one (65 of those targeting the author), 13 had a second subscriber added by
  hand.
- 11 watches still `active`: **9 of them are on PRs that are already
  merged/closed** — their own poller's snapshot says so. Root cause (verified
  in `sentinel-providers/local-gh.ts:20,159`): the first poll is a silent
  baseline; if the PR is already terminal at that moment (merged 80 s after
  opening, or a watch created after the fact), no transition is ever seen, so
  no terminal event fires, the watch never expires, **and the merge is never
  notified** (one private-repo PR merged at 15:03 with 0 events delivered to
  its 2 watchers). They keep polling `gh` forever.
- Noise: 493 watch notices over 77 PRs (max 32 on one PR); **60 % are "Check
  suite success"** — one per CI batch that finishes in a different poll tick.
  There is no synthesized "PR is ready" event, so the reader has to infer it
  from a stream of partial greens.
- 29 events were *parked* (target dead/closed, no live parent) into
  `sentinels-parked.jsonl`, a journal nobody is notified about.

### 2.4 Who drives a session

- ≥ 11 sessions received prompts from an agent supervisor **and** from another
  driver (human or an external supervisor) in the same week, with no
  coordination primitive.
- **62 % of user prompts (844/1 356) carry no `source`** — after the fact it is
  impossible to tell a human from an external agent driver.

## 3. Invariants

The design is judged against these. Each one must be checkable by a sweep
(`supervision_health`), not just hoped for.

- **I1 Coverage.** Every live session has an *effective supervisor*: its own
  controller, else the nearest ancestor's subtree controller, else the
  workspace default supervisor. Resolution is deterministic.
- **I2 Reach.** Every event of priority ≥ `attention` about a supervised
  session reaches at least one **live** recipient's durable inbox within
  `escalateAfterMs`; if no live agent recipient exists it escalates to the
  workspace human fallback. "Nobody could receive it" is a reported fault,
  never a silent drop.
- **I3 At-least-once + idempotent.** Events have stable ids; inboxes dedup on
  `(recipient, eventId)`; a recipient's cursor advances only on ack; unacked
  entries survive restart and are redelivered.
- **I4 One driver.** At most one controller lease per session at a time
  (fencing `epoch`); prompts from a non-holder are refused (or, in warn mode,
  delivered and flagged); observers are read-only. Every prompt carries its
  provenance.
- **I5 No spam.** Per recipient, at most one *unread* entry per subject
  (coalescing); `info` never wakes anyone (digest only); a subject wakes again
  only if priority rises or it becomes terminal; quiet hours defer non-critical
  deliveries to humans.
- **I6 Bounded watches.** Every external watch has an owner and a terminal
  condition; a watch on an already-terminal subject delivers the terminal
  event immediately and closes (DeathWatch semantics); no watch stays active
  on a terminal subject past one reconciliation period.
- **I7 Continuity.** A supervisor's situation — unacked inbox, leases held,
  subscriptions, open subjects — is daemon state, not conversation state. After
  restart or compaction it is re-briefed from that state, not from a summary.

## 4. Prior art, and what we take from each

| System | Mechanism | Taken |
|---|---|---|
| Kubernetes `ownerReferences` | many owners, **at most one with `controller: true`**; cascading GC | the controller lease = the one `controller` edge; observers = non-controller refs; inherit along the owner chain |
| Kubernetes informers / controllers | list-watch with `resourceVersion` + periodic **resync**; level-triggered reconcile | durable cursor; a reconciliation sweep that re-derives "what needs attention" from state, so a lost edge-trigger is caught (I2, I6) |
| Erlang/OTP supervision trees, Akka | supervisor per subtree; failure **escalates** to the parent supervisor; `monitor` (one-way) vs `link`; Akka **DeathWatch** delivers `Terminated` even when the watch is registered after death | escalation of a dead controller up the tree, then to a human; watch-after-terminal fires immediately |
| Temporal | durable event history, signals, workflow state rebuilt by replay; activities at-least-once | supervisor state rebuilt from the journal (I7); at-least-once + idempotency keys |
| GitHub webhooks | at-least-once, `X-GitHub-Delivery` id for dedup, redelivery API, no ordering guarantee | stable event ids, redelivery, consumers must be idempotent |
| Prometheus Alertmanager / PagerDuty | `group_by`, `group_wait`, `group_interval`, `repeat_interval`, inhibition, silences, severities, escalation policies | priority levels, coalescing by subject, digest, quiet hours, escalation timeout |
| Kafka consumer groups | per-consumer committed offset | per-recipient cursor = ack |
| CloudEvents 1.0 | envelope | already used by AIP-60 sentinel events — reuse as the bus envelope |

## 5. Architectures compared

### A. Patch each edge
Fix the sentinel baseline bug; auto-notify parents on child turn-end; let a
watch have N targets; add a `workspace.defaultSupervisor` that sentinels and
`supervisor-notify` fall back to; add an ownership check to `agent_prompt`.

- \+ Smallest diffs, ships in days.
- − Six delivery paths keep six semantics (dedup here, outbox there, fire-and-
  forget elsewhere); every new event source re-implements routing; no single
  place to apply noise policy or to check I2; continuity (I7) still absent.

### B. Workspace journal + subscriptions + supervision edges, delivered into the existing durable inbox (**recommended**)
One append-only, per-workspace **journal** of normalized CloudEvents (session
lifecycle from `SessionEventBus`, sentinel events, policy outcomes, cron
health). A **router** resolves recipients for each event from declarative
**subscriptions** and **supervision edges** (controller lease + observers,
inheritable to a subtree; workspace default for roots) and materializes
deliveries into the **existing** per-session `inbox` (or the human fallback).
Noise policy lives in one place: the inbox's coalescing + priority rules.
A **reconciliation sweep** checks the invariants against state, catching any
missed edge-trigger. External watches become **repo-level providers** that
publish into the journal; "per-PR sentinel targeting one session" becomes
"a subscription filtered on a subject".

- \+ One delivery semantics (at-least-once, dedup, ack, coalesce) for every
  source; inheritance and defaults make I1 hold by construction; durable
  cursor gives replay after restart; continuity = "brief me from my unacked
  inbox". Reuses inbox, `promptQueue`/steer delivery, CloudEvents envelope,
  sentinel dedup/outbox machinery.
- − New persistent store (journal + subscriptions + edges); a migration of
  sentinel targets; lease enforcement changes `agent_prompt` behavior (needs a
  warn phase).

### C. External broker / workflow engine (NATS JetStream, Redis Streams, Temporal)
- \+ Battle-tested delivery guarantees, consumer groups, replay.
- − Breaks the zero-infra local daemon (a broker process or a cloud service per
  host); still needs our own routing/inheritance/lease/noise logic on top —
  the hard part of this problem is *who* and *how loud*, not the transport.
  Could be added later as a journal backend behind the same interface.

**Recommendation: B**, delivered as small PRs where the first ones are
architecture-A-sized bug fixes that are useful regardless.

## 6. Recommended design (B) in detail

### 6.1 Data model

```ts
// Journal entry — CloudEvents 1.0 + agentproto extensions.
// ~/.agentproto/workspaces/<slug>/events/journal-<n>.jsonl (rotated, bounded by age/size)
interface BusEvent {
  specversion: "1.0"
  id: string            // stable; a redelivered fact keeps its id
  seq: number           // per-workspace monotonic offset, assigned on append
  source: string        // "//agentproto.local/session" | "//agentproto.local/sentinel/local-gh" | …
  type: string          // see 6.2
  subject: string       // "session:<id>" | "github:<owner>/<repo>#<n>" | "policy:<id>" | …
  time: string
  workspace: string
  sessionid?: string    // the session the event is ABOUT (author for PR events)
  lineage?: string[]    // sessionid's ancestors, nearest-first, frozen at emit time
  priority: "critical" | "attention" | "info"
  coalescekey?: string  // default = subject
  terminal?: boolean
  summary: string
  data?: unknown
}

// Explicit supervision edge — distinct from parent/child lineage.
// Stored on the session row (`supervision`) + an index in the workspace store.
interface SupervisionEdge {
  sessionId: string
  role: "controller" | "observer"
  holder: { kind: "session"; id: string } | { kind: "human"; channel: string }
  scope: "self" | "subtree"
  epoch: number         // fencing token, bumped on every controller change
  leaseUntil?: string   // optional TTL; renewed by holder activity
  createdBy: string     // provenance
}

// Declarative subscription. ~/.agentproto/workspaces/<slug>/subscriptions.json
interface Subscription {
  id: string
  subscriber: SupervisionEdge["holder"]
  workspace: string
  types?: string[]                       // exact or "prefix.*"
  subjects?: string[]                    // exact or "github:org/repo#*"
  session?: { id: string; scope: "self" | "subtree" }
  labels?: string[]                      // session labels / PR labels
  minPriority?: "critical" | "attention" | "info"
  delivery?: "wake" | "inbox" | "digest" // default by priority, see 6.4
  until?: { kind: "subject_terminal" } | { kind: "at"; ms: number } | { kind: "never" }
  cursor: number                         // last acked seq (per subscriber)
}

// Workspace-level supervision config. workspaces.json → <slug>.supervision
interface WorkspaceSupervision {
  defaultController?: SupervisionEdge["holder"]  // inherited by every ROOT session
  fallback?: { kind: "human"; channel: string }  // notify URL / chat relay
  escalateAfterMs?: number                       // default 120_000
  quietHours?: { start: number; end: number; tz: string }
  lease?: { mode: "off" | "warn" | "enforce" }   // rollout switch for I4
}

// Inbox entry — the EXISTING SessionMessage, extended (backward compatible).
interface SessionMessage /* + */ {
  eventId?: string; seq?: number; coalesceKey?: string
  count?: number          // events folded into this entry since last ack
  priority?: "critical" | "attention" | "info"
}
```

### 6.2 Event vocabulary (normalized types)

Session (from `SessionEventBus`, which already has them in-process):
`agentproto.session.spawned`, `.turn_ended` (with `idle: true` when nothing is
queued), `.awaiting_input`, `.permission_requested`, `.exited`, `.crashed`,
`.stalled`, `.resumed`, `.reaped`, `.handoff_suggested`;
`agentproto.message.sent` (typed messages, so observers see the conversation);
`agentproto.policy.done|failed`; `agentproto.cron.unhealthy`.

GitHub (repo-level provider): `github.pull_request.opened`, `.ready`
(**synthesized**: open ∧ not draft ∧ required checks success or none ∧ review
not `CHANGES_REQUESTED`; emitted once per head sha), `.closed` (merged flag),
`.reopened`, `.synchronize`, `github.check_suite.completed`,
`github.pull_request_review.submitted`, `github.issue_comment.created`.

Default priorities: `critical` = crashed, permission_requested, blocker
message, CI failure on a PR that was `ready`; `attention` = turn_ended+idle,
awaiting_input, pr.opened, pr.ready, pr.closed, review `CHANGES_REQUESTED`,
policy.failed; `info` = everything else (check successes, synchronize,
review commented, spawned, resumed).

### 6.3 Routing (prototype: `route()`, `effectiveController()`)

```
recipients(e) = { s.subscriber | s ∈ subscriptions, matches(s, e) }        // incl. subtree via e.lineage
              ∪ { observers of e.sessionid and of ancestors with scope=subtree }
              ∪ { effectiveController(e.sessionid) }
effectiveController(x) = own controller if live
                       | nearest ancestor's subtree controller if live      // dead holder ⇒ keep climbing (Erlang escalation)
                       | workspace.defaultController if live
drop dead session recipients and the session itself;
if none live and priority ≥ attention ⇒ + workspace.fallback (escalated)
if still none ⇒ fault "undeliverable" (counted by supervision_health)
```

Inheritance is resolved **at routing time** from the lineage, not copied onto
children at spawn, so adding a subtree subscription later covers sessions that
already exist (the field report's watcher had to be told about each new session).

### 6.4 Delivery and noise (prototype: `Inbox.deliver()`)

- Delivery target is the recipient's durable `inbox` (already persisted on the
  session row). Waking reuses today's paths: idle → own turn; busy →
  `promptQueue` as its own item; `critical` + steering-capable → `steer`
  (#1721). Human fallback → the notify URL / relay.
- Dedup on `(recipient, eventId)`. Coalesce on `(recipient, coalescekey)` while
  unacked: the entry is updated in place (`count++`, latest `summary` = current
  state). It wakes again only if priority rises or the event is terminal.
- `info` → digest only (surfaced when the recipient next wakes, or by
  `inbox_list`). This alone turns "20 × Check suite success" into one line
  inside the `pr.ready` notification.
- Quiet hours apply to human recipients only, never to `critical`.
- Rate cap per recipient (e.g. ≤ 1 wake / 30 s, burst 3): excess folds into
  the next wake as a digest.
- Ack: consuming an entry into a turn acks it (today's behavior); `inbox_ack`
  acks explicitly; the subscription cursor = highest contiguous acked seq.

### 6.5 Leases (I4)

- `supervise {sessionId, role:"controller"}` takes the lease if free (or if the
  holder is dead), bumping `epoch`. `takeover: true` steals it and sends the
  previous holder an `attention` notice ("you are no longer driving X").
- `agent_prompt` / `message_send` with control intent from a non-holder:
  `warn` mode → delivered, flagged in the transcript and returned as a warning
  naming the holder; `enforce` mode → refused with `not_controller {holder,
  epoch}`; the caller can become an observer or ask the holder.
- Spawning a child makes the spawner its controller (`scope: subtree` by
  default) — today's parent edge becomes an explicit, transferable edge.
- Humans are first-class holders (`{kind:"human"}`), so "the user is driving
  this one himself" is representable and agents back off.
- Every prompt gets a `source` (`agent:<id>`, `human:<channel>`,
  `external:<client>`, `daemon:<reason>`), closing the 62 % attribution gap.

### 6.6 Repo-level watches (I6)

- One provider watch per `(repo, provider)`, not per PR. `local-gh` polls
  `gh pr list --state all --search updated:>=<cursor>` (one call per repo per
  tick instead of one per PR) and diffs per PR; `webhook`/`agentpush` push.
- Lifetime: the repo watch lives while ≥ 1 subscription matches its subjects;
  per-PR subjects close on terminal events. A subject already terminal at
  watch start emits its terminal event immediately (fix for §2.3).
- `sentinel.autoWatchPrs` becomes: when a session records an opened PR, emit
  `github.pull_request.opened` (sessionid = author) and ensure the repo watch
  exists. The author's controller (and anyone subscribed to the repo) now gets
  it through routing — no per-PR wiring, no "second subscriber by hand".

### 6.7 Continuity (I7)

`supervision_brief {sessionId}` returns, from daemon state only: leases held,
subscriptions, unacked inbox entries (coalesced, priority-sorted), subjects
still open (PRs not terminal, sessions not ended) with their latest state, and
the journal cursor. The daemon injects it (a) into the first turn after a
resume/restart — reusing the `pendingResumeContext` slot (`sessions.ts:2072`) —
and (b) right after a compaction / `session_continue_fresh` checkpoint. The
summary may forget; the brief cannot, because it is not derived from the
conversation.

### 6.8 Reconciliation sweep (`supervision_health`)

Every N seconds (and on boot): for each live session, recompute the effective
supervisor (I1); list unacked `attention+` entries older than
`escalateAfterMs` whose recipient is dead/idle-reaped and escalate (I2); list
watches whose subject is terminal but still active and close them (I6); list
sessions with two distinct prompt drivers in the last hour (I4 warn data).
Exposed as a verb and in `daemon_health`.

## 7. API surface

MCP (all also on REST under `/supervision/*`, `/subscriptions/*`, `/events/*`):

| Verb | Input → output |
|---|---|
| `supervise` | `{sessionId, role: "controller"\|"observer", scope?: "self"\|"subtree", holder?, takeover?}` → edge (+ previous holder) |
| `unsupervise` | `{sessionId, role?}` |
| `supervision_get` | `{sessionId}` → own edges, inherited edges, effective controller and how resolved |
| `subscribe` | `{types?, subjects?, session?, labels?, minPriority?, delivery?, until?}` → subscription (subscriber = caller) |
| `unsubscribe`, `subscription_list` | |
| `events_read` | `{cursor?, types?, subjects?, sessionIds?, limit?, waitMs?}` → `{events, nextCursor}` — durable replacement for `session_events_poll`/`session_monitor` |
| `inbox_list` / `inbox_wait` / `inbox_ack` | unchanged signatures; entries gain `eventId, seq, count, priority`; `inbox_ack {throughSeq}` |
| `workspace_supervision_set` / `_get` | `{defaultController?, fallback?, escalateAfterMs?, quietHours?, lease?}` |
| `supervision_brief` | `{sessionId?}` (default caller) → situation report (6.7) |
| `supervision_health` | → invariant report (6.8) |

`agent_start` gains `supervise?: {role, scope}` (default: caller becomes
controller, subtree) and `observers?: Party[]`. `sentinel_watch` keeps working
and is re-expressed as `subscribe` + ensure-repo-watch.

CLI:

```
agentproto supervise <session> [--observer] [--subtree] [--takeover]
agentproto supervision show <session> | brief [<session>] | health
agentproto subscribe [--type github.pull_request.*] [--repo org/repo] [--session <id> --subtree] [--label x] [--min-priority attention]
agentproto subscriptions [rm <id>]
agentproto events tail [--follow] [--type …] [--subject …] [--from <seq>]
agentproto inbox [--ack-through <seq>]
agentproto workspace supervisor set <session|human:channel> [--fallback <url>] [--quiet 22-8]
```

## 8. Migration from today

| Today | Becomes | Compatibility |
|---|---|---|
| `SessionEventBus` (in-process) | unchanged; the journal is a new subscriber (tee) | none needed |
| `EventRing` + `session_events_poll` + `session_monitor` | still served; `events_read` reads the journal | old verbs kept, documented as "volatile" |
| `message_parent` / typed messages | unchanged API; also journaled as `agentproto.message.sent` | none |
| `notifyParentOnCrash` | subsumed: crash is `critical` and the parent is the controller | flag becomes a no-op default-on, kept for one minor |
| per-PR sentinel `target.sessionId` | subscription `{subjects:[pr], subscriber:target}` + repo watch | `sentinel_*` verbs map onto it; existing rows migrated at boot |
| `sentinels-parked.jsonl` | events with no live recipient go to the fallback; the file stays as an audit log | |
| completion policies | unchanged; their outcomes are journaled | |
| `notifyUrl` / global webhook | a human party; the global URL is the default `fallback` | |
| parent/child | parent becomes the default controller edge (`subtree`) | lease mode starts `off`, then `warn`, then `enforce` |

## 9. Plan — small, independent PRs

Each PR is shippable alone; the first three are bug fixes worth doing even if
the rest is never built.

1. **fix(sentinel): deliver + expire a watch whose subject is already terminal
   at baseline.** `local-gh` baseline poll: if the PR is merged/closed, emit the
   terminal event and expire. Boot-time sweep closes today's stuck watches.
   (I6; §2.3 — 9 stuck watches, 1 silent merge.)
2. **feat(sentinel): coalesce CI noise + synthesize `pull_request.ready`.**
   Provider emits one `ready` per head sha; `check_suite.completed` success
   becomes `info`. (I5; −60 % notices.)
3. **feat(runtime): prompt provenance everywhere.** Every prompt path stamps
   `source`; external MCP clients get `external:<clientInfo.name>`. (I4 data.)
4. **feat(runtime): workspace journal (write-only tee).** Append normalized
   events from `SessionEventBus` + sentinel runtime to
   `workspaces/<slug>/events/`; rotation; `agentproto events tail`. No behavior
   change.
5. **feat(runtime): `events_read` durable cursor read** (+ long-poll), REST
   `/events`. Old verbs untouched.
6. **feat(runtime): supervision edges + effective-controller resolution**
   (`supervise`, `supervision_get`, `workspace_supervision_set`), lease mode
   `off` — data only.
7. **feat(runtime): router → inbox with dedup/coalescing/priority**
   (the prototype's `route` + `Inbox`), behind
   `config.supervision.router: true`. Delivers `turn_ended+idle`, `crashed`,
   `awaiting_input` to effective controllers — this is the PR that fixes
   failure #1 (roots reach the workspace default).
8. **feat(runtime): `subscribe` / `unsubscribe` / `subscription_list`**, subtree
   + label filters.
9. **feat(sentinel): repo-level watch + `pull_request.opened`**, re-expressing
   per-PR sentinels as subscriptions; migrate rows at boot. (Failure #2.)
10. **feat(runtime): escalation + human fallback + quiet hours**, and
    `supervision_health` sweep. (I2, I5, I6 checked.)
11. **feat(runtime): lease `warn` mode** on `agent_prompt`/control messages;
    `takeover`; then **`enforce`** as a separate one-line default flip after a
    week of warn data. (Failure #3.)
12. **feat(runtime): `supervision_brief` + injection on resume/compaction.**
    (Failure #4.)

After 7 + 9 the LLM watcher session of the field report is unnecessary.

## 10. Open questions / decisions needed

1. **Default supervisor for roots**: per workspace (proposed) or per daemon?
   And what is the default when unset — the human fallback only, or "the
   oldest live `keepAlive` supervisor session"? (Proposed: unset ⇒ fallback only,
   explicit opt-in to make an agent the default.)
2. **Lease enforcement**: do we accept that, once `enforce` is on, a second
   supervisor's `agent_prompt` is refused (it must take over or ask)? Humans
   always allowed to take over?
3. **Turn-end notifications to the controller**: every idle turn-end of a
   child is `attention` (wakes the parent) — or only the *final* one / ones
   with a question? Proposed: `attention` but coalesced per child, so a chatty
   child costs one unread entry.
4. **Journal retention**: proposed 7 days or 100 MB per workspace.
5. **Where this lives**: an AIP (extend AIP-46 messages + AIP-60 sentinels, or
   a new "supervision" AIP) before code, or code first behind flags?
6. This folder is under `.plans/` which `.gitignore` excludes ("kept locally");
   it was force-added because the brief asked for this path. Keep it here, or
   move to `docs/design/`?
