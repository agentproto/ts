/**
 * Frozen client type contract — copied field-for-field from the daemon's
 * SessionDescriptor (recon §Session descriptor) plus the permission +
 * adapter + event shapes WP1–4 code against. Do NOT reshape these without
 * a coordinated change across all WPs.
 */

import type { RouteSpec } from "@agentproto/runtime/catalog-models"
export type { RouteSpec }

/** Mirrors @agentproto/runtime AcpMcpServer (packages/acp/src/types.ts). */
export interface AcpMcpServer {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  headers?: Record<string, string>
  credentialRef?: string
}

/** Mirrors @agentproto/runtime SessionAwaitingQuestion. */
export interface SessionAwaitingQuestion {
  text: string
  options?: string[]
  source: "structured" | "heuristic"
}

export type SessionKind = "terminal" | "agent-cli" | "command" | "browser"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"

// ── Decomposed per-session config axes (SPEC §3.1/§3.7,
//    `agentproto-session-config-axes`). Mirror @agentproto/runtime's
//    session-config.ts axis types field-for-field so the picker (step 8) reads
//    each descriptor chip off its own axis instead of decoding the compound
//    legacy `mode` string. Kept as local literals — the client mirrors the
//    daemon by hand and takes no runtime import (see this file's header). ──

/** Mirrors @agentproto/runtime EffortLevel (session-config.ts) — the documented
 *  SUPERSET ceiling; the offerable set is resolved per (adapter × model). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"

/** Mirrors @agentproto/runtime CanonicalPosture — a portable "what the agent may
 *  DO" vocabulary. */
export type CanonicalPosture = "default" | "plan" | "accept-edits" | "bypass" | "read-only"

/** Mirrors @agentproto/runtime Posture — a canonical posture OR a raw harness
 *  mode id from the ACP mode registry (SPEC §3.4a). */
export type Posture = CanonicalPosture | { harnessModeId: string }

/** Mirrors @agentproto/runtime ContextProfile — `"lean"` drops bundled skills. */
export type ContextProfile = "full" | "lean" | (string & {})

/** Mirrors @agentproto/runtime AuthMethod — the narrow eligibility facet of a
 *  named profile (SPEC §1c). */
export type AuthMethod = "oauth-bearer" | "api-key"

/** Mirrors @agentproto/runtime SessionAccessProfileEcho — the non-secret
 *  identity of the NAMED auth profile attached to the session (SPEC §3.6/§3.7),
 *  so the access chip can name the wallet. NEVER the credential. */
export interface SessionAccessProfileEcho {
  profileRef: string
  label?: string
  vendor: string
  method: AuthMethod
}

/** Mirrors @agentproto/runtime RestartPolicy (restart-scheduler PR-2) — the
 *  opt-in auto-restart policy a session can carry. Minimal mirror (the field
 *  round-trips through spawn/descriptor reads; no client UI reads into it
 *  yet). */
export interface RestartPolicy {
  on: ("crashed" | "error")[]
  maxRetries: number
  windowMs: number
  baseDelayMs: number
  factor: number
  maxDelayMs: number
  resume?: boolean
}

/** Axis overrides for `POST /sessions/:id/restart` — mirrors @agentproto/runtime
 *  RestartOverrides (the wire body of the restart-with-override route). Each
 *  present axis overlays the prior session; an omitted one carries forward.
 *  `access.profileRef` is the wallet swap; `route.gateway` the route swap. */
export interface RestartOverridePayload {
  model?: string
  effort?: EffortLevel
  /** A canonical posture value ("plan"/"bypass"/…) OR a raw harness mode id
   *  wrapped as `{ harnessModeId }` — the daemon's restart-override accepts
   *  both (session-tools.ts posture union). */
  posture?: string | { harnessModeId: string }
  contextProfile?: string
  mode?: string
  access?: { profileRef: string }
  route?: { gateway: string; baseUrl?: string }
}

export type ContextContinuityMode = "manual" | "ask" | "auto"

export interface ContextContinuityPolicy {
  mode?: ContextContinuityMode
  warnAtPct?: number
  compactAtPct?: number
  continueFreshAtPct?: number
  hardStopAtPct?: number
  goal?: boolean
  plan?: boolean
  decisions?: boolean
  changedFiles?: boolean
  gitStatus?: boolean
  tests?: boolean
  errors?: boolean
  risks?: boolean
  nextStep?: boolean
  config?: boolean
  label?: string
}

export interface ResolvedContextContinuityPolicy extends ContextContinuityPolicy {
  mode: ContextContinuityMode
  warnAtPct: number
  compactAtPct: number
  continueFreshAtPct: number
  hardStopAtPct: number
  goal: boolean
  plan: boolean
  decisions: boolean
  changedFiles: boolean
  gitStatus: boolean
  tests: boolean
  errors: boolean
  risks: boolean
  nextStep: boolean
  config: boolean
  label: string
}

/**
 * SessionDescriptor — the daemon's canonical session row. Field-for-field
 * copy of the recon §Session descriptor contract (packages/runtime
 * sessions.ts SessionDescriptor). Optional fields stay optional here so
 * partial daemon responses type-check.
 */
export interface SessionDescriptor {
  id: string
  kind: SessionKind
  workspaceSlug: string
  command: string
  pid: number | null
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  /** Mirrors `@agentproto/runtime` SessionDescriptor.killedMidTurn: whether a
   *  turn was actually in flight the instant `status` flipped to "killed" —
   *  captured by the daemon at kill time, before `busy` can go stale (a
   *  killed session's `busy` is never cleared by the turn's own `finally`
   *  if that turn's generator is never resumed). `true` means interrupted;
   *  `false`/absent alongside `turnsCompleted > 0` means the session had
   *  already finished its work before something tore it down — see
   *  activityFor in sessionsTree.logic.ts for the read. */
  killedMidTurn?: boolean
  /** Mirrors `@agentproto/runtime` SessionDescriptor.endedReason: set alongside
   *  `status: "killed"` ONLY when the session ended because the daemon it lived
   *  in went away out from under it — a crash discovered at next boot, or a
   *  graceful shutdown/restart force-killing whatever was still busy — NOT
   *  because an operator targeted it (`kill()`), the agent exited, or a turn
   *  errored. This is the marker that distinguishes a "resumable ghost" from an
   *  ordinary terminal row: an agent-cli row with `endedReason:"daemon-restart"`
   *  can be revived IN PLACE (same id, same history) by a single plain prompt —
   *  the daemon's lazy resume-on-prompt path. See `isResumableInPlace` in
   *  sessionsTree.logic.ts. Also mirrors `"crashed"` — the crash-detect sweep
   *  found the adapter's OS process gone between turns; see `lastError`/
   *  `crashedAt`. */
  endedReason?: "daemon-restart" | "crashed"
  /** Mirrors `@agentproto/runtime` SessionDescriptor.interrupted (#635) — a
   *  DERIVED, read-time field (never persisted): `true` when this session died
   *  with a turn in flight under a daemon restart
   *  (`killedMidTurn && endedReason === "daemon-restart"`). That interrupted
   *  turn was DROPPED and is NEVER auto-retried; on the next in-place resume the
   *  daemon appends a "previous turn was NOT re-run — re-prompt to continue"
   *  banner. Cleared on the next successful turn-end. Orthogonal to
   *  `isResumableInPlace`: a daemon-restart ghost that was idle at death is
   *  still resumable in place, it just lost nothing — this flag only says
   *  whether work was dropped. The resume affordance (sessionResume.ts)
   *  surfaces it so the user knows. */
  interrupted?: boolean
  lastOutputAt?: string
  lastActivityAt?: string
  processAlive?: boolean
  /** Mirrors `@agentproto/runtime` SessionDescriptor.watchers — the live count
   *  of supervisors blocked waiting on this session (#session-visibility).
   *  Ephemeral, stamped at read time; 0/absent ⇒ nothing is watching. */
  watchers?: number
  /** Mirrors `@agentproto/runtime` SessionDescriptor.childrenBusy — how many
   *  descendant sessions are currently mid-turn (subtree rollup,
   *  #session-visibility). Drives the "delegating" row state for an idle parent
   *  waiting on its busy subtree. Ephemeral, stamped at read time. */
  childrenBusy?: number
  /** Mirrors `@agentproto/runtime` SessionDescriptor.lastError — a short
   *  human-readable string for the most recent automatic failure (currently
   *  only stamped by the crash-detect sweep). */
  lastError?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.crashedAt — ISO 8601
   *  timestamp of the crash-detect sweep that flipped this row to
   *  `endedReason:"crashed"`. */
  crashedAt?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.restartPolicy — the
   *  opt-in auto-restart policy (restart-scheduler PR-2). Absent for the
   *  overwhelming majority of sessions (today's lazy-resume-only default). */
  restartPolicy?: RestartPolicy
  label?: string
  /** Derived from the session's FIRST prompt — see the runtime's
   *  SessionDescriptor.title doc for the derivation + overwrite rules. Now
   *  OUTRANKS a spawn `label` in `sessionDisplayName`. */
  title?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.renamedByUser: `true`
   *  only when a human renamed the session via `session_rename`. Makes a
   *  `label` outrank the derived `title` in `sessionDisplayName`; a spawn
   *  `label` (flagged `false`) does not. Absent on pre-flag sessions —
   *  treated as `true` when a `label` is present (see `sessionDisplayName`). */
  renamedByUser?: boolean
  /** Mirrors `@agentproto/runtime` SessionDescriptor.activitySummary — the
   *  SECONDARY, auto-regenerating "what is this session doing now" line,
   *  distinct from the frozen `title`. Regenerated by the daemon on turn-end
   *  from a heuristic (no LLM); absent until the first turn-end, and never
   *  regenerated for a human-renamed session. The sessions tree renders
   *  `text` as the row's leading description segment (see `descriptionFor`)
   *  and keeps the full text + state in the tooltip. */
  activitySummary?: {
    /** One-sentence heuristic summary — the last real assistant/tool line. */
    text: string
    /** Coarse lifecycle/recency state (`à traiter` / `au travail` /
     *  `en attente` / `terminé`). */
    state: string
    /** ISO 8601 timestamp of when the line was last regenerated. */
    at: string
  }
  /** Mirrors `@agentproto/runtime` SessionDescriptor.archived — housekeeping
   *  flag hiding the row from the daemon's default `list()` view (and so
   *  from `listSessions()` here too, unless `includeArchived` is passed).
   *  Set/cleared via `session_archive`/`session_unarchive`. */
  archived?: boolean
  /** Mirrors `@agentproto/runtime` SessionDescriptor.keepAlive — when `true`,
   *  the idle-reaper never retires this session regardless of idle time.
   *  Set at spawn time or toggled via `session_set_keepalive`. */
  keepAlive?: boolean
  pty?: boolean
  name?: string
  argv?: readonly string[]
  cwd?: string
  /** Root of the git worktree the session was spawned in — the session→
   *  worktree edge the daemon resolved from `cwd` at spawn time. Distinct from
   *  `cwd`, which may be a subdirectory of it. Absent when `cwd` isn't inside a
   *  linked worktree (a plain checkout, a non-repo dir) and for every session
   *  persisted before the runtime recorded this field. Mirrors
   *  `@agentproto/runtime` SessionDescriptor.worktreePath — the sessions tree
   *  renders its leaf name as the row's isolation indicator (see
   *  `isolationLabelFor` in sessionsTree.logic.ts). */
  worktreePath?: string
  /** Generation id of that worktree, read at spawn from the provision marker.
   *  Absent whenever `worktreePath` is, and also for a worktree created by a
   *  bare `git worktree add` (nothing writes a marker there). Mirrors
   *  `@agentproto/runtime` SessionDescriptor.worktreeId. */
  worktreeId?: string
  adapterSlug?: string
  /** AIP-45 mode the session was spawned with (e.g. claude-code's `plan`, a
   *  gateway preset mode like `moonshot`). Undefined for the adapter's own
   *  default mode. Mirrors `@agentproto/runtime` SessionDescriptor.mode —
   *  the mid-session model-switch picker (changeModel.logic.ts) compares
   *  this against a candidate model's bound `mode` to decide whether
   *  picking it is a live switch or needs a restart. */
  mode?: string
  model?: string
  auth?: {
    mode: "subscription" | "api-key"
    fingerprint: string
  }
  /** Decomposed per-session config axes — mirror @agentproto/runtime
   *  SessionDescriptor's echo fields (SPEC §3.7). Each is one orthogonal axis
   *  the picker chip reads independently; all optional, absent = adapter
   *  default. See the axis type docs above. */
  effort?: EffortLevel
  posture?: Posture
  route?: RouteSpec
  contextProfile?: ContextProfile
  /** Named auth-profile echo for the `access` axis (SPEC §3.6) — mirrors the
   *  daemon's SessionAccessProfileEcho. Non-secret. */
  accessProfile?: SessionAccessProfileEcho
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  usageSource?: "adapter" | "computed" | "no-pricing" | "none"
  adapterSessionId?: string
  mcpServers?: AcpMcpServer[]
  resumeMetadata?: Record<string, string>
  awaitingInput?: boolean
  awaitingQuestion?: SessionAwaitingQuestion
  awaitingPermission?: boolean
  turnsCompleted?: number
  busy?: boolean
  blockedOn?: "subagent" | "command"
  /** Mirrors `@agentproto/runtime` SessionDescriptor.stalledSinceMs — epoch
   *  ms of the last known adapter activity at the moment the turn-liveness
   *  watchdog flagged this mid-turn session's stream silent past the
   *  threshold. Absent unless currently flagged. */
  stalledSinceMs?: number
  pendingToolCallId?: string
  /** Source label — the channel/harness this session was spawned from
   *  ("codex", "cowork", "vscode", …). Mirrors runtime SessionDescriptor.origin. */
  origin?: string
  parentSessionId?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.notifyParentOnCrash —
   *  opt-in for the direct in-band `[child-crashed]` notice to `parentSessionId`
   *  on this session's crash. Default false/absent. */
  notifyParentOnCrash?: boolean
  depth?: number
  priorCommandSessionId?: string
  /** Id of the prior session this one continues from — set when this session
   *  was spawned by a restart (`session_restart` / `agentproto.restartSession`),
   *  even when the resume itself couldn't establish continuity (a fresh
   *  fallback spawn is still "restarted from" the prior session). See the
   *  runtime's SessionDescriptor.resumedFrom doc. Powers the transcript
   *  panel's resume-chain stitch (transcriptPanelController.ts). */
  resumedFrom?: string
  /** Human-readable resume path for `resumedFrom` — e.g. "resumed via claude
   *  --resume", "resumed via ACP", or "" when no continuity was established.
   *  Only meaningful alongside `resumedFrom`. */
  resumeVia?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.contextContinuity — the
   *  resolved context-continuity policy driving warning/compact/continue-fresh
   *  decisions. */
  contextContinuity?: ResolvedContextContinuityPolicy
  /** Mirrors `@agentproto/runtime` SessionDescriptor.contextContinuityHardStopped. */
  contextContinuityHardStopped?: boolean
  /** Mirrors `@agentproto/runtime` SessionDescriptor.checkpointId — the most
   *  recent context-continuity checkpoint. */
  checkpointId?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.continuedFrom — source
   *  session when this session is a fresh continuation. */
  continuedFrom?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.continuedTo — target
   *  session when this session was continued fresh. */
  continuedTo?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.permissionHold — true when
   *  the session was spawned in permission-hold mode. */
  permissionHold?: boolean
  browserAdapterId?: string
  browserPort?: number
  browserBaseUrl?: string
  browserLocation?: "local" | "cloud"
  remote?: boolean
  sandboxId?: string
  sandboxTeardown?: "kill" | "pause"
}

/**
 * Lightweight panel projection of SessionDescriptor for the VS Code Sessions
 * webview. Excludes large resume / transcript / policy context that the panel
 * never renders. See the runtime's SessionSummary doc for the exact exclusion
 * list; this mirror is hand-maintained so the vscode package does not depend on
 * @agentproto/runtime types at build time.
 */
export interface SessionSummary {
  id: string
  kind: SessionKind
  workspaceSlug: string
  command: string
  pid: number | null
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  killedMidTurn?: boolean
  lastOutputAt?: string
  lastActivityAt?: string
  processAlive?: boolean
  /** Live supervisor waiter count (#session-visibility) — how many
   *  `/sessions/:id/wait` long-polls / `session_monitor` subscriptions are
   *  blocked on this session right now. Ephemeral, stamped at read time by the
   *  daemon; 0/absent ⇒ nothing is watching. */
  watchers?: number
  /** Busy-descendant count (#session-visibility, subtree rollup) — drives the
   *  "delegating" state for an idle parent waiting on its busy subtree. */
  childrenBusy?: number
  label?: string
  title?: string
  renamedByUser?: boolean
  activitySummary?: {
    text: string
    state: string
    at: string
  }
  archived?: boolean
  keepAlive?: boolean
  pty?: boolean
  name?: string
  argv?: readonly string[]
  cwd?: string
  worktreePath?: string
  worktreeId?: string
  adapterSlug?: string
  mode?: string
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  usageSource?: "adapter" | "computed" | "no-pricing" | "none"
  awaitingInput?: boolean
  awaitingQuestion?: SessionAwaitingQuestion
  awaitingPermission?: boolean
  turnsCompleted?: number
  busy?: boolean
  blockedOn?: "subagent" | "command"
  stalledSinceMs?: number
  origin?: string
  parentSessionId?: string
  depth?: number
  priorCommandSessionId?: string
  continuedFrom?: string
  continuedTo?: string
  permissionHold?: boolean
  browserAdapterId?: string
  browserPort?: number
  browserBaseUrl?: string
  browserLocation?: "local" | "cloud"
  remote?: boolean
  sandboxId?: string
  sandboxTeardown?: "kill" | "pause"
}

/** A pending ACP permission request held in the cross-session inbox. */
export interface PendingPermission {
  id: string
  sessionId: string
  toolCallId: string
  toolName?: string
  text: string
  options: Array<{ optionId: string; name?: string; kind?: string }>
  requestedAt: string
}

/**
 * One entry of `models`, carrying the provider/mode a manifest's structured
 * `models.allowed` entry states (AIP-45 — see the daemon's
 * `packages/cli/src/registry/resolve.ts` `AdapterModelInfo`). `provider`/
 * `mode` are undefined for a bare-string entry — an unstated provider is
 * never guessed here, only projected as-is.
 */
export interface AdapterModelInfo {
  id: string
  /** Who serves/bills this model (a ProviderPreset id, or a direct
   *  provider like "anthropic"). Undefined when unstated. */
  provider?: string
  /** The adapter's own mode id that routes to `provider`. Undefined when
   *  the adapter routes on its own or needs no mode switch. */
  mode?: string
}

/** One entry in the daemon's adapter registry (MCP-only: mcpCall("adapter_list"), no HTTP route). */
export interface AdapterInfo {
  slug: string
  /** Display name. */
  name?: string
  /** Transport the CLI speaks (acp / proprietary / print). */
  protocol?: string
  /** Adapter version, when reported. */
  version?: string
  /** Declared spawn modes (e.g. subscription / api-key for claude-code). */
  modes?: Array<{
    id: string
    status?: "active" | "noop"
    status_note?: string
  }>
  /** Conventional model ids the adapter advertises. */
  models?: string[]
  /** Same models as `models`, in the same order, each carrying the
   *  provider/mode a structured `models.allowed` entry states. Absent on
   *  an older daemon that predates this projection. */
  modelDetails?: AdapterModelInfo[]
  /** Install/readiness state: ready = installed, available = installable.
   *  `unresolvable` = package present but the last import failed (mid-rebuild)
   *  — not reinstallable. */
  status?: "supported" | "available" | "ready" | "unresolvable"
  /** Short human hint shown in pickers (e.g. "anthropic · ACP · resumable"). */
  hint?: string
  /** Provenance for generic ACP entries (`acp-catalog` / `acp-config`);
   *  absent on native `@agentproto/adapter-*` adapters. */
  source?: "acp-config" | "acp-catalog"
  /**
   * How this adapter selects a model (AIP-45 `models.apply`; the daemon
   * defaults an omitted manifest field to `"config"` before projecting it
   * here). `"arg"` bakes the model into spawn-time argv, so EVERY
   * mid-session switch attempt is `requires-restart` regardless of target
   * — changeModel.logic.ts marks every row that way for such an adapter.
   * Absent on an older daemon that predates this projection; treat as
   * `"config"`.
   */
  modelApply?: "config" | "command" | "arg"
  /**
   * How this adapter's spawn ROUTE relates to the chosen model (AIP-45
   * launch-menu drill-down). `"free"` = the route is an independent choice
   * and the adapter can route models through gateways. `"derived-from-model"`
   * = the endpoint falls out of the model id's vendor prefix. Absent ⇒ a
   * fixed single-provider adapter.
   */
  routeSelection?: "free" | "derived-from-model"
}

/** Mirrors @agentproto/runtime AdapterInstallResult — the outcome of an
 *  `adapter_install` call. `ok` reflects only whether the install command
 *  succeeded; `status` is the adapter's readiness re-read afterwards. */
export interface AdapterInstallResult {
  slug: string
  ok: boolean
  method:
    | "npm-global"
    | "agentproto-install"
    | "already-installed"
    | "unsupported"
  message: string
  command?: string
  exitCode?: number
  status?: "supported" | "available" | "ready" | "unresolvable"
}

/** /health probe result. */
export interface DaemonHealth {
  status: string
  workspace: string
  registered: readonly string[]
  uptimeMs?: number
  /** Effective `daemon.resumeSessionsOnBoot` knob — the live boot-behavior the
   *  daemon is actually running with (runtime http-server `handleHealth`).
   *  Absent on daemons predating the field. */
  resumeSessionsOnBoot?: boolean
  /** Effective `daemon.idleReapAfterMs` knob (0 = reaper off). Absent on
   *  daemons predating the field. */
  idleReapAfterMs?: number
}

/** Catalog pricing for a route, surfaced by `catalog_models`. */
export interface CatalogPricing {
  inPer1M: number
  outPer1M: number
}

/** One route under a model product in the `catalog_models` response. */
export interface CatalogRoute {
  route: string
  ref: string
  baseUrl: string | null
  pricing: CatalogPricing | null
  runnable: boolean
  eligibleProfiles: string[]
  adapterModes: string[]
  adapters: string[]
  curated: boolean
}

/** One product under a vendor in the `catalog_models` response. */
export interface CatalogProduct {
  product: string
  routes: CatalogRoute[]
}

/** One vendor in the `catalog_models` response. */
export interface CatalogVendor {
  vendor: string
  products: CatalogProduct[]
}

/** Response shape of the `catalog_models` MCP tool. */
export interface CatalogModelsResponse {
  vendors: CatalogVendor[]
}

/** One servable model in a provider's exhaustive enumeration, from the
 *  read-only `catalog_provider_models` MCP tool (AIP-45 "+" picker). */
export interface CatalogProviderModel {
  id: string
  /** llm / image / video / audio / voice. */
  kind: string
  /** User-facing name where the catalog carries one; else the id. */
  label: string
  /** The provider/route this model is served on, or null when none. */
  route: string | null
  /** Per-1M-token pricing for LLM models; null for the media kinds. */
  pricing: CatalogPricing | null
}

/** Response shape of the `catalog_provider_models` MCP tool. */
export interface CatalogProviderModelsResponse {
  provider: string
  models: CatalogProviderModel[]
}

/**
 * Result of the `llm_endpoint_status` MCP verb — the daemon-supervised
 * `@agentproto/llm-endpoint` proxy sidecar's lifecycle state. `running`
 * reflects a live child, `healthy` a live `GET /v1/models` probe;
 * `never-started` is the fresh-boot state before it has ever been spawned.
 * Mirrors runtime LlmEndpointRegistry.status().
 */
export interface LlmEndpointStatusResult {
  running: boolean
  pid: number | null
  port: number | null
  baseUrl: string | null
  healthy: boolean
  startedAt: string | null
  status: "starting" | "running" | "stopped" | "error" | "never-started"
  lastError?: string
  injectedProviders?: string[]
  linkedProviders?: string[]
}

/** One auth-profile eligible to be linked to an upstream, as reported by
 *  `llm_endpoint_list_links`. Never carries a secret. */
export interface EligibleLinkProfile {
  id: string
  label?: string
  method: "api-key" | "oauth-bearer"
  endpoint: string
}

/** One upstream's link state + its eligible profiles, from `llm_endpoint_list_links`. */
export interface UpstreamLinkInfo {
  provider: string
  /** The DESIRED (persisted) link — a running proxy may lag until restarted. */
  linkedProfile: string | null
  eligible: EligibleLinkProfile[]
}

/** Result of `llm_endpoint_list_links` — the persisted link map plus, per
 *  upstream, the profiles eligible to be linked. */
export interface LlmEndpointLinksResult {
  links: Record<string, string>
  upstreams: UpstreamLinkInfo[]
}

/** Result of `llm_endpoint_set_upstream_link` — the link is persisted; a running
 *  proxy must be restarted to apply it (`restartRequired`). Never hot-applied. */
export interface LlmEndpointSetLinkResult {
  ok: boolean
  provider: string
  profileId: string | null
  cleared?: boolean
  applied: boolean
  restartRequired: boolean
}

/**
 * Result of the proxy's `POST /v1/packs/reload` route — the hot-reload of
 * packs.local.json. Reached directly over loopback (the proxy's HTTP surface
 * isn't exposed through the daemon MCP verbs), mirroring the `/v1/models`
 * discovery transport. `pack_ids` is the merged built-in + local id list;
 * `local_pack_ids` is just the reloaded local packs.
 */
export interface LlmEndpointReloadPacksResult {
  object: "packs.reload"
  reloaded: boolean
  source: string | null
  local_pack_ids: string[]
  pack_ids: string[]
  count: number
}

/**
 * Result of the proxy's `POST /v1/upstreams/:provider/test` route — the
 * cheapest authenticated call to an upstream, reached directly over loopback
 * (mirroring the reload transport). Never carries a secret. A verdict is
 * `{ok, status, detail}`; an upstream with no cheap safe probe is
 * `{ok:null, reason:"no-probe"}`.
 */
export type LlmEndpointUpstreamTestResult =
  | { provider: string; ok: boolean; status: number; detail: string }
  | { provider: string; ok: null; reason: string }

/** Descriptor returned by `llm_endpoint_start` — the freshly spawned (or
 *  reused) proxy child. `wasAlreadyRunning` is true on an idempotent no-op. */
export interface LlmEndpointDescriptorResult {
  pid: number | null
  port: number
  baseUrl: string
  status: "starting" | "running" | "stopped" | "error"
  startedAt: string
  stoppedAt?: string
  lastError?: string
  injectedProviders?: string[]
  wasAlreadyRunning?: boolean
}

/** Options for the `llm_endpoint_start` verb — all optional; the daemon
 *  defaults the port (LLM_ENDPOINT_PORT, then 18090) and leaves the proxy
 *  open when no access tokens are supplied. */
export interface LlmEndpointStartOptions {
  port?: number
  accessTokens?: string
  env?: Record<string, string>
  binPath?: string
}

/** User-facing info of a provider preset, from `list_provider_presets`. */
export interface ProviderPresetInfo {
  schemaFlavor: string
  baseUrl: string
  keyEnv: string
  defaultModel?: string
  homepage?: string
}

/** Per-model curation of a wallet (WS3). Absent ⇒ `mode: "all"` (services
 *  every eligible model). `allow` narrows the wallet to exactly `ids`. */
export interface ModelCuration {
  mode: "all" | "allow"
  ids: string[]
}

/** How a profile's stored secret can be identified (WS5). `stored` ⇒ a
 *  `fingerprint`/`last4` were computed server-side; `self-refreshing` ⇒ a
 *  source-backed profile with no stored secret; `unavailable` ⇒ the secret
 *  could not be read. */
export type ProfileKeyStatus = "stored" | "self-refreshing" | "unavailable"

/** A named auth profile's non-secret metadata, as returned by
 *  `auth_profile_list` (never carries the credential). `credentialRef` is
 *  set for a credential-backed profile; `source` for a self-refreshing
 *  source-backed one — mutually exclusive. */
export interface AuthProfileSummary {
  id: string
  endpoint: string
  method: AuthMethod
  credentialRef?: string
  source?: string
  label?: string
  /** Whole-profile enable/disable (WS2). Absent/false ⇒ enabled. */
  disabled?: boolean
  /** Per-model curation allowlist (WS3). Absent ⇒ services every eligible model. */
  models?: ModelCuration
  /** Key-identity status computed server-side from the keychain (WS5). */
  keyStatus?: ProfileKeyStatus
  /** One-way fingerprint of the stored secret — present only when
   *  `keyStatus === "stored"`. Never the secret. */
  fingerprint?: string
  /** Trailing 4 chars of the stored secret — present only when
   *  `keyStatus === "stored"` and the secret is long enough. */
  last4?: string
  /** Provenance (WS6) — the discovery origin this profile was imported from
   *  (`auth_profile_import`). Absent for a hand-created profile. Drives the
   *  panel's "imported from <origin>" badge. */
  origin?: string
}

/** Request body for `auth_profile_create`. `credential` is INPUT-only — the
 *  daemon stores it in the keychain and never echoes it back. Give exactly
 *  one of `credential` / `source` (oauth-bearer only). */
export interface CreateAuthProfileRequest {
  id: string
  endpoint: string
  method: AuthMethod
  credential?: string
  source?: string
  label?: string
  credentialRef?: string
}

/** Non-secret result of `auth_profile_create` — metadata + a one-way
 *  fingerprint of the stored credential, never the credential itself.
 *  `fingerprint` is absent for a source-backed profile (nothing stored). */
export interface CreatedAuthProfileResult {
  id: string
  endpoint: string
  method: AuthMethod
  credentialRef?: string
  source?: string
  label?: string
  /** Provenance stamped at import time (WS6) — the discovery origin. Absent
   *  for a hand-created profile. */
  origin?: string
  fingerprint?: string
}

/** Request body for `auth_profile_import` (WS6). Names a credential DISCOVERED
 *  by `auth_discover_credentials`; the daemon materializes it into a profile.
 *  No secret crosses the wire — the daemon reads it locally. */
export interface ImportCredentialRequest {
  origin: CredentialOrigin
  endpoint: string
  id?: string
  label?: string
}

/** Where a discovered credential came from (`auth_discover_credentials`). */
export type CredentialOrigin =
  | "claude-code"
  | "hermes-config"
  | "env"
  | "codex"
  | "gemini"

/** One found-but-not-imported credential from `auth_discover_credentials` — a
 *  read-only scan of the known local credential locations. Carries provenance
 *  and a non-secret `hint` locator only; NEVER the credential value. */
export interface DiscoveredCredential {
  endpoint: string
  method: AuthMethod
  origin: CredentialOrigin
  hint: string
}

/** One entry from `list_provider_presets`. */
export interface ProviderPresetEntry {
  slug: string
  name?: string
  description?: string
  status: "available" | "ready"
  version?: string
  info?: ProviderPresetInfo
}

/** A reusable, user-scoped preset saved to ~/.agentproto/presets.json (GET /user-presets). */
export interface UserPreset {
  id: string
  label: string
  adapter?: string
  harness?: string
  model?: string
  route?: RouteSpec
  access?: { profileRef?: string }
  posture?: Posture
  effort?: EffortLevel
  contextProfile?: ContextProfile
  /** Working directory the favorite pins to — makes it location-independent
   *  of the caller's open folder (true zero-input spawn). */
  cwd?: string
  /** Skills to preload for a spawn from this preset. */
  skills?: string[]
}

/** A session lifecycle event from session_events_poll (MCP). */
export interface SessionLifecycleEvent {
  type: string
  sessionId?: string
  ts?: string
  [k: string]: unknown
}

/** session_events_poll MCP tool result (parsed from the tools/call text content). */
export interface SessionEventsPollResult {
  events: SessionLifecycleEvent[]
  nextCursor: number
}

/** One line from /sessions/:id/stream SSE. */
export interface SessionStreamLine {
  line: string
  stream?: "stdout" | "stderr" | string
}

/**
 * One record from GET /sessions/:id/events — the daemon's durable
 * per-session events.jsonl capture (packages/runtime transcript-writer.ts).
 *
 * This is the NORMALIZED semantic-event boundary: provider/model differences
 * (Claude-wire, Kimi-behind-Claude-transport, hermes, mastracode, …) are
 * already resolved by the adapter/protocol layer BEFORE a record is written,
 * so a frontend renders structured components without ever parsing a raw
 * provider payload. Records never contain credentials. Optional fields
 * default to undefined; an unknown `kind` is ignored by the reducer.
 *
 * Field-for-field superset of the daemon's TranscriptRecord
 * (transcript-export.ts) plus the writer's own "user-prompt" /
 * "usage_snapshot" records. Do NOT reshape without a coordinated daemon change.
 */
export interface SessionEventRecord {
  /** Monotonic per-session sequence — the cursor unit for `since` polling. */
  seq: number
  /** ISO-8601 timestamp the daemon stamped when the record was written. */
  ts: string
  kind: string
  sessionId?: string
  text?: string
  partial?: boolean
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  /** True when a "tool-call" record ENRICHES a call already announced under
   *  the same toolCallId (an agent that announced before it knew the input),
   *  rather than announcing a new one. reduceConversation merges by
   *  toolCallId regardless, so this is descriptive rather than load-bearing. */
  isUpdate?: boolean
  result?: unknown
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: unknown }
  options?: unknown
  /** "permission-resolved" outcome for the "agent-prompt" (same toolCallId)
   *  it answers — see @agentproto/runtime's transcript-writer.ts. */
  decision?: "approve" | "deny" | "cancelled"
  /** "permission-resolved" chosen option id, when the driver's offered
   *  options included one. */
  optionId?: string
  entries?: Array<{ content: string; priority: string; status: string }>
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
  tokensIn?: number
  tokensOut?: number
  // usage_snapshot-only fields (turn-boundary durable recap)
  model?: string
  costUsd?: number
  contextSize?: number
  contextUsed?: number
  /** usage_snapshot: which usage source produced the recap. user-prompt:
   *  the turn's provenance — `agent:<sessionId>` when another session
   *  injected it (agent_prompt from a supervisor, a parent's spawn
   *  prompt); absent for a human operator. */
  source?: string
}

/** GET /sessions/:id/events response envelope (http-server.ts). */
export interface SessionEventsPage {
  sessionId: string
  events: SessionEventRecord[]
  /** Cursor to pass as `since` on the next poll — never regresses. */
  nextSeq: number
  /** false when the page was capped by `limit` and more records remain. */
  complete: boolean
}

/**
 * Global RuntimeEvent from GET /events SSE. NOTE: the daemon's /events
 * stream carries ONLY runtime events (boot, heartbeat-*, conv-turn-appended,
 * remote-log) — it does NOT surface session:* lifecycle events. Those are
 * read via session_events_poll (MCP). Kept here so an /events subscriber
 * can still type the frames it receives.
 */
export type RuntimeEvent =
  | { type: "boot"; at: string; workspace: string; registered: readonly string[] }
  | {
      type: "heartbeat-fired"
      at: string
      agent: string
      conversationId: string
      prompt: string
      reply: string
      durationMs: number
    }
  | { type: "heartbeat-error"; at: string; agent?: string; error: string }
  | {
      type: "conv-turn-appended"
      at: string
      conversationId: string
      role: "user" | "assistant"
      contentPreview: string
    }
  | { type: "remote-log"; at: string; line: string }

/**
 * A registered workspace from the daemon's ~/.agentproto/workspaces.json
 * control plane (GET /workspaces). Mirrors the daemon's `WorkspaceEntry`
 * (runtime/src/workspaces-config.ts).
 *
 * NOTE the asymmetry this exists to paper over: a SessionDescriptor carries
 * only `workspaceSlug`, and that slug silently defaults to "default" on the
 * terminal/raw spawn paths (only POST /sessions/agent reverse-maps cwd →
 * slug daemon-side). So a client that wants reliable workspace attribution
 * resolves `descriptor.cwd` against this list itself.
 */
export interface WorkspaceEntry {
  /** Stable handle: /^[a-z0-9][a-z0-9-]{0,63}$/. */
  slug: string
  /** Absolute path to the workspace root. */
  path: string
  addedAt: string
  updatedAt: string
  /** Free-text display name; falls back to `slug` when absent. */
  label?: string
}

export interface WorkspacesConfig {
  version: 1
  /** Slug of the daemon's active workspace, when one is set. */
  active?: string
  workspaces: WorkspaceEntry[]
}

// ── Worktree GC (mirrors @agentproto/runtime worktree-gc.ts — the client takes
//    no runtime import; keep in sync by hand). `reclaim` = safe to remove
//    (merged, clean, no open PR, no live session); `salvage` = dirty, only
//    removed with salvageDirty; `hold` = kept (open PR or a live session). ──
export type WorktreeGcClass = "reclaim" | "salvage" | "hold"

/** Set only on a `reclaim`-class entry/outcome promoted out of `hold` by the
 *  dep-bump exemption — absent for an ordinary merged/fresh reclaim. */
export type WorktreeGcReclaimReason = "dep-bump"

export interface WorktreeGcPlanEntryView {
  path: string
  branch: string | null
  head: string
  class: WorktreeGcClass
  reclaimReason?: WorktreeGcReclaimReason
  tree: string
  integration: { state: string; pr?: number }
  liveness: { state: string; sessionCount: number }
}

export interface WorktreeGcOutcomeView {
  path: string
  branch: string | null
  result:
    | "reclaimed"
    | "salvaged"
    | "held"
    | "skipped-dirty"
    | "aborted-reclassified"
    | "aborted-vanished"
    | "failed"
  reclaimReason?: WorktreeGcReclaimReason
  salvageDir?: string
  from?: WorktreeGcClass
  to?: WorktreeGcClass
  message?: string
}

export type WorktreeGcResult =
  | { mode: "plan"; plan: WorktreeGcPlanEntryView[] }
  | { mode: "apply"; outcomes: WorktreeGcOutcomeView[] }

// ── Configuration Lab read-only mirrors ─────────────────────────────────────
//    Non-secret shapes surfaced by the Agentproto Configuration Lab panel.

/** A provider capability advertised by a harness (mirror of provider-kit
 *  ProviderCapability, trimmed to what the Lab displays). */
export interface HarnessProviderCapability {
  id: string
  name?: string
  ready?: boolean
  /** Billing endpoint this provider bills against (mirror of provider-kit
   *  ProviderCapability.billingEndpoint). The daemon sends it on the wire;
   *  the auth-model mind map reads it to key a harness→provider edge. Absent
   *  ⇒ fall back to `id`. */
  billingEndpoint?: string
  /** Native wire protocol this provider speaks (mirror of provider-kit
   *  ProviderCapability.apiMode). Drives native-vs-router classification. */
  apiMode?: "anthropic" | "chat_completions"
}

/** Model discovery summary advertised by a harness (mirror of provider-kit
 *  ModelDiscovery, trimmed). */
export interface HarnessModelDiscovery {
  defaultModel?: string
  supported?: string[]
}

/** Application contract defaults/options advertised by a harness (mirror of
 *  provider-kit ApplicationContract, trimmed). */
export interface HarnessApplicationContract {
  defaultOptions?: Record<string, unknown>
  supportedOptions?: string[]
}

/** Non-secret harness capability snapshot, returned by MCP
 *  `harness_capabilities`. */
export interface HarnessCapabilities {
  adapter: string
  /** Whether capabilities came from live discovery or manifest fallback. */
  source?: "discovered" | "manifest-fallback"
  /** Auth store kinds this harness can read (e.g. "keychain", "env"). */
  authStores?: string[]
  /** Providers this harness can bill. */
  providers?: HarnessProviderCapability[]
  /** Model defaults / supported model ids. */
  models?: HarnessModelDiscovery
  /** Adapter-specific spawn options / defaults. */
  application?: HarnessApplicationContract
  /** Which OpenAI/Anthropic-compatible endpoint this harness can be re-pointed
   *  at, and how (mirror of provider-kit EndpointCompat). Presence of
   *  `anthropic` is the live signal that a harness speaks the Anthropic wire
   *  and accepts a custom base_url — the key input to the mind map's
   *  native-vs-via-router reach classification. The daemon sends it on the
   *  wire; older client mirrors dropped it. */
  endpointCompat?: {
    openai?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
    anthropic?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
  }
}

/** Per-axis option list for the Configuration Lab UI. */
export interface ConfigurationLabAxisOptions {
  models: Array<{ id: string; provider?: string; mode?: string }>
  routes: Array<{ value: string; label: string; runnable: boolean; curated: boolean; eligibleProfiles: string[]; fixed?: boolean; ref?: string }>
  profiles: Array<{ value?: string; label: string; description?: string; addProfile?: boolean }>
  postures: Array<{ value: string; label: string; enforcement: "enforced" | "advisory"; restartRequired: boolean }>
  efforts: string[]
}

/** One field in the readable effective-config summary. */
export interface ConfigurationLabEffectiveField {
  key: string
  /** Human-readable display value; undefined means unset. */
  value?: string
  /** Whether this value came from an explicit user selection, an adapter
   *  default, or is unset. */
  source: "explicit" | "default" | "unset"
  /** Optional extra context (e.g. the resolved gateway, advisory label). */
  detail?: string
}

/** A validation issue surfaced by the Lab. */
export interface ConfigurationLabIssue {
  severity: "error" | "warning" | "info"
  axis?: "harness" | "model" | "route" | "profile" | "posture" | "effort" | "option"
  message: string
}

/** The serializable snapshot passed from extension host to the Lab webview. */
export interface ConfigurationLabSnapshot {
  /** Current user selections. */
  selection: {
    adapter?: string
    model?: string
    route?: string
    profile?: string
    posture?: string
    effort?: string
    options?: Record<string, unknown>
  }
  /** All installed adapters, so the webview can render the harness dropdown. */
  adapters: AdapterInfo[]
  /** Harness layer (A). */
  harness: {
    slug: string
    name?: string
    version?: string
    protocol?: string
    modes?: Array<{ id: string; status?: string; status_note?: string }>
    capabilities?: HarnessCapabilities
  } | null
  /** Configuration layer (B) — per-axis options. */
  axes: ConfigurationLabAxisOptions
  /** Resolved/effective launch configuration summary. */
  effective: ConfigurationLabEffectiveField[]
  /** Validation issues, if any. */
  issues: ConfigurationLabIssue[]
}

/** Input the Lab sends when it wants a fresh snapshot for a new selection. */
export interface ConfigurationLabSelectionInput {
  adapter?: string
  model?: string
  route?: string
  profile?: string
  posture?: string
  effort?: string
  options?: Record<string, unknown>
}

/** Aggregate fetched from the daemon to produce a ConfigurationLabSnapshot. */
export interface ConfigurationLabRawData {
  adapters: AdapterInfo[]
  capabilities: HarnessCapabilities[]
  catalog: CatalogModelsResponse
  profiles: AuthProfileSummary[]
  presets: ProviderPresetEntry[]
}
