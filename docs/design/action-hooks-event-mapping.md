# Action hooks event mapping and legacy migration inventory

Pinned commit: d6641f7eaba69c6274eff55c502b5602e93a89fc

Status: research note for action hooks v1 (AIP-71), portable event names from
AIP-37. This document does not change the runtime. It maps the events the
daemon emits today, lists candidate signals for a
`agentproto:session-completed` host event, and records migration rules for the
legacy mechanisms the new reaction path may replace.

Citation form: `path:LINE` followed by an exact fragment of that line.

## Part 1: event mapping

`SessionEventType` is declared in `packages/runtime/src/session-event-bus.ts:18`
`export type SessionEventType =`. Every row below starts from that union.

Every event also reaches the in-process ring, and the webhook notifier's
`onAny` handler, unless noted:

- `packages/runtime/src/event-ring.ts:76` `return bus.onAny(ev => {`
- `packages/runtime/src/index.ts:2453` `eventRing.wire(sessionEvents)`
- `packages/runtime/src/index.ts:2457` `sessionEvents.onAny(ev => webhookNotifier.onSessionEvent(ev))`

The webhook handler is selective, not a general forwarder:
`packages/runtime/src/webhook-notifier.ts:189` `// Only fire on meaningful lifecycle events (not command-done, which`.
`session-follow` also observes every event:
`packages/runtime/src/session-follow.ts:806`
`const unsubscribe = sessionEvents.onAny(ev => {`.

In the table, "generic" means the ring plus any-event subscribers above; the
Subscribers column adds event-specific subscribers.

| Runtime event | Emitted at | Subscribers today | Closest AIP-37 name or NONE | Proposed portable form | Notes |
| --- | --- | --- | --- | --- | --- |
| `session:turn-end` | `packages/runtime/src/sessions.ts:10658` `type: "session:turn-end",`; also `:10744`, `:11006` | `packages/runtime/src/clerk-turn-end.ts:177` `opts.sessionEvents.on("session:turn-end", (ev: SessionTurnEndEvent) => {`; `packages/runtime/src/turn-retry.ts:929` `sessionEvents.on("session:turn-end", ev => {`; `packages/runtime/src/supervisor.ts:1296` `unsubs.push(sessionEvents.on("session:turn-end", onEnd))`; `packages/runtime/src/mcp-session-observer.ts:292` `opts.sessionEvents.on("session:turn-end", ev => {`; `packages/runtime/src/pr-provenance-reconciler.ts:363` `opts.sessionEvents.on("session:turn-end", ev => {` | `turn-end` | `turn-end` | Payload `packages/runtime/src/session-event-bus.ts:128` `export interface SessionTurnEndEvent {`: `awaitingInput`, optional `reason`, `empty`, `error`, `interrupted`, `toolCalls`. Fires once per completed turn, not once per session. |
| `session:awaiting-input` | `packages/runtime/src/sessions.ts:10672` `type: "session:awaiting-input",` | `packages/runtime/src/supervisor.ts:1297` `unsubs.push(sessionEvents.on("session:awaiting-input", onEnd))`; `packages/runtime/src/sessions-registry-agent-host.ts:889` `this.sessionEvents.on("session:awaiting-input", (ev) => {` | `turn-end` (the turn ended awaiting input), otherwise NONE | `agentproto:awaiting-input` | Payload `packages/runtime/src/session-event-bus.ts:191` `export interface SessionAwaitingInputEvent {`: `question`. Fires when the flag flips true, not on every turn-end. |
| `session:awaiting-input-flagged` | `packages/runtime/src/sessions.ts:14451` `type: "session:awaiting-input-flagged",` | generic | NONE | `agentproto:awaiting-input-flagged` | Payload `packages/runtime/src/session-event-bus.ts:215` `export interface SessionAwaitingInputFlaggedEvent {`: both directions, mandatory `reason`, optional `question`. External manual override. |
| `session:awaiting-question-answered` | `packages/runtime/src/sessions.ts:11197` `type: "session:awaiting-question-answered",` | generic | `prompt-submit` | `prompt-submit` | Payload `packages/runtime/src/session-event-bus.ts:258` `export interface SessionAwaitingQuestionAnsweredEvent {`: matched `answer` and the `question`. Fires when a prompt matched a declared option. |
| `session:permission-request` | `packages/runtime/src/sessions.ts:6769` `type: "session:permission-request",` | generic | `permission-request` | `permission-request` | Payload `packages/runtime/src/session-event-bus.ts:238` `export interface SessionPermissionRequestEvent {`: stable `permissionId`, `toolName`, `text`. Parks a driver RPC. |
| `session:permission-resolved` | `packages/runtime/src/sessions.ts:6795` `type: "session:permission-resolved",`; also `:6890` | generic | NONE | `agentproto:permission-resolved` | Payload `packages/runtime/src/session-event-bus.ts:274` `export interface SessionPermissionResolvedEvent {`: `decision` approve/deny/cancelled. Fires once per parked request. |
| `session:exited` | `packages/runtime/src/sessions.ts:6691` `type: "session:exited",`; also `:15065` | `packages/runtime/src/workspace-brain-subscriber.ts:93` `unsubscribe = bus.on("session:exited", onExit)`; `packages/runtime/src/restart-scheduler.ts:255` `const unsubscribe = sessionEvents.on("session:exited", ev => {`; `packages/runtime/src/task-ledger.ts:797` `const unsubscribeExited = sessionEvents.on("session:exited", ev => {`; `packages/runtime/src/supervisor-notify.ts:82` `return sessionEvents.on("session:exited", ev => {`; `packages/runtime/src/index.ts:2460` `sessionEvents.on("session:exited", ev => {` | `conversation-end` | `agentproto:session-exited` (raw process exit, not necessarily conversation-end) | Payload `packages/runtime/src/session-event-bus.ts:284` `export interface SessionExitedEvent {`: `exitCode`, `status`, optional `reason`. Deduplicated per session by the `exitedEmitted` latch at `packages/runtime/src/sessions.ts:6600` `if (rt.exitedEmitted) return`. |
| `session:reaped` | `packages/runtime/src/sessions.ts:13612` `type: "session:reaped",` | generic | `conversation-idle-<N>` | `agentproto:session-reaped` | Payload `packages/runtime/src/session-event-bus.ts:314` `export interface SessionReapedEvent {`: `idleMs`. Fires from the idle reaper, alongside a `session:exited` with `reason:"idle-reaped"`. |
| `session:stalled` | `packages/runtime/src/sessions.ts:13658` `type: "session:stalled",` | `packages/runtime/src/turn-retry.ts:955` `sessionEvents.on("session:stalled", ev => {` | NONE | `agentproto:session-stalled` | Payload `packages/runtime/src/session-event-bus.ts:339` `export interface SessionStalledEvent {`: `stalledSinceMs`. Detection only, can fire again after a clear. |
| `session:stall-cleared` | `packages/runtime/src/sessions.ts:6712` `type: "session:stall-cleared",` | `packages/runtime/src/turn-retry.ts:959` `sessionEvents.on("session:stall-cleared", ev => {` | NONE | `agentproto:session-stall-cleared` | Payload `packages/runtime/src/session-event-bus.ts:358` `export interface SessionStallClearedEvent {`. Fires only when a prior flag existed. |
| `session:watcher-attached` | `packages/runtime/src/orchestration-tools.ts:495` `type: "session:watcher-attached",` | generic | NONE | `agentproto:watcher-attached` | Payload `packages/runtime/src/session-event-bus.ts:385` `export interface SessionWatcherAttachedEvent {`: watcher count and optional watcher session. Fires per blocking wait attach. |
| `session:watcher-detached` | `packages/runtime/src/orchestration-tools.ts:513` `type: "session:watcher-detached",` | generic | NONE | `agentproto:watcher-detached` | Payload `packages/runtime/src/session-event-bus.ts:405` `export interface SessionWatcherDetachedEvent {`. Fires when a wait resolves or times out. |
| `session:bg-tasks-parked` | `packages/runtime/src/sessions.ts:10696` `type: "session:bg-tasks-parked",` | generic | NONE | `agentproto:bg-tasks-parked` | Payload `packages/runtime/src/session-event-bus.ts:432` `export interface SessionBgTasksParkedEvent {`: `count`. Turn-end heuristic, fires only when the condition holds. |
| `session:bg-tasks-cleared` | `packages/runtime/src/sessions.ts:10197` `type: "session:bg-tasks-cleared",`; also `:10959` | generic | NONE | `agentproto:bg-tasks-cleared` | Payload `packages/runtime/src/session-event-bus.ts:450` `export interface SessionBgTasksClearedEvent {`. Fires when the parked flag is cleared. |
| `session:bg-task` | `packages/runtime/src/sessions.ts:10849` `type: "session:bg-task",` | generic | NONE | `agentproto:bg-task` | Payload `packages/runtime/src/session-event-bus.ts:467` `export interface SessionBgTaskEvent {`: `phase` started/settled, task id/kind/status. Progress updates are not emitted. |
| `session:resumed` | `packages/runtime/src/sessions.ts:8577` `type: "session:resumed",`; also `:14589` | `packages/runtime/src/mcp-session-observer.ts:321` `const offResumed = opts.sessionEvents.on("session:resumed", ev => {` | `conversation-start` | `agentproto:session-resumed` | Payload `packages/runtime/src/session-event-bus.ts:515` `export interface SessionResumedEvent {`: `interrupted`, `resumedFrom`, optional `contextRestored:false`. Fires when a dead row is revived in place. |
| `session:spawned` | `packages/runtime/src/sessions.ts:11568` `type: "session:spawned",`; also `:11747`, `:12036` | generic | `conversation-start`; child sessions are closer to `subagent-start` | `conversation-start` for roots, `subagent-start` for parented children | Payload `packages/runtime/src/session-event-bus.ts:735` `export interface SessionSpawnedEvent {`: `parentSessionId`, `depth`. Fires once when the row is registered. |
| `session:provisioning` | `packages/runtime/src/sessions.ts:11784` `type: "session:provisioning",` | generic | NONE | `agentproto:session-provisioning` | Payload `packages/runtime/src/session-event-bus.ts:753` `export interface SessionProvisioningEvent {`: `kind` queued/started/phase/done, `phase`, `position`, `outcome`. Fires many times per spawn. |
| `session:command-done` | No emitter found outside tests. Interface only at `packages/runtime/src/session-event-bus.ts:527` `export interface SessionCommandDoneEvent {` | generic (declared) | NONE | `internal, not exposed` | Payload would be `commandId` and `exitCode`. NOT VERIFIED as an emitted event at this commit. |
| `session:model-changed` | `packages/runtime/src/sessions.ts:10330` `type: "session:model-changed",`; also `:12954` | generic | NONE | `agentproto:model-changed` | Payload `packages/runtime/src/session-event-bus.ts:545` `export interface SessionModelChangedEvent {`: `model`, optional `activeModel`. Fires only on an applied switch. |
| `session:config-changed` | `packages/runtime/src/sessions.ts:12944` `type: "session:config-changed",`; also `:13001`, `:13053`, and `packages/runtime/src/session-restart-core.ts:2464` `type: "session:config-changed",` | generic | NONE | `agentproto:config-changed` | Payload `packages/runtime/src/session-event-bus.ts:590` `export type SessionConfigChangedEvent = {`: `axis`, `value`. Model changes also emit `session:model-changed` as a back-compat alias. |
| `session:renamed` | `packages/runtime/src/sessions.ts:14044` `type: "session:renamed",` | generic | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:614` `export interface SessionRenamedEvent {`: slug/title/label. Display-only. |
| `session:pinned-changed` | `packages/runtime/src/sessions.ts:14240` `type: "session:pinned-changed",` | generic | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:677` `export interface SessionPinnedEvent {`: `pinned`. Display-only. |
| `session:pinned-reordered` | `packages/runtime/src/sessions.ts:14377` `type: "session:pinned-reordered",` | generic | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:691` `export interface SessionPinnedReorderedEvent {`: `ids`. Display-only. |
| `session:artifact-added` | `packages/runtime/src/sessions.ts:14392` `type: "session:artifact-added",` | generic | `write` | `agentproto:artifact-added` | Payload `packages/runtime/src/session-event-bus.ts:705` `export interface SessionArtifactAddedEvent {`: key, kind, version. Materialization, not a filesystem write. |
| `session:artifact-pinned-changed` | `packages/runtime/src/sessions.ts:14416` `type: "session:artifact-pinned-changed",` | generic | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:717` `export interface SessionArtifactPinnedEvent {`: key, pinned. Display-only. |
| `session:message` | `packages/runtime/src/sessions.ts:9976` `type: "session:message",` | `packages/runtime/src/session-follow.ts:870` `const unsubscribeReports = sessionEvents.on("session:message", ev => {` | NONE | `agentproto:session-message` | Payload `packages/runtime/src/session-event-bus.ts:636` `export interface SessionMessageEvent {`: recipient, relation, kind, urgency, optional `delivered`. Emitted at send and again on delivery. |
| `session:prompt` | `packages/runtime/src/sessions.ts:14351` `type: "session:prompt",` | generic | `prompt-submit` | `prompt-submit` | Payload `packages/runtime/src/session-event-bus.ts:655` `export interface SessionPromptEvent {`: `caller`, `queued`. Fires when a prompt is accepted, not when the model turn starts. |
| `policy:passed` | `packages/runtime/src/supervisor.ts:1072` `type: "policy:passed",` | generic | NONE | `agentproto:policy-passed` | Payload `packages/runtime/src/session-event-bus.ts:765` `export interface PolicyPassedEvent {`: policy id, session id, optional judge `verdict`. Fires when a completion policy gate passes. |
| `policy:failed` | `packages/runtime/src/supervisor.ts:884` `type: "policy:failed",`; also `:900`, `:1011` | `packages/runtime/src/turn-retry.ts:965` `sessionEvents.on("policy:failed", ev => {` | NONE | `agentproto:policy-failed` | Payload `packages/runtime/src/session-event-bus.ts:776` `export interface PolicyFailedEvent {`: optional `exitCode`, `verdict`. Can fire per attempt. |
| `policy:commit-ready` | `packages/runtime/src/supervisor.ts:1049` `type: "policy:commit-ready",` | generic | NONE | `agentproto:policy-commit-ready` | Payload `packages/runtime/src/session-event-bus.ts:794` `export interface PolicyCommitReadyEvent {`: paths and message, staged but not committed. Fires once per requiring-ack policy. |
| `policy:committed` | `packages/runtime/src/supervisor.ts:915` `type: "policy:committed",` | generic | `write` (a git commit is a write, not a file write) | `agentproto:policy-committed` | Payload `packages/runtime/src/session-event-bus.ts:806` `export interface PolicyCommittedEvent {`: resulting `sha`, paths, message. Fires once after a commit. |
| `cron:fired` | `packages/runtime/src/cron-scheduler.ts:1202` `type: "cron:fired"` | generic (webhook deliberately filters it out) | `manual` (scheduled job) | `agentproto:cron-fired` | Payload `packages/runtime/src/session-event-bus.ts:817` `export interface CronFiredEvent {`: `jobId`, label. Fires before the action runs. |
| `cron:succeeded` | `packages/runtime/src/cron-scheduler.ts:1159` `type: "cron:succeeded"` | generic (webhook filters it out) | NONE | `agentproto:cron-succeeded` | Payload `packages/runtime/src/session-event-bus.ts:825` `export interface CronSucceededEvent {`: `summary`. Fires once per successful run. |
| `cron:failed` | `packages/runtime/src/cron-scheduler.ts:1161` `type: "cron:failed"` | generic (webhook filters it out) | NONE | `agentproto:cron-failed` | Payload `packages/runtime/src/session-event-bus.ts:834` `export interface CronFailedEvent {`: `error`. Fires once per failed run. |
| `cron:unhealthy` | `packages/runtime/src/cron-scheduler.ts:1177` `type: "cron:unhealthy",` | webhook has an explicit branch at `packages/runtime/src/webhook-notifier.ts:174` `if (ev.type === "cron:unhealthy") {` | NONE | `agentproto:cron-unhealthy` | Payload `packages/runtime/src/session-event-bus.ts:852` `export interface CronUnhealthyEvent {`: consecutive failures, last outcome, reason. Fires when the job is paused. |
| `activity:changed` | `packages/runtime/src/activities.ts:262` `type: "activity:changed",` | `packages/runtime/src/activities.ts:376` `const unsubscribe = opts.sessionEvents.onAny(handler)` and `:434` `opts.sessionEvents.on("activity:changed", ev => {` | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:873` `export interface ActivityChangedEvent {`: the freshly projected activity record. Fires per accepted state change. |
| `task:changed` | `packages/runtime/src/task-ledger.ts:726` `type: "task:changed",` | generic | NONE | `internal, not exposed` | Payload `packages/runtime/src/session-event-bus.ts:889` `export interface TaskChangedEvent {`: change kind, status, rev. One event per accepted write. |
| `workflow:gate-report` | `packages/runtime/src/workflow-runner.ts:1778` `type: "workflow:gate-report",` | generic | `step.succeeded` or `step.failed`, depending on `ok` | `agentproto:workflow-gate-report` | Payload `packages/runtime/src/session-event-bus.ts:908` `export interface WorkflowGateReportEvent {`: ok, exit code, report, attempt. Fires for every attempt, not only the last. |
| `workflow:approval-requested` | `packages/runtime/src/workflow-runner.ts:1591` `type: "workflow:approval-requested",` | `packages/runtime/src/workflow-runner.ts:2721` `sessionEvents.on("workflow:approval-requested", (ev) => {` | `permission-request` (human approval, not tool permission) | `agentproto:workflow-approval-requested` | Payload `packages/runtime/src/session-event-bus.ts:926` `export interface WorkflowApprovalRequestedEvent {`: approval id, prompt, approvers, artifacts. Fires when a run parks. |
| `workflow:suspended` | `packages/runtime/src/workflow-runner.ts:1669` `type: "workflow:suspended",`; also `:1734` | `packages/runtime/src/workflow-runner.ts:2727` `sessionEvents.on("workflow:suspended", (ev) => {` | `run.suspended` | `agentproto:workflow-suspended` | Payload `packages/runtime/src/session-event-bus.ts:964` `export interface WorkflowSuspendedEvent {`: optional `on`, `reason`, prompt, schema. Fires when a run parks. |
| `workflow:suspend-resumed` | `packages/runtime/src/workflow-runner.ts:1691` `type: "workflow:suspend-resumed",`; also `:1763`, `:2661` | generic | `run.resumed` | `agentproto:workflow-suspend-resumed` | Payload `packages/runtime/src/session-event-bus.ts:980` `export interface WorkflowSuspendResumedEvent {`: run id and step id. Fires on live or boot resume. |
| `session:harness-warning` | `packages/runtime/src/sessions.ts:12968` `type: "session:harness-warning",`; also `packages/runtime/src/sessions-registry-agent-host.ts:340` `type: "session:harness-warning",`, `packages/runtime/src/sessions-registry-agent-host.ts:613` `type: "session:harness-warning",`, `packages/runtime/src/sessions-registry-agent-host.ts:754` `type: "session:harness-warning",` | generic | NONE | `agentproto:harness-warning` | Payload `packages/runtime/src/session-event-bus.ts:1043` `export interface SessionHarnessWarningEvent {`: `warnings`. Fires when an unhonored harness field is dropped. |
| `session:turn-retry` | `packages/runtime/src/turn-retry.ts:487` `type: "session:turn-retry",` | generic | `turn-error` | `agentproto:turn-retry` | Payload `packages/runtime/src/session-event-bus.ts:1009` `export interface SessionTurnRetryEvent {`: phase, error class, attempt, delay, skip reason. Fires once per retry phase transition. |
| `mcp:degraded` | `packages/runtime/src/mcp-session-observer.ts:307` `type: "mcp:degraded",` | generic | NONE | `agentproto:mcp-degraded` | Payload `packages/runtime/src/session-event-bus.ts:1059` `export interface McpDegradedEvent {`: server, reason, detail. Re-emitted only when the reason/detail pair changes. |
| `session:handoff-suggested` | `packages/runtime/src/sessions.ts:9124` `type: "session:handoff-suggested",` | generic | NONE | `agentproto:handoff-suggested` | Payload `packages/runtime/src/session-event-bus.ts:1083` `export interface SessionHandoffSuggestedEvent {`: source harness, reason, installed suggestions. A suggestion only. |
| `session:context-rescue` | `packages/runtime/src/sessions.ts:9228` `type: "session:context-rescue",` | generic | `compact-end` (or `compact-start` when rescue begins) | `agentproto:context-rescue` | Payload `packages/runtime/src/session-event-bus.ts:1136` `export interface SessionContextRescueEvent {`: outcome compacted/continued/hard-stopped, percent before/after. Fires once per rescue. |
| `session:lineage-handover` | `packages/runtime/src/lineage-handover.ts:183` `type: "session:lineage-handover",` via `packages/runtime/src/sessions.ts:14346` `emitLineageHandover(event) {` and `:14347` `sessionEvents?.emit(event)` | generic | `subagent-end` (children are re-parented, not ended) | `agentproto:lineage-handover` | Payload `packages/runtime/src/session-event-bus.ts:1111` `export interface SessionLineageHandoverEvent {`: successor, adopted/skipped children, reason, actor. Fires once per handover. |
| `agentproto:clerk-due` | `packages/runtime/src/action-hooks/clerk-reaction.ts` `type: "agentproto:clerk-due"` (emitted by the clerk dispatch for an owned workspace) | the builtin `builtin:clerk-pass` reaction binding | NONE | `agentproto:clerk-due` (host event, not yet subscribable by user routines) | Payload `packages/runtime/src/session-event-bus.ts` `export interface SessionClerkDueEvent {`: `sessionId`, `occurrenceId` of the form `due:<ISO timestamp>`, `ts`. Emitted only for a workspace in `defaults.reactions.clerk.workspaces`, after the controller gate and debounce. |
| `approval:requested` | `packages/runtime/src/approvals/engine.ts:219` `emit("approval:requested", record)` via `:158` `sessionEvents.emit({ type, kind: record.kind, ...base })` | generic | `permission-request` (human approval, not tool permission) | `agentproto:approval-requested` | Payload `packages/runtime/src/session-event-bus.ts:1154` `export interface ApprovalRequestedEvent {`: approval id, kind, optional task id. Fires when a new pending approval is raised. |
| `approval:decided` | `packages/runtime/src/approvals/engine.ts:316` `emit("approval:decided", final)` via `:162` `sessionEvents.emit({` | `packages/runtime/src/task-ledger.ts:815` `const unsubscribeApprovalDecided = sessionEvents.on(` then `:816` `"approval:decided",` | NONE | `agentproto:approval-decided` | Payload `packages/runtime/src/session-event-bus.ts:1170` `export interface ApprovalDecidedEvent {`: decision and channel. Fires once per human decision. |
| `approval:consumed` | `packages/runtime/src/approvals/engine.ts:412` `emit("approval:consumed", record)` | generic | NONE | `agentproto:approval-consumed` | Payload `packages/runtime/src/session-event-bus.ts:1182` `export interface ApprovalConsumedEvent {`: approval id and task id. Exactly-once consumption of an approved approval. |
| `approval:expired` | `packages/runtime/src/approvals/engine.ts:182` `emit("approval:expired", expired)` | generic | NONE | `agentproto:approval-expired` | Payload `packages/runtime/src/session-event-bus.ts:1191` `export interface ApprovalExpiredEvent {`. Lazy expiry on the next read or mutate, no background timer. |
| `workflow:approval-resolved` (interface only, absent from the union) | `packages/runtime/src/workflow-runner.ts:1617` `type: "workflow:approval-resolved",`; also `:2594` | generic | NONE | `agentproto:workflow-approval-resolved` | Interface at `packages/runtime/src/session-event-bus.ts:943` `export interface WorkflowApprovalResolvedEvent {`: approved, who, note. Not listed in `SessionEventType` at `packages/runtime/src/session-event-bus.ts:18` `export type SessionEventType =`. |

## Part 2: inputs for `agentproto:session-completed`

This host event is intended to mean "a session reached a terminal outcome",
not a turn-end and not a raw process exit. The following signals exist today.

### Derived outcome

Defined at `packages/runtime/src/session-outcome.ts:236` `export function deriveSessionOutcome(desc: SessionDescriptor, input: DeriveSessionOutcomeInput = {}): SessionOutcome {`.

The values it returns are fixed in the return literal at
`packages/runtime/src/session-outcome.ts:282` `return {`:

- `source: "derived"` at `packages/runtime/src/session-outcome.ts:283` `source: "derived",`
- `status: "produced" | "empty"` at `packages/runtime/src/session-outcome.ts:284` `status: summary || artifacts.length > 0 ? "produced" : "empty",`
- `termination.status`, `termination.reason`, optional `exitCode` and `midTurn` at `packages/runtime/src/session-outcome.ts:286` `termination: {`
- optional `summary`, `cost`, `artifacts`, `links`, and `recordedAt` in the same literal at `packages/runtime/src/session-outcome.ts:285` `...(summary ? { summary } : {}),` and `packages/runtime/src/session-outcome.ts:295` `recordedAt: now.toISOString(),`

The `SessionOutcome` interface documents Level 2 values added later:
`packages/runtime/src/session-outcome.ts:140` `export interface SessionOutcome extends OutcomeDetail {`
and the `verdict` vocabulary at `packages/runtime/src/session-outcome.ts:156` `verdict?: "done" | "abandoned" | "partial" | "failed" | "blocked" | "needs-input"`.

### Where the derived outcome is written

The registry records it before exit is announced:
`packages/runtime/src/sessions.ts:6502` `const recordOutcome = (rt: SessionRuntime): void => {`
and calls it inside the single exit funnel at
`packages/runtime/src/sessions.ts:6627` `recordOutcome(rt)`.

That funnel is `emitExited`, defined at
`packages/runtime/src/sessions.ts:6599` `const emitExited = (rt: SessionRuntime): void => {`,
which emits `session:exited` at `packages/runtime/src/sessions.ts:6691` `type: "session:exited",` and is latched once per session at
`packages/runtime/src/sessions.ts:6600` `if (rt.exitedEmitted) return`.

### Where a `policy:passed` verdict is produced

The supervisor's `then:"emit"` branch emits it at
`packages/runtime/src/supervisor.ts:1072` `type: "policy:passed",`.
The verdict is optional and only present for judge gates, as documented at
`packages/runtime/src/session-event-bus.ts:771` `verdict?: JudgeVerdict`.

A policy pass is not required for every session, and it is not the same thing
as a session terminal state.

### Where a session is marked completed or archived

Statuses have no `"completed"` value. The terminal status vocabulary is at
`packages/runtime/src/sessions.ts:933` `export type SessionStatus =` with
`packages/runtime/src/sessions.ts:936` `| "exited"`, `:937` `| "killed"`,
`:938` `| "error"`. The phase string `"completed"` exists separately at
`packages/runtime/src/sessions.ts:945` `| "completed"`.

Operator completion is a relabel, not a status:
`packages/runtime/src/sessions.ts:6534` `const markOutcomeCompleted = (rt: SessionRuntime): void => {`
sets `reason: "operator-completed"` at
`packages/runtime/src/sessions.ts:6546` `reason: "operator-completed",`.
The completion predicate is
`packages/runtime/src/session-outcome.ts:332` `export function isOutcomeCompleted(`
and it accepts `verdict:"done"` or `termination.reason:"operator-completed"` at
`packages/runtime/src/session-outcome.ts:336` `if (o.verdict === "done") return true`.

Steward close produces `steward-completed` or `steward-abandoned` at
`packages/runtime/src/sessions.ts:13466` `const reason: SessionEndReason = input.verdict === "done" ? "steward-completed" : "steward-abandoned"`.

Archive is housekeeping, not completion:
`packages/runtime/src/sessions.ts:13906` `archiveSession(id) {`.
It refuses a live row at `packages/runtime/src/sessions.ts:13912` `const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"`
and sets `archived` at `packages/runtime/src/sessions.ts:13919`
`rt.desc.archived = true`.

### Existing brain ingestion trigger

`packages/runtime/src/workspace-brain-subscriber.ts:93` `unsubscribe = bus.on("session:exited", onExit)`.
The debounce is per subscriber instance and in memory:
`packages/runtime/src/workspace-brain-subscriber.ts:40` `const debounceMs = opts.debounceMs ?? 5_000`.
The pending set is in memory at
`packages/runtime/src/workspace-brain-subscriber.ts:42` `const pending = new Set<string>()`.

### Candidate signals that could define "terminal outcome established"

These are candidates only. This document does not choose among them.

1. The `session:exited` event itself, emitted once by the funnel:
   `packages/runtime/src/sessions.ts:6691` `type: "session:exited",`.
2. The descriptor's terminal status `exited`/`killed`/`error` at
   `packages/runtime/src/sessions.ts:936` `| "exited"` and following lines.
3. The derived outcome being present and non-empty on the descriptor, written
   at `packages/runtime/src/sessions.ts:6627` `recordOutcome(rt)` from
   `packages/runtime/src/session-outcome.ts:236` `export function deriveSessionOutcome(desc: SessionDescriptor`.
4. A `verdict:"done"` or `termination.reason:"operator-completed"` outcome,
   via `packages/runtime/src/session-outcome.ts:332` `export function isOutcomeCompleted(`.
5. A `session:exited` whose `reason` is `operator-completed` or
   `steward-completed`, from the enum at
   `packages/runtime/src/session-end-reason.ts:27` `"operator-completed",`
   and `packages/runtime/src/session-end-reason.ts:40` `"steward-completed",`.
6. A passing completion policy, subject to its being configured at all:
   `packages/runtime/src/supervisor.ts:1072` `type: "policy:passed",`.
7. A `session:reaped` retirement, because it also funnels to `session:exited`
   with `reason:"idle-reaped"`, at
   `packages/runtime/src/sessions.ts:13612` `type: "session:reaped",`.
8. Archive as an explicit post-terminal signal, at
   `packages/runtime/src/sessions.ts:13919` `rt.desc.archived = true`, but only
   after a terminal status is proven at
   `packages/runtime/src/sessions.ts:13912` `const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"`.

## Live event routine wiring (AIP-41)

An enabled routine with `schedule.kind: "event"` is now live. `routineRegistrar.reconcile()`
resolves the binding, calls `onReconciled`, and `createReactionWiring` converts it
with `toReactionBinding` before handing the full list to
`ReactionRunner.replaceBindings`. Every reconcile refreshes the runner's binding
set, so an edited or removed routine takes effect on the next `routine_reconcile`
or daemon boot.

The `session.<field>` filter paths are the flat facts from `sessionFactsOf`:

| Path | Value |
| --- | --- |
| `session.kind` | the descriptor `kind` |
| `session.isChild` | true when `parentSessionId` is set, false otherwise |
| `session.workspaceSlug` | the descriptor `workspaceSlug`, omitted when undefined |
| `session.origin` | the descriptor `origin`, omitted when undefined |
| `session.adapter` | the descriptor `adapterSlug`, omitted when undefined |
| `session.label` | the descriptor `label`, omitted when undefined |
| `session.reactionDepth` | the descriptor `meta.reactionDepth` read as a number, omitted unless it is a decimal integer string |
| `session.causedByEventId` | the descriptor `meta.causedByEventId`, omitted when undefined |

An undefined field is omitted, so a filter on it never matches. An agent arm
treats unreadable session facts as "do not fire"; it also refuses a session whose
`origin` starts with `reaction:`.

### Registered actions

| Action | Behavior |
| --- | --- |
| `session:clerk-pass` | registered by the daemon, reachable only through the builtin clerk binding because user routines cannot subscribe to `agentproto:clerk-due` |
| `session:archive` | archives the session of the event, skips with an `outcomeRef` when the session is missing, already archived, alive, pinned or keepAlive |

An event routine archives a finished child session by naming the action:

```yaml
schema: routine/v1
id: archive-finished-children
description: Archive a child agent session once it has completed, so it leaves the default session list.
schedule:
  kind: event
  on: agentproto:session-completed
  filter:
    session.isChild: true
target:
  action: session:archive
```

The handler reports one of `archived`, `skipped:session_missing`,
`skipped:already_archived`, `skipped:alive`, `skipped:pinned` or
`skipped:keep_alive` in the receipt `outcomeRef`; an `archiveSession` throw is
retried by the runner.

Rollback: set `enabled: false` on the routine and run `routine_reconcile`;
already archived sessions stay archived and `session_unarchive` restores one.

Limits: it archives as soon as the completion is established, with no delay or
retention barrier; archiving hides the row from the default list and does not
delete bytes, so on-disk retention is separate; a pinned or keepAlive session is
never archived by it. A session that already has a successor (`continuedTo`) is
archived too. Archiving a session that was closed with an outcome emits a
retirement event with cause `archived` after the earlier `killed` one, as any
archive of a closed session does.

The `reconcile()` result and the `routine_reconcile` tool output carry
`reactions.active` and `reactions.refused` (each refusal has `bindingId` and
`error`). A refused binding is not live. Builtin bindings always win a duplicate
id.

The runner carries the reaction causation through every arm: while a target
runs it enters an async reaction context, and a session spawned inside that
context is stamped with origin `reaction:<binding-id>` (or the author-set
origin) plus `meta.reactionDepth` and `meta.causedByEventId`. The next
completion derives its receipt depth from those facts, so the depth cap bounds
a tool or workflow arm that starts sessions (for example `agent_start` or
`workflow_run_file`) as well as the agent arm.

Known limits in this version: tool, workflow and agent arms get no event context;
only a registered action handler receives the occurrence; a session started
by a detached process that does not inherit the async reaction context, for
example a spawn done by a separate OS process, is not stamped; the daemon
action registry contains the builtin `session:clerk-pass` and `session:archive`
handlers, so every other `action` arm is refused until a handler is registered;
and an event arriving between runner start and the first reconcile only reaches
builtin bindings.

Rollback: set `enabled: false` on the routine and run `routine_reconcile`. The
binding disappears on the next refresh; its receipts are left untouched.

## Part 3: migration rules

The column "Candidate binding" is a proposal, not an implemented config. The
AIP-39 action ids are illustrative resource-qualified ids.

| Mechanism | What it does today | Trigger | Durable guard or idempotency | Candidate binding | Safe to replay after a daemon restart? | Dual-fire risk if both old and new run | Rollback note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.agentproto/hooks.json` engine (`packages/runtime/src/hooks-config.ts:70` `const HOOKS_CONFIG_REL = ".agentproto/hooks.json"`) | Evaluates semantic permission rules with actions log/allow/hold/deny/gate at the pre-exec permission seam: `packages/runtime/src/sessions.ts:7767` `const hookRules = loadHooksConfig(workspace)` then `packages/runtime/src/sessions.ts:7768` `const { decision, rule } = decideRule(` | Every held `agent-prompt` permission event, cited above | File is reloaded from disk with an mtime cache: `packages/runtime/src/hooks-config.ts:256` `export function loadHooksConfig(workspace: string): HookRule[] {`. No durable receipt. | `permission-request` -> `session:admission` (admission hook, not a reaction) | yes for the decision itself, because it is stateless over the file (`packages/runtime/src/hooks-config.ts:256` `export function loadHooksConfig(workspace: string): HookRule[] {`); an already executed action is not replayed | A new admission hook and this engine could both evaluate and both gate one permission request, at `packages/runtime/src/sessions.ts:7768` `const { decision, rule } = decideRule(`. | Keep the file and `loadHooksConfig` active; disable the new binding in config, do not delete the old rules until the new path is verified. |
| `hooks.clerk` and the clerk turn-end controller (`packages/clerk/src/clerk-hook-config.ts`, `packages/clerk/src/clerk-turn-end.ts`, `docs/clerk-hook.md`) | After a turn-end and an idle debounce, runs one steward pass: `packages/clerk/src/clerk-turn-end.ts` `opts.sessionEvents.on("session:turn-end", ...`. The controller keeps the gate and the debounce; the pass dispatch is legacy by default and owned per workspace by the durable reaction when the slug is listed. | `session:turn-end`, then a per-session timer with delay `config.debounceMs`. For an owned workspace the firing emits `agentproto:clerk-due`, which becomes a receipt; the legacy dispatch stays the default. | In-memory single-flight in the controller (`const inFlight = new Set<string>()`). The durable reaction adds a receipt-based record and a non idempotent pass target, so a `running` receipt is not replayed. | `turn-end` -> `agentproto:clerk-due` -> `session:clerk-pass` for an owned workspace; `turn-end` -> legacy pass otherwise | no: pending timers and the controller single-flight are in memory, so a restart drops a pending pass rather than replaying it. A `pending` receipt whose session is gone is marked `dead` with `stale_trigger`. | Ownership is read once per firing and only owned firings emit the host event, so one firing never runs both paths. Default `defaults.reactions.clerk.workspaces` is empty, which keeps every workspace on the legacy dispatch. | Remove the workspace slug from `defaults.reactions.clerk.workspaces` (hot, applies to the next firing). The controller gate, debounce and ignore rules are not owned by the reaction. |
| Spawn dedupe (`packages/runtime/src/spawn-dedupe.ts` and the spawn claim map) | Derives an implicit idempotency key from label plus prompt hash: `packages/runtime/src/spawn-dedupe.ts:101` `export function deriveImplicitIdempotencyKey(input: {`; the claim map then returns the existing spawn at `packages/runtime/src/session-spawn.ts:4386` `const result = await existing.result` | Every `agent_start` with a claim key: `packages/runtime/src/session-spawn.ts:4380` `if (claimKey) {` | In-memory per-registry WeakMap: `packages/runtime/src/session-spawn.ts:470` `const spawnClaimsByRegistry = new WeakMap<SessionsRegistry, Map<string, SpawnClaim>>()`; windows 600s and 120s at `:421` and `:450`. No persistence. | `session:spawn-requested` -> `session:spawn-reuse` (an admission `reuse` decision) | no: the map is in memory (`packages/runtime/src/session-spawn.ts:470` `const spawnClaimsByRegistry = new WeakMap<SessionsRegistry, Map<string, SpawnClaim>>()`), so a restart forgets resolved claims and a retry can spawn again | A new admission `reuse` and the claim map could both decide reuse, but only one may create the session; if both miss, two spawns still happen, at `packages/runtime/src/session-spawn.ts:4380` `if (claimKey) {` and the claim insertion that follows. | Leave `spawn.dedupe` at its current policy; the implicit default is `always` at `packages/runtime/src/spawn-dedupe.ts:80` `export const DEFAULT_SPAWN_DEDUPE: SpawnDedupeMode = "always"`. Turn it off only after the new reuse path is proven. |
| Provisioning queue (`packages/worktree/src/provision-scheduler.ts`) | Admission control for heavy worktree phases, with a FIFO queue and per-caller fair share: `packages/worktree/src/provision-scheduler.ts:193` `export class ProvisionScheduler {` | Each heavy provisioning calls `acquire`; the queue is `packages/worktree/src/provision-scheduler.ts:195` `private readonly queue: Waiter[] = []` | In-memory queue only; a queued request is cancellable and removed at `packages/worktree/src/provision-scheduler.ts:246` `waiter.reject(new ProvisionCancelledError("worktree provisioning cancelled while queued"))`. The default cap is `packages/worktree/src/provision-scheduler.ts:29` `export const DEFAULT_PROVISION_CONCURRENCY = 2`. No persistence. | `agentproto:session-provisioning` -> `session:provision-admission` (an admission `defer` decision) | no: the queue is in memory at `packages/worktree/src/provision-scheduler.ts:195` `private readonly queue: Waiter[] = []`, so queued entries do not survive a restart | A new admission `defer` plus this queue would make one spawn wait twice, or hold a slot in one while queued in the other. The progress event is `packages/runtime/src/sessions.ts:11784` `type: "session:provisioning",`. | Keep `worktrees.provisionConcurrency` and the scheduler; remove the new defer binding, not the queue. |
| Idle reaper (`packages/runtime/src/idle-reaper.ts`) | Sweeps idle agent-cli sessions and calls `reapIdle`: `packages/runtime/src/idle-reaper.ts:198` `export function runIdleReapPass(opts: {` and `:246` `if (registry.reapIdle(d.id, idle)) {` | Periodic pass; eligibility requires `running` at `packages/runtime/src/idle-reaper.ts:161` `if (desc.status !== "running") return false` and honors `keepAlive` at `:166` `if (desc.keepAlive === true) return false` | Descriptor mutation is persisted at `packages/runtime/src/sessions.ts:13600` `schedulePersist()`, and `reapIdle` refuses a non-running row at `packages/runtime/src/sessions.ts:13536` `if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {` | `conversation-idle-<N>` -> `session:idle-retire` | yes: after the first reap the status is no longer `running`, so the next pass refuses at `packages/runtime/src/sessions.ts:13536` `if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {` | A new idle reaction and this sweep could both call the reaper, producing two `session:reaped` attempts; the primitive refuses the second at `packages/runtime/src/sessions.ts:13536` `if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {`, but the event-level double attempt is still possible. | Keep the sweep; disable the new idle binding. The reaper is opt-in via the threshold, so setting the threshold to zero also disables it. |
| Retirement cleanup (`packages/runtime/src/retirement-cleanup.ts`) | Re-points or removes follows and sentinels when a session retires: `packages/runtime/src/retirement-cleanup.ts:131` `export function wireRetirementCleanup(deps: RetirementCleanupDeps): () => void {` and `:133` `return deps.registry.onSessionRetired(ev => {` | Retirement events plus a boot and periodic sweep: `packages/runtime/src/retirement-cleanup.ts:58` `export async function sweepWiringLifecycle(`; wired at `packages/runtime/src/index.ts:3501` `wireRetirementCleanup(wiringCleanupDeps)` and `:3505` `void sweepWiringLifecycle(wiringCleanupDeps).catch(err => {` | Follow and sentinel stores are persistent, and the sweep is safe to rerun; it removes or relinks based on current state at `packages/runtime/src/retirement-cleanup.ts:58` `export async function sweepWiringLifecycle(`. | `conversation-end` -> `session:child-housekeeping` | yes: the sweep is explicitly the periodic and boot cleanup path at `packages/runtime/src/retirement-cleanup.ts:58` `export async function sweepWiringLifecycle(` and `packages/runtime/src/index.ts:3505` `void sweepWiringLifecycle(wiringCleanupDeps).catch(err => {` | A new `conversation-end` reaction re-pointing the same follows/sentinels as this handler would duplicate the writes, but both are state-based and converge. | Keep `wireRetirementCleanup`; turn off the new reaction. Deleting the sweep would leave old orphans, so it is the last thing to remove. |
| Workspace brain subscriber (`packages/runtime/src/workspace-brain-subscriber.ts`) | Debounces exits and ingests each exited session into its workspace brain: `packages/runtime/src/workspace-brain-subscriber.ts:93` `unsubscribe = bus.on("session:exited", onExit)` | `session:exited`, debounce at `packages/runtime/src/workspace-brain-subscriber.ts:40` `const debounceMs = opts.debounceMs ?? 5_000` | Pending set and timer are in memory: `packages/runtime/src/workspace-brain-subscriber.ts:42` `const pending = new Set<string>()`. Ingestion itself is idempotent per session: `packages/workspace-brain/src/ingest-pipeline.ts:84` `    const existing = await state.read()` returns `already-ingested` at `packages/workspace-brain/src/ingest-pipeline.ts:88` `        return { sessionId, ok: true, skipped: "already-ingested" }`. | `agentproto:session-completed` -> `session:brain-ingest` | no: pending exits are in memory at `packages/runtime/src/workspace-brain-subscriber.ts:42` `const pending = new Set<string>()`, so a restart loses a queued ingest | A new completion reaction and this subscriber would both ingest the same session, at `packages/runtime/src/workspace-brain-subscriber.ts:93` `unsubscribe = bus.on("session:exited", onExit)`; that is a ledger skip when both run, and ownership is now per workspace slug via `defaults.reactions.brainIngest.workspaces`. | Keep the subscriber wired at `packages/runtime/src/index.ts:2480` `brainSubscriber.start()` to hand a workspace back to the legacy subscriber, remove its slug from `defaults.reactions.brainIngest.workspaces` (hot, applies to the next completion) |
| Sandbox checkpoint triggers (`defaults.sandbox.checkpoint.on`) | Chooses turn-end, interval, and teardown triggers for sandbox checkpoints: `packages/runtime/src/config-schema.ts:1150` `path: "defaults.sandbox.checkpoint.on",`; the enum is `packages/runtime/src/sandbox-checkpoint-schema.ts:15` `export const sandboxCheckpointOnSchema = z.array(z.enum(["turn-end", "teardown", "interval"]))` | Per-turn hook at `packages/runtime/src/sandbox-agent-session-proxy.ts:1283` `if (!closed && !detached && (opts.checkpoint?.onTurnEnd ?? true)) void runCheckpoint(turnsSent)`; interval timer at `:1037` `const timer = setInterval(() => {`; default trigger set at `packages/runtime/src/sandbox-delivery.ts:1043` `const DEFAULT_CHECKPOINT_ON: ReadonlyArray<"turn-end" | "teardown" | "interval"> = [` | Checkpoint refs and branches are pushed to the remote, but idempotency of replaying the same checkpoint is NOT VERIFIED. Resolution gate is `packages/runtime/src/sandbox-delivery.ts:1091` `onTurnEnd: enabled && on.includes("turn-end") && intervalMs > 0,`. | `turn-end` -> `session:checkpoint` | unknown: the trigger is config at `packages/runtime/src/sandbox-delivery.ts:1084` `const on = perSpawn?.on ?? global?.on ?? DEFAULT_CHECKPOINT_ON`, but replay safety of the checkpoint push is NOT VERIFIED | A new `turn-end` reaction and the per-turn hook would both call `runCheckpoint` for one turn, at `packages/runtime/src/sandbox-agent-session-proxy.ts:1283` `if (!closed && !detached && (opts.checkpoint?.onTurnEnd ?? true)) void runCheckpoint(turnsSent)`. | Keep `on: ["turn-end"]` and disable the new binding. To stop per-turn old checkpoints, set `on` to `["interval"]` or `["teardown"]`, or set `intervalMs` to zero per `packages/runtime/src/sandbox-delivery.ts:1091` `onTurnEnd: enabled && on.includes("turn-end") && intervalMs > 0,`. |
| `contextContinuity` and the auto-compact controller (`packages/runtime/src/context-continuity.ts`, `auto-compact.ts`) | Decides warnings, compaction, fresh continuation, and hard stop; auto-compact fires on an absolute token threshold only when idle: `packages/runtime/src/auto-compact.ts:132` `export function decideAutoCompact(inputs: AutoCompactInputs): AutoCompactDecision {` | Called from the per-session controller at `packages/runtime/src/sessions.ts:9509` `const controller = (rt.autoCompact ??= createAutoCompactController({`; refuses while already compacting at `packages/runtime/src/auto-compact.ts:137` `if (inputs.compacting) return { trigger: false, reason: "already-compacting", ...base }` | Controller state is in memory; the policy is persisted on the descriptor. The default threshold is `packages/runtime/src/context-continuity.ts:132` `autoCompactAtTokens: AUTO_COMPACT_DEFAULT_TOKENS,`. | `conversation-idle-<N>` or `compact-start` -> `session:compact-or-handoff` (the AIP-71 example) | unknown: the decision is pure at `packages/runtime/src/auto-compact.ts:132` `export function decideAutoCompact(inputs: AutoCompactInputs): AutoCompactDecision {`, but a replayed compaction action is not idempotent and this document found no replay guard | A new idle/compact reaction and `decideAutoCompact` would both compact; the `already-compacting` guard at `packages/runtime/src/auto-compact.ts:137` `if (inputs.compacting) return { trigger: false, reason: "already-compacting", ...base }` is only within this controller, not across two systems. | Keep `contextContinuity` and auto-compact core; add the new binding only after a shared compaction lock exists. Setting `autoCompactAtTokens:0` disables autocompact per `packages/runtime/src/auto-compact.ts:136` `if (threshold === 0) return { trigger: false, reason: "disabled", ...base }`. |
| `restartPolicy` (`packages/runtime/src/restart-scheduler.ts`) | Optionally revives an eligible crashed or sandbox-gone session with backoff and a crash-loop cap: `packages/runtime/src/restart-scheduler.ts:227` `export function createRestartScheduler(opts: {` | Event-driven on `session:exited` at `packages/runtime/src/restart-scheduler.ts:255` `const unsubscribe = sessionEvents.on("session:exited", ev => {`; execution by sweep at `:318` `export async function runRestartSweepPass(opts: {` | Schedule is persisted on the descriptor as `nextRestartAt` at `packages/runtime/src/restart-scheduler.ts:199` `nextRestartAt: new Date(nowMs + delayMs).toISOString(),`; the sweep reads it at `:335` `if (!d.nextRestartAt) return false` and skips an in-progress resume at `:338` `if (registry.isResuming(d.id)) return false` | `session:exited` with reason `crashed` -> `session:restart` | yes: the schedule is persisted on the descriptor at `packages/runtime/src/restart-scheduler.ts:199` `nextRestartAt: new Date(nowMs + delayMs).toISOString(),`, and the sweep re-reads it at `:335` | A new `session:exited` reaction and this scheduler would both trigger a resume; the only guard at `packages/runtime/src/restart-scheduler.ts:338` `if (registry.isResuming(d.id)) return false` is local to this scheduler. | Keep `restartPolicy` and the scheduler; disable the new restart binding rather than clearing `nextRestartAt`, which would strand an in-flight backoff. |
| Workflow approval and suspend resources (`packages/runtime/src/workflow-runner.ts`) | Parks a run on an approval or suspend step and resumes it through `workflow_escalation_resolve`: `packages/runtime/src/workflow-runner.ts:1591` `type: "workflow:approval-requested",` and `:1669` `type: "workflow:suspended",` | Subscribers at `packages/runtime/src/workflow-runner.ts:2721` `sessionEvents.on("workflow:approval-requested", (ev) => {` and `packages/runtime/src/workflow-runner.ts:2727` `sessionEvents.on("workflow:suspended", (ev) => {` | Run state is persisted by the workflow run store; resume path is the existing resolver. Specific replay idempotency is NOT VERIFIED. | `permission-request` or `run.suspended` -> `workflow:approval-resolve` | unknown: the run store is durable, but whether a repeated resolve is a no-op is NOT VERIFIED | A new reaction that calls the resolver and the existing resolver could both resolve one parked run; the run transition itself is the dedup point, but this document did not verify a second resolve is rejected. | Keep the workflow runner's own subscriptions; do not bind an approval reaction until the resolver's repeat behaviour is verified. |

## NOT VERIFIED

- `session:command-done`: no production emitter was found at this commit. The
  interface exists at `packages/runtime/src/session-event-bus.ts:527` `export interface SessionCommandDoneEvent {`, but the
  event is not emitted outside tests. See `packages/runtime/src/webhook-notifier.ts:189`
  `// Only fire on meaningful lifecycle events (not command-done, which` for a
  comment that refers to it without emitting it.
- `workflow:approval-resolved` is declared as an interface at
  `packages/runtime/src/session-event-bus.ts:943` `export interface WorkflowApprovalResolvedEvent {` and emitted at
  `packages/runtime/src/workflow-runner.ts:1617` `type: "workflow:approval-resolved",`, but it is not a member of
  `SessionEventType` at `packages/runtime/src/session-event-bus.ts:18` `export type SessionEventType =`. The
  effect of this mismatch is not verified.
- Workspace-brain ingestion idempotency: `IngestPipeline.ingest` reads the
  ledger at `packages/workspace-brain/src/ingest-pipeline.ts:84` `    const existing = await state.read()`,
  returns `already-ingested` for a recorded session at
  `packages/workspace-brain/src/ingest-pipeline.ts:88` `        return { sessionId, ok: true, skipped: "already-ingested" }`,
  writes chunks under deterministic uris at
  `packages/workspace-brain/src/ingest-pipeline.ts:134` `          uri: chunkUri(sessionId, chunk.index),`,
  and then records at
  `packages/workspace-brain/src/ingest-pipeline.ts:170` `      await state.record(record)`.
  A crash between the chunk writes and `state.record` replays to the same uris;
  concurrent in-process ingests of one session before the record both write the
  same deterministic uris. What remains NOT VERIFIED is interleaving at the
  knowledge provider layer across processes.
- Sandbox checkpoint replay safety: whether re-running the same checkpoint is
  idempotent at the remote ref was not verified. Entry point:
  `packages/runtime/src/sandbox-agent-session-proxy.ts:1008` `const runCheckpoint = (turn?: number, forceOpts?: SandboxCheckpointerRunOpts): Promise<unknown> => {`.
- Workflow approval resolution idempotency: whether a second resolve of one
  parked run is rejected was not verified. Call site:
  `packages/runtime/src/workflow-runner.ts:2721` `sessionEvents.on("workflow:approval-requested", (ev) => {`.
- Provisioning queue recovery on daemon restart: whether a queued in-memory
  provisioning is re-queued from a persisted descriptor was not verified. The
  queue itself is in memory at
  `packages/worktree/src/provision-scheduler.ts:195` `private readonly queue: Waiter[] = []`.
- The precise AIP-39 action ids for the candidate bindings are proposals, not
  verified action-registry entries.
