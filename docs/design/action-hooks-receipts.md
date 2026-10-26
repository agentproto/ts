# Action hooks: idempotent reaction receipts with boot reconciliation

Pinned commit: de667d623683eeb1a244dbaf93f288679d7b41ad. Every line number in
sections 1 to 3 is pinned to that commit and will drift on `main`; read them
with `git show de667d6:<path>`.

Status: design proposal for the first runtime step of action hooks v1 (AIP-71).
This document adds no code. Sections 1 to 3 are facts about the pinned
commit and carry citations. Sections 4 to 9 are proposals and carry no
citations unless they cite an existing pattern they intend to reuse.

Terminology follows `docs/design/action-hooks-v1.md`: a reaction is an AIP-37
event bound to an AIP-39 action, and a receipt is the durable record of an
attempt. The AIP-71 local dedupe key is
`<session-id>/<event>/<occurrence-id>/<binding-id>`.

## 1. Facts: the existing sentinel webhook outbox

### File and role

The durable precedent is `packages/runtime/src/sentinel-webhook-outbox.ts`. It
exists for `webhook` sentinel events whose delivery is external to the daemon:
`packages/runtime/src/sentinel-webhook-outbox.ts:2` ` * SentinelWebhookOutbox`.
The module doc states the core invariant, that a row is appended durably before
the upstream is acknowledged: `packages/runtime/src/sentinel-webhook-outbox.ts:5` ` * Why an outbox: the runtime's `processEvents` marks an event `seen` the`.

### Public API

The public surface is declared on one interface:
`packages/runtime/src/sentinel-webhook-outbox.ts:104` `export interface SentinelWebhookOutbox {`.
It provides `enqueue` at
`packages/runtime/src/sentinel-webhook-outbox.ts:118` `  enqueue(input: { sentinelId: string; event: SentinelEvent }): Promise<SentinelWebhookOutboxRow | undefined>`,
`dispatch` at
`packages/runtime/src/sentinel-webhook-outbox.ts:122` `  dispatch(): Promise<void>`,
`resumeDeliveries` at
`packages/runtime/src/sentinel-webhook-outbox.ts:125` `  resumeDeliveries(): Promise<void>`,
`sweep` at
`packages/runtime/src/sentinel-webhook-outbox.ts:128` `  sweep(): void`,
`rows` at
`packages/runtime/src/sentinel-webhook-outbox.ts:129` `  rows(): PersistedOutboxRow[]`
and `flushSync` at
`packages/runtime/src/sentinel-webhook-outbox.ts:131` `  flushSync(): void`.

### Record shape

The persisted row is `SentinelWebhookOutboxRow` plus the envelope and original
event. The base type starts at
`packages/runtime/src/sentinel-webhook-outbox.ts:54` `export interface SentinelWebhookOutboxRow {`
and carries `requestId` at
`packages/runtime/src/sentinel-webhook-outbox.ts:59` `  requestId: string`,
`eventId` at
`packages/runtime/src/sentinel-webhook-outbox.ts:60` `  eventId: string`,
the exact wire body at
`packages/runtime/src/sentinel-webhook-outbox.ts:63` `  bodyBytes: string`,
an always-null cursor at
`packages/runtime/src/sentinel-webhook-outbox.ts:65` `  cursor: null`,
attempt state at
`packages/runtime/src/sentinel-webhook-outbox.ts:67` `  deliveryState: { attempts: number; lastError?: string; lastAt?: string }`,
status at
`packages/runtime/src/sentinel-webhook-outbox.ts:68` `  status: SentinelWebhookOutboxStatus`,
creation time at
`packages/runtime/src/sentinel-webhook-outbox.ts:74` `  createdAt: number`
and terminal time at
`packages/runtime/src/sentinel-webhook-outbox.ts:76` `  terminalAt?: number`.
The persisted extension at
`packages/runtime/src/sentinel-webhook-outbox.ts:83` `export type PersistedOutboxRow = SentinelWebhookOutboxRow & {`
keeps the full `envelope` and the original `event` alongside the row.

Rows are keyed in memory by a string built from sentinel and event:
`packages/runtime/src/sentinel-webhook-outbox.ts:224` `  const rowKey = (sentinelId: string, eventId: string): string => `${sentinelId}::${eventId}``.
The persisted JSON is a map keyed by that same string, loaded at construction:
`packages/runtime/src/sentinel-webhook-outbox.ts:265` `    for (const [key, row] of rows.entries()) out[key] = row`.

### Storage format and location

The default file is `~/.agentproto/sentinel-webhook-outbox.json`:
`packages/runtime/src/sentinel-webhook-outbox.ts:199` `  const filePath = opts.filePath ?? resolve(agentprotoHome(), "sentinel-webhook-outbox.json")`.
The body is pretty-printed JSON with a trailing newline:
`packages/runtime/src/sentinel-webhook-outbox.ts:279` `      const body = JSON.stringify(snapshot(), null, 2) + "\n"`.

### Atomicity and locking

Writes use the shared durable file writer:
`packages/runtime/src/sentinel-webhook-outbox.ts:280` `      await writeFileDurable(filePath, body, { commitIf: () => generation === syncGeneration })`.
That helper is documented as tmp plus fsync plus rename plus parent directory
fsync: `packages/runtime/src/durable-file.ts:2` ` * Crash-durable file writes: tmp file → fsync → rename → fsync of the parent`.
It defaults to mode `0o600`:
`packages/runtime/src/durable-file.ts:42` `  const mode = opts.mode ?? 0o600`.
The outbox serializes all writes through one promise chain:
`packages/runtime/src/sentinel-webhook-outbox.ts:257` `  // All writes ride ONE serialized chain so a slow older snapshot can never`
and `packages/runtime/src/sentinel-webhook-outbox.ts:270` `  let writeTail: Promise<void> = Promise.resolve()`.
Enqueue awaits its own write, so durability precedes the caller's ack:
`packages/runtime/src/sentinel-webhook-outbox.ts:463` `      enqueueDispatch()` is reached only after the awaited persist, and a failed
persist rolls the row back and rejects, cited in the interface contract at
`packages/runtime/src/sentinel-webhook-outbox.ts:118` `  enqueue(input: { sentinelId: string; event: SentinelEvent }): Promise<SentinelWebhookOutboxRow | undefined>`.
Status transitions use a debounced write, while enqueue never debounces:
`packages/runtime/src/sentinel-webhook-outbox.ts:139` `  /** Debounce interval for the non-critical (status-transition) disk writes.`.

### Retry and backoff

The outbox itself does not implement HTTP retry. It delegates to
`deliverEventEnvelope`, whose bounded loop is 5 attempts:
`packages/runtime/src/webhook-egress/delivery.ts:109` `export const MAX_ATTEMPTS = 5`
and `packages/runtime/src/webhook-egress/delivery.ts:164` `  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {`.
Backoff is exponential with a cap:
`packages/runtime/src/webhook-egress/delivery.ts:114` `export function deliveryBackoffDelay(attempt: number): number {`.
The loop sleeps between attempts:
`packages/runtime/src/webhook-egress/delivery.ts:165` `    if (attempt > 0) await sleep(deliveryBackoffDelay(attempt))`.
A thrown dispatch is treated as crash-shaped: the row stays `pending`, the
event stays unacked, and startup re-dispatches it:
`packages/runtime/src/sentinel-webhook-outbox.ts:376` `      // `resumeDeliveries()` re-runs it by exact bytes next startup.`.
A final negative outcome is terminal per the retry cap:
`packages/runtime/src/sentinel-webhook-outbox.ts:362` `        row.status = "dead"`.

### Retention and compaction

Delivered rows are reaped after 24 hours:
`packages/runtime/src/sentinel-webhook-outbox.ts:171` `const DELIVERED_REAP_MS = 24 * 60 * 60 * 1000`.
Pending rows age out after 7 days:
`packages/runtime/src/sentinel-webhook-outbox.ts:175` `const PENDING_AGE_OUT_MS = 7 * 24 * 60 * 60 * 1000`.
The file is capped at 2000 rows:
`packages/runtime/src/sentinel-webhook-outbox.ts:178` `const ROW_CAP = 2_000`.
Sweep marks an old pending row dead with reason `age_out`:
`packages/runtime/src/sentinel-webhook-outbox.ts:483` `          row.status = "dead"`.
Sweep also reaps delivered rows and trims beyond the cap, starting at
`packages/runtime/src/sentinel-webhook-outbox.ts:482` `        if (row.status === "pending" && now - row.createdAt >= PENDING_AGE_OUT_MS) {`.
Terminal eviction picks the oldest terminal row:
`packages/runtime/src/sentinel-webhook-outbox.ts:334` `      row.status = "dead"` is the expiry path, while the cap eviction helper
is `oldestTerminalRowKey`, cited through the enqueue cap branch at
`packages/runtime/src/sentinel-webhook-outbox.ts:178` `const ROW_CAP = 2_000`.

### How callers use it

The sentinel runtime constructs the outbox and wires the ack to terminal status:
`packages/runtime/src/sentinel-runtime.ts:368` `  const outbox = createSentinelWebhookOutbox({`
and `packages/runtime/src/sentinel-runtime.ts:396` `    onTerminal: (sentinelId: string, row: SentinelWebhookOutboxRow): void => {`.
The webhook fire path enqueues and only acks on terminal:
`packages/runtime/src/sentinel-runtime.ts:730` `          await outbox.enqueue({ sentinelId: current.id, event })`.
The periodic tick sweeps:
`packages/runtime/src/sentinel-runtime.ts:831` `      outbox.sweep()`.
Startup re-dispatches every persisted pending row:
`packages/runtime/src/sentinel-runtime.ts:930` `      await outbox.dispatch()`.

### Test coverage

Durability tests live in
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts`. They cover
on-disk-before-resolve, crash after enqueue, tmp cleanup, rollback on write
failure, duplicate enqueue, and flush precedence. The crash test is explicit:
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:69` `  it("crash right after enqueue (before any debounced flush) loses nothing: a fresh outbox resumes the row", async () => {`
and it abandons the first instance at
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:73` `    // "Crash": the first instance is abandoned`.
Behavioural tests live in
`packages/runtime/src/__tests__/sentinel-webhook-outbox.test.ts`, including
idempotency at
`packages/runtime/src/__tests__/sentinel-webhook-outbox.test.ts:75` `  it("enqueue is idempotent per (sentinelId, eventId)`
and restart resume by exact bytes at
`packages/runtime/src/__tests__/sentinel-webhook-outbox.test.ts:133` `  it("restart resume: the pending row is re-dispatched by the EXACT stored bytes (no re-serialization)", async () => {`.

## 2. Facts: other durable guards a reaction could lean on

### Idle reaper

The sweep entry point is
`packages/runtime/src/idle-reaper.ts:198` `export function runIdleReapPass(opts: {`.
Eligibility requires a running row:
`packages/runtime/src/idle-reaper.ts:161` `  if (desc.status !== "running") return false`
and excludes `keepAlive`:
`packages/runtime/src/idle-reaper.ts:166` `  if (desc.keepAlive === true) return false`.
The mutation is `registry.reapIdle`:
`packages/runtime/src/idle-reaper.ts:246` `    if (registry.reapIdle(d.id, idle)) {`.
That primitive refuses anything not running agent-cli:
`packages/runtime/src/sessions.ts:13536` `      if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {`.
The descriptor mutation is persisted:
`packages/runtime/src/sessions.ts:13600` `      schedulePersist()`.
Durable fact: the descriptor's status and `endedReason` are persisted on the
session row (`packages/runtime/src/sessions.ts:1416` `  status: SessionStatus`
and `packages/runtime/src/sessions.ts:1475` `  endedReason?: SessionEndReason`).
Replay after a crash is safe: after the first reap the status is no longer
`running`, so a second pass refuses at the cited guard. Re-running the sweep
does not produce a second durable retirement.

### Workspace brain subscriber

The subscriber listens for exits:
`packages/runtime/src/workspace-brain-subscriber.ts:93` `      unsubscribe = bus.on("session:exited", onExit)`.
Its queue and debounce are in memory only:
`packages/runtime/src/workspace-brain-subscriber.ts:40` `  const debounceMs = opts.debounceMs ?? 5_000`
and `packages/runtime/src/workspace-brain-subscriber.ts:42` `  const pending = new Set<string>()`.
It calls `ingestSession` per exited session:
`packages/runtime/src/workspace-brain-subscriber.ts:67` `        const result = await brains.getBrain(workspace).ingestSession(sessionId)`.
Ingestion is idempotent by session id. The pipeline reads the durable ledger and
skips an already recorded session:
`packages/workspace-brain/src/ingest-pipeline.ts:84` `    const existing = await state.read()`
and `packages/workspace-brain/src/ingest-pipeline.ts:88` `        return { sessionId, ok: true, skipped: "already-ingested" }`.
What it writes: source documents in the brain knowledge directory plus a
ledger record:
`packages/workspace-brain/src/ingest-pipeline.ts:170` `      await state.record(record)`.
The ledger is `brain-state.json`:
`packages/workspace-brain/src/brain-state.ts:34` `export const BRAIN_STATE_FILENAME = "brain-state.json"`
and it is described as written atomically:
`packages/workspace-brain/src/brain-state.ts:6` ` * written ATOMICALLY (tmp + rename, mirroring `writeBucketSnapshot` in the`.
Replay after a crash is safe for the ledger, because a completed ingest returns
`skipped: "already-ingested"`. A replay before the ledger record lands rewrites
the same deterministic chunk URIs with the same content. The subscriber's own
pending queue is not durable, so a queued exit is lost on restart, but the
ingest itself can be rediscovered from the persisted session row.
The subscriber exposes no boot backlog pass, only `start`, `stop` and `flush`:
`packages/runtime/src/workspace-brain-subscriber.ts:29` `  start(): void`,
`packages/runtime/src/workspace-brain-subscriber.ts:31` `  stop(): void`,
`packages/runtime/src/workspace-brain-subscriber.ts:33` `  flush(): void`.
Ingest idempotency is therefore durable, but the trigger is not.

### Archive

`archiveSession` starts at
`packages/runtime/src/sessions.ts:13906` `    archiveSession(id) {`.
It refuses a live row:
`packages/runtime/src/sessions.ts:13912` `      const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"`.
It then sets the durable flag and timestamp:
`packages/runtime/src/sessions.ts:13919` `      rt.desc.archived = true`
and `packages/runtime/src/sessions.ts:13920` `      rt.desc.archivedAt = new Date().toISOString()`,
persists them at
`packages/runtime/src/sessions.ts:13921` `      schedulePersist()`
and calls the retirement hook at
`packages/runtime/src/sessions.ts:13922` `      retireRow(rt, "archived")`.
There is no already-archived guard in this method: a second call on a terminal
archived row repeats the assignment, the persist schedule, and `retireRow`.
`retireRow` re-fires every retirement listener:
`packages/runtime/src/sessions.ts:7063` `    for (const listener of retiredListeners) {`.
Durable fact: `archived` and `archivedAt` are descriptor fields, cited at
`packages/runtime/src/sessions.ts:1935` `  archived?: boolean` and
`packages/runtime/src/sessions.ts:1938` `  archivedAt?: string`.
Replay after a crash is state-safe but not event-safe: the flag converges, but
each replay re-fires retirement listeners. A reaction targeting archive would
need its own receipt dedupe, not the primitive.

### Sandbox checkpoint

The proxy's checkpoint driver uses single-flight and coalescing in memory:
`packages/runtime/src/sandbox-agent-session-proxy.ts:1008` `  const runCheckpoint = (turn?: number, forceOpts?: SandboxCheckpointerRunOpts): Promise<unknown> => {`.
The per-turn trigger is
`packages/runtime/src/sandbox-agent-session-proxy.ts:1283` `    if (!closed && !detached && (opts.checkpoint?.onTurnEnd ?? true)) void runCheckpoint(turnsSent)`.
The default trigger set includes turn-end, teardown and interval:
`packages/runtime/src/sandbox-delivery.ts:1043` `const DEFAULT_CHECKPOINT_ON: ReadonlyArray<"turn-end" | "teardown" | "interval"> = [`.
The trigger is config, resolved at
`packages/runtime/src/sandbox-delivery.ts:1084` `  const on = perSpawn?.on ?? global?.on ?? DEFAULT_CHECKPOINT_ON`.
A delivery record can carry a pushed ref:
`packages/runtime/src/sandbox-delivery.ts:781` `          ? { status: "pushed", ref, sha: probe.snapshot }`.
The ref namespace is deterministic per worktree branch:
`packages/runtime/src/sandbox-workspace-remote.ts:86` `export const CHECKPOINT_BRANCH_PREFIX = "agentproto-checkpoint/"`.
Durable fact: the pushed branch is a remote ref, and the ref name derives from
the branch. Whether re-running the same checkpoint is idempotent at the remote
ref is NOT VERIFIED. The in-memory coalescing guard is not durable, so the
checkpoint is not a safe replay target on its own.

### session_continue_fresh

The `continuedTo` marker is written on the prior descriptor through
`packages/runtime/src/session-continue-fresh.ts:311` `  const prevUpdated = registry.markRetired(prev.id, { continuedTo: fresh.id, cause: "continued" })`.
`markRetired` delegates to `retireRow`, which sets the field:
`packages/runtime/src/sessions.ts:7045` `    if (continuedTo) rt.desc.continuedTo = continuedTo`
and persists:
`packages/runtime/src/sessions.ts:7057` `    schedulePersist()`.
The fresh row records the reverse link:
`packages/runtime/src/session-continue-fresh.ts:297` `  fresh.continuedFrom = prev.id`.
Durable fact: `continuedTo` and `continuedFrom` round-trip through
`sessions.json`, cited at
`packages/runtime/src/sessions.ts:2589` `  continuedFrom?: string` and
`packages/runtime/src/sessions.ts:2599` `  continuedTo?: string`.
Replay after a crash is safe as a marker check: a reaction can see that the
prior session already points at a successor and skip spawning a second one,
provided the check and the write share a lock. The continuation spawn itself is
not idempotent without that check.

## 3. Facts: durable state that can rediscover a missed event

### Where session state lives

The session store path is
`packages/runtime/src/sessions.ts:828` `export const SESSIONS_FILE_PATH = (): string =>`.
Descriptors persist through the debounced writer:
`packages/runtime/src/sessions.ts:7078` `  const schedulePersist = (): void => {`.
The fields relevant to rediscovery are all descriptor fields: `status` at
`packages/runtime/src/sessions.ts:1416` `  status: SessionStatus`, `endedReason`
at `packages/runtime/src/sessions.ts:1475` `  endedReason?: SessionEndReason`,
`outcome` at `packages/runtime/src/sessions.ts:1502` `  outcome?: SessionOutcome`,
`archived` at `packages/runtime/src/sessions.ts:1935` `  archived?: boolean`,
`turnsCompleted` at `packages/runtime/src/sessions.ts:2430` `  turnsCompleted?: number`,
`continuedTo` at `packages/runtime/src/sessions.ts:2599` `  continuedTo?: string`
and `resumedFrom` at `packages/runtime/src/sessions.ts:2659` `  resumedFrom?: string`.

The terminal status vocabulary is `exited`, `killed`, `error`:
`packages/runtime/src/sessions.ts:936` `  | "exited"`,
`packages/runtime/src/sessions.ts:937` `  | "killed"` and
`packages/runtime/src/sessions.ts:938` `  | "error"`.
`"completed"` is a phase string, not a status:
`packages/runtime/src/sessions.ts:945` `  | "completed"`.

### Boot reconciliation already derives terminal facts

At boot, a row that was alive in the snapshot is reclassified:
`packages/runtime/src/sessions.ts:14950` `    const wasAlive = desc.status === "running" || desc.status === "starting"`,
then marked killed with reason `daemon-restart`:
`packages/runtime/src/sessions.ts:14978` `          status: "killed",`
`packages/runtime/src/sessions.ts:14980` `          endedReason: "daemon-restart",`.
The derived outcome is recomputed for such a row:
`packages/runtime/src/sessions.ts:15042` `      reclassified.outcome = deriveSessionOutcome(reclassified, {`.
The live exit funnel records the outcome before emitting:
`packages/runtime/src/sessions.ts:6627` `    recordOutcome(rt)`
and emits `session:exited` once:
`packages/runtime/src/sessions.ts:6691` `      type: "session:exited",`.
The once-only latch is
`packages/runtime/src/sessions.ts:6600` `    if (rt.exitedEmitted) return`.

### Policy state

Completion policies persist to `~/.agentproto/policies.json`:
`packages/runtime/src/supervisor.ts:655` `export const POLICIES_FILE_PATH = (): string =>`
and `packages/runtime/src/supervisor.ts:656` `  resolve(homedir(), ".agentproto", "policies.json")`.
The persisted envelope carries each input and state:
`packages/runtime/src/supervisor.ts:532` `interface PolicySnapshot {`.
Judge verdicts are persisted on the run state:
`packages/runtime/src/supervisor.ts:417` `  verdict?: JudgeVerdict`.
Boot re-arms active policies and keeps terminal states:
`packages/runtime/src/supervisor.ts:71` ` * re-armed to "watching" and re-subscribed to the bus. Terminal states (done/`.

### Sentinel state

Sentinels persist to `~/.agentproto/sentinels.json`:
`packages/runtime/src/sentinel-store.ts:197` `export const SENTINELS_FILE_PATH = (): string => resolve(agentprotoHome(), "sentinels.json")`.
Each sentinel carries a bounded persisted dedupe window:
`packages/runtime/src/sentinel-store.ts:53` `  seen: string[]`
with cap at
`packages/runtime/src/sentinel-store.ts:216` `const SEEN_CAP = 1_000`.
The read-only check is
`packages/runtime/src/sentinel-store.ts:528` `      return sentinel.seen.includes(eventId)`.
This is the sentinel event dedupe state, not a reaction receipt store. AIP-71
section 7 (Sentinel boundary, in agentproto/agentproto
[`specs/aip-71.mdx`](https://github.com/agentproto/agentproto/blob/main/specs/aip-71.mdx))
forbids reusing it as a generic receipt database: "hook configuration MUST NOT
reuse the Sentinel store as a generic receipt database".

### Reconstructibility of candidate triggers

The table covers the candidate signals named in
`docs/design/action-hooks-event-mapping.md` Part 2 plus the event classes in
Part 1. "Reconstructible" means a boot pass can recompute the trigger from
persisted state without the in-memory bus.

| Trigger | Durable state | Reconstructible after restart | Notes |
| --- | --- | --- | --- |
| `session:exited` / `agentproto:session-completed` | terminal `status`, `endedReason`, `outcome`, with boot reclassification for `daemon-restart` | yes | The row survives in sessions.json. A missed exit is discoverable from a terminal status plus the absence of a terminal receipt. |
| `session:reaped` / `conversation-idle-N` | terminal status plus `endedReason: "idle-reaped"` | yes | Same row-level fact as exit. The idle span itself is not persisted, but the terminal cause is. |
| `session:turn-end` | `turnsCompleted`, `lastActivityAt`, `lastOutputAt` | partial | The count of completed turns is durable, so a missed turn can be detected generically. Per-turn payload such as `awaitingInput`, `empty`, `interrupted`, `toolCalls` is only in the event and is not reconstructible. |
| `policy:passed`, `policy:failed` | `policies.json` run state plus optional `verdict` | partial | Terminal policy state and judge verdict persist. Per-attempt gate stdout and the exact transition time are bounded or not guaranteed. |
| `policy:committed` | policy run state, plus the git commit itself | partial | The commit sha is durable in git; the policy row records the transition. A missed event can be inferred only when the policy state says committed. |
| `session:spawned` | descriptor `startedAt`, `parentSessionId` | yes for existence, no for the exact event | A boot pass can see the row. It cannot recover the original event payload. |
| `session:resumed` | `resumedFrom`, `interruptedAtBoot` | partial | The lineage fields persist, but the boot pass does not emit a second `session:resumed` for a row it reclassifies. |
| `session:awaiting-input`, `session:permission-request` | descriptor `awaitingInput`, `awaitingPermission` flags | partial | Current flags can be read, but a request that appeared and resolved while the daemon was down leaves no event record. |
| `session:artifact-added`, `session:message`, `session:prompt`, `session:renamed`, `session:pinned-*`, `session:model-changed`, `session:config-changed`, `session:bg-task*`, `session:stalled`, `session:watcher-*`, `session:lineage-handover`, `session:context-rescue` | mostly not durable as events | no or not verified | These are in-memory lifecycle emissions. Some have a related durable field, but the occurrence and occurrence id are not recoverable. |
| `cron:fired`, `cron:succeeded`, `cron:failed`, `cron:unhealthy` | cron job store and run records, outside this document's scope | NOT VERIFIED | This document did not audit the cron persistence store. |
| `approval:*` | approval engine persistence | NOT VERIFIED | This document did not audit the approval store. |
| `workflow:*` | workflow run store | NOT VERIFIED | The event-mapping doc records replay idempotency as unverified. |

## 4. Proposal: the receipt record and its mapping onto the outbox

### Receipt record

A receipt is keyed by the AIP-71 occurrence key, not by a sentinel and event
pair. Proposed fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `receiptKey` | string, primary key | Exact `<session-id>/<event>/<occurrence-id>/<binding-id>` |
| `sessionId` | string | Scan key for session-level reporting and boot scans. The v1 store has no session index: the boot pass filters `rows()` by `sessionId` |
| `event` | string | Portable event ref, for example `session:exited` |
| `occurrenceId` | string | Stable id from the source, for example `turn:<n>` or `exit:<endedAt>` |
| `bindingId` | string | Stable id of the reaction binding, not the action id |
| `actionId` | string | AIP-39 action ref |
| `configRevision` | string | Hash of the binding and action config that produced the attempt |
| `status` | enum | `pending`, `running`, `done`, `failed`, `dead` |
| `attempt` | number | Count of started target executions |
| `maxAttempts` | number | Copied from config at creation, so a config change cannot reanimate a dead receipt |
| `nextAttemptAt` | number or absent | Backoff schedule |
| `lastError` | string or absent | Redacted failure detail |
| `createdAt` | number | Receipt durability time |
| `startedAt` | number or absent | Last attempt start |
| `lastAttemptAt` | number or absent | End of the last failed attempt, the shape of the outbox `lastAt`. Set by `failed` only |
| `completedAt` | number or absent | Terminal time. Set by `done` and `dead` only |
| `causedByEventId` | string or absent | Upstream event id when the source has one |
| `reactionDepth` | number | Recursion depth of the reaction chain |
| `outcomeRef` | string or absent | Durable reference to the target's own outcome record, not a payload copy |
| `redaction` | string | Redaction policy revision applied before persistence |

State machine: `pending -> running -> done`, `running -> failed`, `failed ->
running` on retry, and `failed -> dead` at cap or on a non-retryable error. A
`pending` receipt means durable acceptance but no started target: the
`running` write is durable before the target is invoked (section 5, step 5), so
a persisted `pending` row never started. A `running` receipt means the target
may have started. A `done` receipt is terminal and is never re-driven. `dead`
is terminal and reported only.

`outcomeRef` is deliberately opaque. For the pilot it is the brain ledger key,
session id, because the brain records the ingested session in `brain-state.json`
at the cited `state.record(record)` line. For a future action it could be a
policy run id or a checkpoint ref. A receipt never stores the event payload,
the prompt, the transcript, or credentials.

Redaction rule: before writing any error or outcome reference, apply the same
URL-redaction discipline the outbox uses for delivery errors. The outbox's
delivery status is documented as carrying no URL, body or secret:
`packages/runtime/src/sentinel-webhook-outbox.ts:88` `/** Per-sentinel delivery health, derived from the outbox rows. Carries no`.
Receipts persist only a redacted reason string and an opaque reference.

### Relationship to the existing outbox: share the mechanics, keep two stores

AIP-71 section 7 (Sentinel boundary) forbids reusing the Sentinel store as a
generic receipt database, and asks a durable reaction implementation to reuse
the proven outbox patterns "without merging the two public contracts". So the
receipt store is a new store with its own file, its own row shape and its own
status vocabulary. It does not generalize `sentinel-webhook-outbox.ts`, and the
webhook outbox does not become an adapter of the receipt store.

The two stores share the durable-row mechanics, extracted from the outbox into
one module (proposed `packages/runtime/src/durable-row-file.ts`, next to the
existing `durable-file.ts`). The extraction is a behaviour-preserving refactor
of the outbox: its public interface, row shape, file format and tests do not
change, and its existing tests are the guard.

Extract into the shared module, parameterized and with no knowledge of
sentinels:

- The load of a JSON map keyed by an opaque string, and the pretty-printed
  snapshot written through `writeFileDurable` (mode `0o600`, tmp plus fsync
  plus rename), cited in section 1.
- The single serialized write chain and the generation guard that keeps a slow
  older snapshot from overwriting a newer one, cited in section 1.
- The persist-before-ack rule for a new row, with the rollback of the
  in-memory row when the persist fails, cited in section 1.
- The debounced best-effort write for non-critical transitions, and the
  `flushSync` shutdown path.
- Bounded retention: terminal age-out, non-terminal age-out, the row cap and
  the oldest-terminal eviction, with the three values passed in by each store.

The receipt store owns, and the outbox never sees:

- The opaque `receiptKey` and the row shape of the record table above.
- The status vocabulary `pending | running | done | failed | dead` and the
  state machine, including the durable `running` transition (section 5,
  step 5).
- `configRevision`, `reactionDepth`, `causedByEventId`, `outcomeRef`,
  `nextAttemptAt` and `lastAttemptAt`.
- The runner callback, the terminal hook, and a reconciliation driver modeled
  on `resumeDeliveries` (section 6).
- Its own file, next to the outbox file under the agentproto home, so the two
  stores never share a row or a path.
- Its retention values, which start equal to the outbox values (`done` rows
  reaped after 24 hours, 7 days for non-terminal rows, 2000 rows) and can
  differ per receipt class. `dead` rows are kept until the row cap evicts
  them, matching the outbox which reaps only `delivered`.

The outbox keeps, unchanged:

- Its key, built from sentinel and event:
  `packages/runtime/src/sentinel-webhook-outbox.ts:224` `  const rowKey = (sentinelId: string, eventId: string): string =>`.
- Its row shape (`bodyBytes`, `cursor`, `envelope`, `event`, `deliveryState`)
  and its status vocabulary, which is `pending | delivered | dead`
  (`packages/runtime/src/sentinel-webhook-outbox.ts:52` `export type SentinelWebhookOutboxStatus = "pending"`).
  The receipt status is a different vocabulary, `pending | running | done |
  failed | dead`: `done` plays the role of the outbox `delivered`, and
  `running` and `failed` exist only in receipts.
- Its terminal ack
  (`packages/runtime/src/sentinel-runtime.ts:396` `    onTerminal: (sentinelId: string, row: SentinelWebhookOutboxRow): void => {`),
  the expiry and secret gates in `dispatchRow`, and `resumeDeliveries`.

## 5. Proposal: lifecycle of one reaction

1. Receive an event from the session bus or from boot reconstruction.
2. Compute the AIP-71 occurrence key. The occurrence id must be stable for a
   retried source event. For session exits the natural occurrence id is the
   persisted terminal transition, for example `exit:<endedAt>` combined with
   `endedReason`. For turn-end it is the turn ordinal from `turnsCompleted`.
3. Read the receipt by key. If terminal `done` or `dead`, return without
   running the target. If `running`, treat as single-flight and do not start a
   second attempt; optionally attach a waiter. If `pending` with a future
   `nextAttemptAt`, do nothing until due.
4. For a new key, write the receipt in `pending` durably, before acknowledging
   the event. If the write fails, do not ack and do not run the target.
5. Transition to `running` with `startedAt` and `attempt + 1`, and make that
   write durable before invoking the target. It costs one extra durable write
   per reaction, and it is what keeps `pending` meaning "never started": a
   debounced write could leave a persisted `pending` row whose target already
   ran, and boot reconciliation would then replay a target with an unknown
   outcome.
6. Run the target with the event's occurrence id and the receipt key. The
   target must be declared idempotent or safe to reconcile.
7. On success, write `done` with `completedAt` and `outcomeRef`. On a classified
   failure, write `failed` with a redacted `lastError`, `lastAttemptAt` and
   `nextAttemptAt`. These two writes may be debounced: a lost `done` or
   `failed` write on an idempotent target with a proven ledger (section 6) is
   recovered by a re-drive of the `running` row.
8. Retry `failed` receipts with exponential backoff, capped by `maxAttempts`.
   Exhaustion moves the receipt to `dead` with a terminal reason. A
   non-retryable error moves directly to `dead`.
9. Never re-drive `done` or `dead`. Report `dead` receipts through the existing
   delivery health style surface rather than silently dropping them.

Cooldown and single-flight already have a proven local pattern in the clerk
turn-end runner. It debounces per session:
`packages/runtime/src/clerk-turn-end.ts:153` `    const timer = setTimer(() => {`
with delay from config at
`packages/runtime/src/clerk-turn-end.ts:156` `    }, config.debounceMs)`,
and it keeps a per-session pending map. It single-flights with an in-memory set:
`packages/runtime/src/clerk-turn-end.ts:123` `  const inFlight = new Set<string>()`,
checked at
`packages/runtime/src/clerk-turn-end.ts:162` `    if (inFlight.has(id)) {`.
Receipts generalize this from one process lifetime to durable state: the
`pending` receipt with `nextAttemptAt` is the durable debounce, and `running`
plus a lease timestamp is the durable single-flight marker. An in-memory set
may still coalesce within a process, but it is not the source of truth.

Recursion cap: a reaction target may itself cause an event. Each receipt
carries `reactionDepth`, copied from the causing event's depth plus one. When
depth reaches the configured cap, for example 4, the receipt is created in
`dead` with reason `recursion_cap` and the target is not run. This keeps a
reaction that emits `turn-end` from creating an unbounded chain.

While a target runs, the runner enters an async reaction context carrying the
binding id, the depth a spawned session carries and the receipt key. Any spawn
made inside that context is stamped with origin `reaction:<binding-id>` (or the
author-set origin) and `meta.reactionDepth`/`meta.causedByEventId`, so the next
completion derives the next depth. The descriptor meta is string valued, so the
depth is stored as a decimal string and read back as a number in the session
facts. The remaining limit is a session started by
a detached process that does not inherit the async context, for example a spawn
done by a separate OS process: that session is not stamped.

## 6. Proposal: boot reconciliation

Boot reconciliation is a pass that runs after the session registry has loaded
and after the sandbox reattach pass, and before the eager resume pass. The
existing boot order already puts reattach first:
`packages/cli/src/commands/serve.ts:1105` `    const reattached = await gateway.reattachSandboxSessionsOnBoot({`
and eager resume second:
`packages/cli/src/commands/serve.ts:1130` `    const eager = await gateway.resumeSessionsOnBoot({`.
The reattach pass is defined at
`packages/runtime/src/sandbox-reattach.ts:195` `export async function runSandboxReattachPass(opts: {`.
Running receipts after reattach avoids treating a reattached box session as a
dead ghost, and running before eager resume means the receipt pass sees the
terminal facts that boot reconciliation already derived, not a row that has
just been revived.

Which receipts are re-driven:

- Every `pending` receipt, regardless of target idempotency: a persisted
  `pending` row never started, because the `running` transition is durable
  before any target runs. Only `running` rows depend on `idempotent`.
- `running` receipts whose target is declared idempotent and whose idempotency
  is proven by a durable target ledger, as the brain ledger is. The receipt key
  and the target's own dedupe both apply.
- `failed` receipts that are below `maxAttempts` and whose `nextAttemptAt` is
  due.
- `pending` receipts for a trigger that is no longer valid, for example a
  session that was revived before the receipt ran. These are marked `dead` with
  a stale reason, not run.

Which receipts are only reported:

- `running` receipts for a target without a proven idempotency ledger, unless
  the target can answer "did you already commit occurrence X". This is the
  AIP-71 rule that an unknown action outcome must not be replayed.
- `dead` receipts. They are surfaced in status output and logs, never re-run.
- `failed` receipts at cap, which are moved to `dead` during the pass.

How duplicate committed output is avoided: the receipt is written before the
target starts, the target is selected only when it is idempotent, and the
target's own durable dedupe is consulted with the same occurrence id. For the
pilot, the brain pipeline's `already-ingested` check is that second guard. A
crash between receipt creation and completion therefore causes at most one
re-drive, and the target returns its existing outcome reference.

Interaction with existing boot passes:

- Reattach pass: reconciliation runs after it, so a reattached session keeps its
  live status and its receipts are not mistaken for stale exits.
- Brain subscriber catch-up: there is none today. The subscriber only starts
  the bus listener at
  `packages/runtime/src/index.ts:2484` `  brainSubscriber.start()`.
  Receipt reconciliation is therefore the only boot path that can recover a
  missed ingestion trigger. It must not call `ingestPending` blindly, because
  that would ingest sessions that never had a receipt. It re-drives only
  sessions named by a `pending` or reconcilable `running` receipt.
- Eager resume: receipts run before it. A resumed row may later produce a new
  exit and a new occurrence, which is a new receipt key. The old receipt stays
  `done` or `dead` for the old exit.

## 7. Proposal: the pilot reaction

The pilot choice is between brain ingestion on session completion and
archive-only cleanup as the first guarded target.

Brain ingestion:

- Idempotency is proven by a durable per-session ledger:
  `packages/workspace-brain/src/ingest-pipeline.ts:84` `    const existing = await state.read()`
  and the skip return at
  `packages/workspace-brain/src/ingest-pipeline.ts:88` `        return { sessionId, ok: true, skipped: "already-ingested" }`.
- The durable fact is reconstructible from the session row: terminal status and
  `endedReason`, plus the derived `outcome` at boot.
- The existing trigger is lost on restart because its queue is in memory at
  `packages/runtime/src/workspace-brain-subscriber.ts:42` `  const pending = new Set<string>()`.
- The target writes only the brain source documents and the ledger, both
  idempotent by session id.
- The risk is a double trigger with the existing subscriber. Because ingestion
  is idempotent, the second trigger is a skip once the ledger record lands, but
  two concurrent ingests before the record lands would both write the same
  deterministic chunk URIs. That is duplicate work, not duplicate committed
  output.

Archive-only cleanup:

- The archive primitive refuses a live row at
  `packages/runtime/src/sessions.ts:13912` `      const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"`,
  which makes it terminal-only.
- A repeat call is not guarded: the method unconditionally sets the flag at
  `packages/runtime/src/sessions.ts:13919` `      rt.desc.archived = true` and
  calls `retireRow` at
  `packages/runtime/src/sessions.ts:13922` `      retireRow(rt, "archived")`.
- `retireRow` re-fires listeners at
  `packages/runtime/src/sessions.ts:7063` `    for (const listener of retiredListeners) {`.
- The durable flag converges, but the side effects repeat. Archive is less
  idempotent than brain ingestion at the observable level.

Recommendation: use brain ingestion on session completion as the first guarded
target, bound to `session:exited` or `agentproto:session-completed`, with the
occurrence id derived from the persisted terminal transition. Disable the
legacy subscriber trigger for the pilot workspace so there is one owner per
binding, as AIP-71 requires. Keep the subscriber code and its wiring intact for
rollback, since it is not a durability mechanism and can be re-enabled if the
pilot is withdrawn. Do not choose archive as the pilot until the retirement
listener has its own occurrence dedupe.

## 8. Proposal: test plan

Exit criterion: one idempotent built-in reaction survives a daemon restart
between receipt creation and completion with no duplicate committed output.

### Unit tests for the receipt store

- Creation is durable before the caller is acknowledged. Write a receipt with
  `pending`, read the file in a fresh instance, assert the row is present and
  the status is `pending`. Mirror the outbox test at
  `packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:69` `  it("crash right after enqueue (before any debounced flush) loses nothing: a fresh outbox resumes the row", async () => {`.
- Dedupe by the full AIP-71 key: enqueue the same key twice, assert one row and
  no second target run. Mirror the idempotency test at
  `packages/runtime/src/__tests__/sentinel-webhook-outbox.test.ts:75` `  it("enqueue is idempotent per (sentinelId, eventId)`.
- Reachability: run with attempt 1, mark `done`, boot reconcile, assert no
  second run.
- Retry: a failed target below cap sets a future `nextAttemptAt`; after the
  clock advances, reconcile re-runs it. At cap it moves to `dead`.
- Dead letter: a non-retryable error moves straight to `dead` and is never
  re-driven.
- Redaction: an error string containing a URL token is persisted redacted.
- Recursion cap: a target that emits the same event creates a `dead` receipt
  with `recursion_cap`, not an infinite chain.
- Single-flight: two concurrent deliveries for one key start one target run.
- Retention: terminal receipts are reaped on the stated schedule and the file
  stays under the cap.

### Restart simulation

Use the outbox durability harness pattern: `mkdtempSync` for a temp directory
and a fresh store instance to represent the new daemon. The existing test
builds its temp directory at
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:25` `  const d = mkdtempSync(join(tmpdir(), "outbox-dur-"))`
and abandons the first instance at
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:73` `    // "Crash": the first instance is abandoned`,
then starts the second at
`packages/runtime/src/__tests__/sentinel-outbox-durability.test.ts:75` `    const second = mk(file)`.
The restart-resume-by-exact-input test is at
`packages/runtime/src/__tests__/sentinel-webhook-outbox.test.ts:133` `  it("restart resume: the pending row is re-dispatched by the EXACT stored bytes (no re-serialization)", async () => {`.

The pilot restart test:

1. Create a temp brain directory with a fake session reader and a temp receipt
   file.
2. Emit a synthetic `session:exited` for session S with a deterministic
   occurrence id.
3. Start the receipt runner with a target that records every committed ingest.
4. Crash the first store instance after the `pending` receipt is durable but
   before the target completes. Do not call `flushSync`. Use a target whose
   first call never resolves, then abandon the instance.
5. Start a second store instance over the same file and run boot
   reconciliation.
6. Assert exactly one brain ledger record for S, one source document set, and
   one terminal `done` receipt.
7. Assert the target's committed-output counter is 1, not 2.
8. Assert a third reconciliation pass changes nothing.

The fake target should run the real `IngestPipeline` over a temporary
`brain-state.json`, not a stub that merely returns success, so the test proves
the target's own idempotency and not only the receipt store's.

### Integration test for the boot order

Assert reconciliation runs after the reattach pass and before eager resume.
The existing order is cited in section 6. The test can inject fake passes and
record call order, so it does not need a real sandbox.

## 9. Proposed TypeScript signatures

Proposed file: `packages/runtime/src/action-hooks/receipt-store.ts`.

```ts
export const RECEIPT_REDACTION_REVISION = "url-v1"

export type ReactionReceiptStatus = "pending" | "running" | "done" | "failed" | "dead"

export interface ReactionReceiptKey {
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
}

export interface ReactionReceipt {
  receiptKey: string
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
  actionId: string
  configRevision: string
  status: ReactionReceiptStatus
  attempt: number
  maxAttempts: number
  nextAttemptAt?: number
  lastError?: string
  createdAt: number
  startedAt?: number
  lastAttemptAt?: number
  completedAt?: number
  causedByEventId?: string
  reactionDepth: number
  outcomeRef?: string
  redaction: string
}

export type NewReactionReceipt = Omit<
  ReactionReceipt,
  "status" | "attempt" | "createdAt" | "redaction" | "receiptKey"
> & { createdAt?: number }

export type ReceiptTransitionCode = "not_found" | "terminal" | "already_running" | "not_running"

export class ReceiptTransitionError extends Error {
  readonly code: ReceiptTransitionCode
  readonly receiptKey: string
  constructor(code: ReceiptTransitionCode, receiptKey: string)
}

export interface ReactionReceiptStore {
  readonly path: string
  get(key: string): ReactionReceipt | undefined
  rows(): ReactionReceipt[]
  insertPending(input: NewReactionReceipt): Promise<ReactionReceipt>
  markRunning(key: string, opts?: { redrive?: boolean }): Promise<void>
  markDone(key: string, outcomeRef: string | undefined): Promise<void>
  markFailed(key: string, error: string, nextAttemptAt: number | undefined): Promise<void>
  markDead(key: string, reason: string): Promise<void>
  sweep(): void
  flushSync(): void
}

export interface ReactionReceiptStoreOptions {
  filePath?: string
  nowMs?: () => number
  debounceMs?: number
  persist?: boolean
  log?: (line: string) => void
  doneReapMs?: number
  nonTerminalAgeOutMs?: number
  rowCap?: number
}

export function buildReactionReceiptKey(key: ReactionReceiptKey): string
export function createReactionReceiptStore(opts?: ReactionReceiptStoreOptions): ReactionReceiptStore
```

Proposed file: `packages/runtime/src/action-hooks/reaction-runner.ts`.

```ts
import type { SessionEvent, SessionEventBus } from "../session-event-bus.js"
import type { ReactionReceipt, ReactionReceiptStore } from "./receipt-store.js"

export interface ReactionTarget {
  readonly actionId: string
  /** true: re-running the same occurrence is safe because the target dedupes by its own durable ledger. */
  readonly idempotent: boolean
  run(input: ReactionTargetInput): Promise<ReactionTargetOutcome>
}

export interface ReactionTargetInput {
  receiptKey: string
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
  reactionDepth: number
  causedByEventId?: string
}

export interface ReactionTargetOutcome {
  ok: boolean
  outcomeRef?: string
  retryable?: boolean
  error?: string
}

export interface ReactionBinding {
  bindingId: string
  event: string
  actionId: string
  configRevision: string
  maxAttempts: number
  reactionDepth: number
  target: ReactionTarget
  /** The AIP-71 occurrence id of this event for this binding, or undefined to ignore the event. */
  occurrenceIdOf(event: SessionEvent): string | undefined
  /** Optional filter evaluated BEFORE any receipt exists: false (or a throw, which is logged) means "this binding does not apply to this event", no receipt is created. Omitted means applies. Live events only, never consulted at boot reconciliation. */
  shouldHandle?(event: SessionEvent): boolean | Promise<boolean>
  /** Boot reconciliation only: is the trigger of a still `pending` receipt valid? Omitted means valid. false marks the receipt dead with reason "stale_trigger" and never runs it. */
  isTriggerValid?(receipt: ReactionReceipt): boolean | Promise<boolean>
}

export interface ReactionRunnerOptions {
  bus: SessionEventBus
  store: ReactionReceiptStore
  bindings: readonly ReactionBinding[]
  /** Default Date.now. */
  nowMs?: () => number
  /** Default 4. */
  maxReactionDepth?: number
  /** Default 4. */
  maxConcurrent?: number
  /** Default min(30_000 * 2 ** (attempt - 1), 600_000), deterministic, no jitter. */
  backoffMs?: (attempt: number) => number
  /** Default 30_000: period of the retry/sweep tick started by start(). */
  retryIntervalMs?: number
  /** Injectable for tests. */
  setInterval?: typeof setInterval
  /** Injectable for tests. */
  clearInterval?: typeof clearInterval
  /** Default console.warn; prefix "[reaction-runner]". */
  log?: (line: string) => void
}

export interface ReactionRunnerStatus {
  bindingId: string
  pending: number
  running: number
  failed: number
  dead: number
  lastError?: string
}

export interface ReactionRunner {
  /** Idempotent: subscribe each binding's event on the bus and start the retry tick. */
  start(): void
  /** Idempotent: unsubscribe and clear the tick; never throws. */
  stop(): void
  handleEvent(event: SessionEvent, occurrenceId: string): Promise<void>
  /** Re-run `failed` receipts whose nextAttemptAt is due, then store.sweep(). */
  retryDue(): Promise<void>
  reconcileOnBoot(): Promise<void>
  status(): ReactionRunnerStatus[]
}

export function createReactionRunner(opts: ReactionRunnerOptions): ReactionRunner
```

## 10. Implemented wiring: event routines and the live binding set

`ReactionRunner` no longer has a fixed binding set. `replaceBindings(next)` swaps
it, and `handleEvent`, `retryDue`, `reconcileOnBoot` and `status` read the
current set. A run already in flight keeps the binding it started with, and a
receipt whose binding is no longer present is left untouched. If that binding
returns later, its pending receipts resume at the next boot reconcile and
its failed receipts resume at the next retry tick.

The daemon builds the list from `brainIngestReaction.binding` plus every enabled
AIP-41 event routine, in input order. `createReactionWiring.refresh()` refuses a
routine that cannot convert or whose id is already taken, reports it under
`reactions.refused` in the `reconcile()` result (and in `routine_reconcile`
output), and logs each distinct refusal once. `refresh()` never throws: a
throwing scan or runner keeps the previous live set and reports the failure
under binding id `*`.

The documented `session.<field>` filter paths are `session.kind`,
`session.isChild`, `session.workspaceSlug`, `session.origin`, `session.adapter`
(the descriptor `adapterSlug`) and `session.label`. Undefined fields are omitted,
so a filter on one never matches.
The additional filter paths `session.reactionDepth` and
`session.causedByEventId` follow the same rule.

Known limits: no event context for tool, workflow or agent arms;
(only a registered action handler receives the occurrence); a session started by a
detached process that does not inherit the async reaction context, for example
a spawn done by a separate OS process, is not stamped, so a chain through that
process is not bounded by the depth cap; the action
registry is empty, so `action` arms are refused until a handler is registered;
an event arriving between runner start and the first reconcile only reaches
builtin bindings.

Rollback: set `enabled: false` on the routine and run `routine_reconcile`.

### Reaction health and trace lines

`ReactionRunner.health()` is a synchronous, side-effect-free read of the
retained receipt rows plus the in-memory skip counters. It reports
`generatedAt`, `started`, `maxReactionDepth`, `maxConcurrent`, per-live-binding
counts (`pending`, `running`, `done`, `failed`, `dead`), `oldestQueuedAgeMs`
(the oldest pending or failed row), `latencyMs` (`count`, `p50`, `p95`, `max`
from completed done rows), `maxDepth`, `retries`, `deadReasons`, `lastError`
and `skipped`; plus `orphans` grouped by a binding id that is no longer live
and process-wide `totals`. Percentiles use nearest rank, so `p50` and `p95`
are always members of the sample. Receipts whose binding was removed stay in
the store and appear under `orphans`, not under `bindings`.

The runner writes one structured line per terminal transition it performs in
`invokeTarget` and in the recursion cap branch, on a separate `trace` channel
(default `console.info`):

```
[reaction-runner] receipt=<receiptKey> binding=<bindingId> status=<done|failed|dead> depth=<n> attempt=<n> latencyMs=<n> queueAgeMs=<n> retryAt=<epoch ms> reason=<text>
```

`latencyMs` is the time since the attempt that just ended started, and
`queueAgeMs` is the time from receipt creation to the start of that attempt, so
it includes the backoff of earlier attempts. `retryAt` is present only on
`failed`, and `reason` only on `failed` and
`dead`. The reason is the first 120 characters of the store-redacted
`lastError`, with whitespace runs replaced by `_` so the line stays parseable.

`GET /reactions` returns the health object plus `wiring` (`active` and
`refused`) when the HTTP server was built with the reactions option; without
the option the route 404s. It is a read-only GET; no other method is handled by
the route.

Limits of the health surface: latency covers the last attempt only, not every attempt of a
retried receipt; the retained window is the receipt store's retention, with
done rows reaped after 24 h; `skipped` is memory only and resets at boot; there
is no MCP tool and no CLI command for this read model yet.

## 11. Open questions and everything NOT VERIFIED

Open questions:

- What is the exact occurrence id for `session:exited` when `endedAt` is absent
  on an old descriptor? The canonical answer should be a single helper shared
  with AIP-71 adapters.
- Should the receipt store live in the runtime package as proposed, or in a
  lower-level package that the runtime imports, if a future non-runtime host
  wants it?
- Should receipt health be exposed through `session_capabilities`, a dedicated
  status route, or both?
- How does the pilot disable the legacy brain subscriber per workspace without
  changing its global wiring? A config flag may need to be added before the
  pilot ships.
- What is the retention policy for `done` receipts of high-frequency events
  such as `turn-end`? The 2000 row cap may be too small.
- Does a `running` receipt need a lease expiry separate from `nextAttemptAt`,
  so a crashed run can be distinguished from a slow run?

NOT VERIFIED:

- Whether re-running the same sandbox checkpoint is idempotent at the remote
  ref. The deterministic ref name is verified at
  `packages/runtime/src/sandbox-workspace-remote.ts:86` `export const CHECKPOINT_BRANCH_PREFIX = "agentproto-checkpoint/"`,
  but replay safety is not.
- Whether the workspace brain source writes are byte-identical for every
  concurrent ingest of the same session before the ledger record lands. The
  chunk URIs are deterministic, but this document did not prove that two
  concurrent writes cannot interleave at the provider layer.
- The cron store persistence and replay semantics for `cron:*` events.
- The approval store persistence and replay semantics for `approval:*` events.
- The workflow run store replay semantics for `workflow:*` events.
- Whether `session:reaped` always results in a persisted `endedReason` of
  `idle-reaped` after an unclean shutdown. The reaper path is cited, but the
  crash window between the event and the persist was not traced.
- That the extraction of the shared durable-row module preserves the outbox
  behaviour exactly. The existing outbox tests are the guard and were not run
  for this design.
- The exact count and identity of every legacy mechanism that would need to be
  disabled to guarantee one owner per binding. The event-mapping doc is the
  current authority and this design did not re-audit every producer.
