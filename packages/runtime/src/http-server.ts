/**
 * Tiny node:http server that fronts the runtime gateway.
 *
 * Routes:
 *   GET  /health              — { status, workspace, registered, uptime }
 *   GET  /events              — SSE stream of RuntimeEvent
 *   POST /mcp                 — MCP Streamable HTTP transport (POST)
 *   GET  /mcp                 — MCP SSE response stream (GET)
 *   DELETE /mcp               — close MCP session
 *   GET  /conversations       — JSON list of conversation summaries
 *   GET  /conversations/<id>  — markdown body of one conversation
 *   POST /heartbeat/tick      — force-fire one heartbeat tick
 *
 * No auth in `mode: "none"` (loopback default). `mode: "bearer"`
 * checks `Authorization: Bearer <token>` against the configured
 * token. Health is always public so external monitors can probe.
 *
 * MCP transport: stateless mode for v1 — each request is independent.
 * Stateful session pinning can come later when long-running streaming
 * tool calls become a real use case.
 */

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path"
import type { AcpMcpServer } from "@agentproto/acp"
import type { SandboxMode } from "@agentproto/command-sandbox"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { WebSocketServer, type WebSocket } from "ws"
import { ZodError } from "zod"
import type { UIMessageChunk } from "ai"
import type { AgentprotoRawTranscriptRecord } from "@agentproto/transcript-fixtures"
import type { ConversationStore } from "./conversations.js"
import type { HeartbeatRunner } from "./heartbeat.js"
import type { RuntimeEvents, RuntimeEvent } from "./events.js"
import type { SessionsRegistry, AgentSessionLike, RestartPolicy } from "./sessions.js"
import { SessionNotAliveError } from "./sessions.js"
import type { TunnelRegistry } from "./tunnel-registry.js"
import type { PairingRegistry } from "./pairing-registry.js"
import { createReconnectLogGate } from "./reconnect-log-gate.js"
import type { WorkflowRunner, WorkflowStage } from "./workflow-runner.js"
import type { AppRegistry } from "./app-registry.js"
import { performAppToolCall, type AppToolCallDeps } from "./app-tools.js"
import { injectStandaloneAppBridge } from "./app-ui-apps.js"
import {
  assertExternalPathRealInside,
  isExternalRootGranted,
  realpathExternalRoot,
  resolveExternalPath,
} from "./app-external.js"
import { mimeTypeFor } from "./outbound-adapters.js"
import {
  loadWorkspacesConfig,
  saveWorkspacesConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  findWorkspace,
  findWorkspaceByPath,
  getActiveWorkspace,
} from "./workspaces-config.js"
import { discoverMcps } from "./mcp-discovery.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import type { InboundMessage, InboundRouteMode } from "./inbound-router.js"
import { normalizeInbound, verifyInboundSignature, type InboundProvider } from "./inbound-adapters.js"
import type { InboundEndpoint, InboundEndpointStore } from "./inbound-endpoints.js"
import type {
  BrowserAdapterResolver,
  BrowserAdapterLister,
} from "./browser-tools.js"
import type {
  OrchestratorScope,
  OrchestratorMcpServerFactory,
} from "./orchestrator-gateway.js"
import type { HarnessCapabilities } from "@agentproto/provider-kit"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"
import { exportAgentSession } from "./transcript-export.js"
import { parseWindow, rollupUsage } from "./usage-rollup.js"
import {
  collectSessionSnapshots,
  enrichRollupWithAccountCredits,
  enrichRollupWithProviderQuota,
} from "./usage-rollup-service.js"
import { readConversation } from "./conversation-read.js"
import { sessionEventsPath } from "./transcript-writer.js"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { createTranscriptToUiMapper } from "./chat-stream.js"
import {
  monitorSessionWait,
  monitorPolicyWait,
  type SessionWaitEvent,
} from "./orchestration-tools.js"
import type {
  SessionEventBus,
  SessionEventType,
} from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { ActivityProjector } from "./activities.js"
import {
  activityCounts,
  parseActivityKind,
  parseActivitySource,
  parseActivityState,
  type ActivityListFilter,
} from "./activity-projection.js"
import { policyWatchesSession } from "./supervisor.js"
import type { CompletionPolicySupervisor, AttachPolicyInput, GateSpec } from "./supervisor.js"
import { parseTaskStatus } from "./task-ledger.js"
import type {
  TaskCaller,
  TaskCreateInput,
  TaskLedger,
  TaskUpdateInput,
  TaskWriteResult,
} from "./task-ledger.js"
import type {
  DeclaredAdapterOption,
  AdapterAuthDescriptor,
  ResolvedAuthSpec,
} from "./spawn-defaults.js"
import type { ContextProfile, Posture } from "./session-config.js"
import { spawnAgentSession, type BuildOrchestratorMcp, type SpawnAgentSessionInput, type SandboxSpecInput, type SpawnAgentSessionDeps } from "./session-spawn.js"
import {
  restartAgentSession,
  RestartOverrideError,
  type RestartOverrides,
} from "./session-restart-core.js"
import { parsePostureInput } from "./canonical-posture.js"
import {
  deleteUserPreset,
  getUserPreset,
  listUserPresets,
  saveUserPreset,
  type UserPreset,
} from "./user-presets.js"
import type { WorktreeField, WorktreeProvisioner } from "./worktree-isolation.js"
import { tryParseJson } from "./json-tolerant.js"
import { sandboxSpecWithReuseSchema } from "./sandbox-spec-schema.js"
import { listPresets } from "./preset-tools.js"
import {
  resolveWorktreeQueryRoot,
  type WorktreeStatusLister,
} from "./worktree-status.js"
import { livingSessionCwds, type WorktreeGcRunner } from "./worktree-gc.js"
import type {
  CatalogModelsQuery,
  CatalogModelsResponse,
} from "./catalog-models.js"
import { defaultProfileProvisionDeps } from "./auth-profile-tools.js"
import {
  createAuthProfile,
  deleteAuthProfile,
  listAuthProfiles,
  AuthProfileValidationError,
} from "@agentproto/auth"

/**
 * Default Origin allowlist used when `RuntimeHttpServerOptions.allowedOrigins`
 * is undefined. Localhost on any port covers the user's own dev environments
 * (Guilde web dev server, playground demos, embedded panels). Production
 * origins (https://guilde.work, …) are NOT included by default — those are
 * opt-in via `agentproto serve --allow-origin <url>`.
 */
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  // The canonical hosted agentproto panel (github.com/agentproto/cli-site,
  // deployed at cli.agentproto.sh). It drives the user's OWN local daemon
  // from the browser: read-only GETs (session list, SSE stream) are ungated
  // and already work, but the /sessions/:id/pty WebSocket upgrade IS gated —
  // so a PTY terminal in the panel 401s unless this first-party origin is
  // trusted like localhost. A malicious page can't forge this Origin (the
  // browser sets it), so the trust is scoped to agentproto's own panel,
  // matching how guilde.work is trusted. Drop it via `strictOrigins`.
  "https://cli.agentproto.sh",
]

/**
 * Request headers whose mere presence proves a proxy/tunnel forwarded the
 * request — so a loopback socket carrying any of them did NOT originate on
 * this machine and must not get the loopback auth bypass (`isLoopback`).
 * Cloudflared sets X-Forwarded-For; other proxies set X-Real-IP / Forwarded /
 * CF-* even when they strip XFF, so the bypass keys on the whole family.
 */
const PROXY_FORWARDING_HEADERS: readonly string[] = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "cf-connecting-ip",
  "cf-ray",
  "via",
]

/**
 * Pluggable adapter resolver — keeps the runtime package free of any
 * @agentproto/cli dep. The host (cli `serve`, playground, embedding
 * apps) builds the resolver and hands it in. Returning null means
 * "adapter not found" → 404.
 */
export type AgentAdapterResolver = (slug: string) => Promise<{
  /** Build a fresh AgentSessionLike for the given cwd. The driver
   *  spawns the adapter binary, opens the protocol, and the
   *  registry holds the result.
   *
   *  When `resumeSessionId` is set, the driver reattaches to that
   *  pre-existing adapter session (claude-code's conversation id,
   *  hermes' chat handle, …) rather than starting blank. Same
   *  mechanism as `agentproto run --resume <id>` — exposed over
   *  HTTP so `agentproto sessions restart` works on agent-cli
   *  sessions, not just PTY ones. */
  startSession(opts: {
    cwd: string
    resumeSessionId?: string
    /** Persistent isolated-config location for the adapter (claude-code's
     *  `CLAUDE_CONFIG_DIR`) — forwarded to the driver's
     *  `start({ configDir })`. The daemon keys it per session lineage
     *  (`SessionDescriptor.adapterConfigDir`) so the provider's own
     *  conversation store survives adapter respawns and `resumeSessionId`
     *  can restore full context instead of falling back to a digest.
     *  Adapters that don't isolate a config dir ignore it. */
    configDir?: string
    /**
     * Manifest-declared mode id forwarded from `agent_start` (AIP-45
     * `AgentCliHandle.modes` — e.g. claude-code's `plan` /
     * `accept-edits` / `bypass-permissions`, codex's `read-only`,
     * mastracode/opencode's `plan`). Applied at spawn time via
     * `composeSpawn`'s mode patch (`bin_args_append` / `env`) — BEFORE
     * the child process is exec'd, unlike `model`/`effort` below.
     * Adapters with no declared `modes` (e.g. hermes) ignore it; an
     * unknown id for an adapter that DOES declare modes throws
     * `RuntimeConfigError` (composeSpawn validates against the
     * manifest, so a typo fails the spawn rather than silently no-op).
     */
    mode?: string
    /**
     * Manifest-declared option id → value map forwarded from
     * `agent_start` (AIP-45 `AgentCliHandle.options` — e.g. hermes'
     * `skills`). Applied at spawn time via `composeSpawn`'s option
     * patches (`bin_args_prepend` / `bin_args_template` /
     * `bin_args_append_when_true` / `env`), validated against each
     * option's declared `type`/`enum`/`min`/`max`. An id the adapter
     * doesn't declare throws `RuntimeConfigError` (composeSpawn
     * validates against the manifest, same as an unknown `mode`).
     */
    options?: Record<string, boolean | number | string>
    /** Model identifier forwarded from `agent_start`. For ACP
     *  adapters this is applied via session/set_config_option after
     *  newSession (the ACP wrapper does not forward CLI args to claude).
     *  Adapters that don't support model selection ignore it. */
    model?: string
    /** Effort level forwarded from `agent_start`. Effort is
     *  model-dependent — same label ≠ same budget across models; defaults
     *  differ by model. Omit to keep the model's own default. Applied
     *  via session/set_config_option on ACP adapters; others ignore it. */
    effort?: string
    /** Decomposed permission posture. The host maps canonical string values
     * to the adapter's native spawn mechanism; raw harness ids may instead be
     * applied through the live ACP mode surface after connect. */
    posture?: Posture
    /** Decomposed context profile. A matching manifest `kind:"context"` mode
     * is projected independently of the legacy `mode` field. */
    contextProfile?: ContextProfile
    /** MCP servers to mount into the spawned agent's session at spawn
     *  time. Forwarded verbatim to the driver's `start({ mcpServers })`
     *  → the ACP arm's `session/new.mcpServers`, giving the child agent
     *  a host-chosen scoped toolset (e.g. the daemon's own orchestration
     *  gateway). Adapters that don't model MCP mounting ignore it. */
    mcpServers?: AcpMcpServer[]
    /** Called on any adapter-process activity (ACP JSON-RPC traffic in
     *  either direction) — forwarded to the driver's
     *  `runtime.start({ onActivity })`. The caller (agent_start's MCP
     *  handler, POST /sessions/agent) wires this to pulse
     *  `SessionDescriptor.lastActivityAt` via `registry.pulseActivity(id)`. */
    onActivity?: () => void
    /** Start the session in permission-hold mode — forwarded to the driver's
     *  `runtime.start({ permissionHold })` so each ACP permission request is
     *  surfaced + parked in the daemon's inbox instead of auto-answered.
     *  Adapters/arms with no permission surface ignore it. Default false. */
    permissionHold?: boolean
    /** FULLY-RESOLVED billing-auth spec forwarded from `agent_start` to the
     *  driver's `runtime.start({ auth })`, computed by the runtime's
     *  `resolveAuthSpec` (provider, ordered mode, setEnv/scrub, credential
     *  source all pre-decided). The driver applies it mechanically. Absent
     *  when the resolver produced no spec (ambient). */
    auth?: ResolvedAuthSpec
    /** OS-level confinement for the adapter's OWN spawned process
     *  (`@agentproto/command-sandbox` — macOS Seatbelt / Linux bubblewrap),
     *  forwarded from `agent_start`'s `commandSandbox` field to the driver's
     *  `runtime.start({ commandSandbox })`. NOT the AIP-36 `sandbox` field
     *  (a remote-box session provider) — this wraps THIS host's spawn argv.
     *  Undefined ⇒ falls back to the workspace's `.agentproto/
     *  command-sandbox.json` `adapterSpawn` key (see `@agentproto/
     *  command-sandbox`'s `loadAdapterSpawnSandboxConfig`), or stays
     *  unconfined if that's unset too. */
    commandSandbox?: SandboxMode
    /** Extra env for the spawned adapter process — forwarded verbatim to the
     *  driver's `runtime.start({ env })`, which the AIP-45 driver already
     *  applies LAST (after manifest/mode/option env and billing-auth), so
     *  these keys always win. `spawnAgentSession` (session-spawn.ts) uses
     *  this to inject the daemon's own session-identity vars
     *  (`SESSION_ID_ENV`/`WORKSPACE_SLUG_ENV`, see sessions.ts) — there is
     *  no caller-facing `env` passthrough on `agent_start` today, so this is
     *  daemon-authored only, not a general escape hatch. */
    env?: Record<string, string>
    /** Absolute paths OUTSIDE the session cwd the adapter's workspace
     *  toolset may READ (never write). Daemon-authored only — used for the
     *  exact AGENTS.md file an inherited (pointer-mode) prompt names, so a
     *  cwd below the repo root can actually read the contract file its
     *  prompt points at instead of erroring
     *  (`path … escapes the workspace`). NOT a general escape hatch: the
     *  driver forwards these to its confinement layer as extra READ paths
     *  and (for the mastra-agent adapter) to `makeWorkspaceTools` as a
     *  read-only grant; writes and sibling reads stay denied. Adapters
     *  that can't model the grant ignore it. */
    additionalReadPaths?: string[]
  }): Promise<AgentSessionLike>
  /** Display label for the descriptor's `command` field. */
  commandPreview?: string
  /** Best-effort per-session usage reader (adapter-specific, e.g. hermes state.db). */
  readUsage?: (adapterSessionId: string) => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** AIP-45 `options[]` this adapter's manifest declares (id + type only —
   *  no spawn internals). Lets `session-spawn.ts` fold a config-level
   *  `defaults.skills` list into `options.skills` using the shape the
   *  manifest actually declared (e.g. hermes' comma-joined string),
   *  instead of guessing. Omitted/empty ⇒ the skills normalization is a
   *  documented no-op for that adapter (e.g. claude-code, which
   *  auto-discovers skills and declares no such option). */
  declaredOptions?: readonly DeclaredAdapterOption[]
  /** Billing-auth descriptor projected from the adapter manifest
   *  (`provider` / `authEnforce` / `authSubscription`) — the sole input the
   *  runtime's `resolveAuthSpec` reads about the adapter's auth capability
   *  (keeping the catalog coupling in the runtime, the driver mechanical).
   *  Omitted ⇒ ambient (no credential injection). */
  authDescriptor?: AdapterAuthDescriptor
  /** Manifest-declared `AgentCliDefinition.routeSelection` (AIP-45 launch-menu
   *  drill-down, WP1) — `"derived-from-model"` when the adapter's billing
   *  ROUTE falls out of the requested model id's own vendor prefix (hermes,
   *  pi, opencode, …), `"free"`/omitted otherwise (the route is an
   *  independent choice, e.g. claude-code/claude-sdk gateway modes). Read by
   *  `session-spawn.ts` to decide whether an unusable resolved `base_url` can
   *  be silently skipped (the adapter derives its own gateway) or must fail
   *  loud (it can neither accept `base_url` nor derive its route) — and to
   *  gate the wire-model vendor-prefix strip the same way `stripAnthropicNativeVendor`
   *  always has, generalized to any fixed-provider adapter. */
  routeSelection?: "free" | "derived-from-model"
  /** Adapter's default model id (`models.default`) — lets the resolver derive
   *  a provider for a by-model spawn that omitted `model`. */
  defaultModel?: string
  /** Manifest-declared `capabilities.resumable` (AIP-45) — whether THIS
   *  adapter can actually rehydrate a prior conversation from a captured
   *  session id, as opposed to merely having one recorded. Threaded onto
   *  {@link SessionDescriptor.resumable} at spawn/restart time so the resume
   *  path (`resume-strategies.ts`'s `describeResumePath`/`decideRestartStrategy`)
   *  can gate its "resumed via ACP" label on real capability instead of
   *  hardcoding a slug list. `false` ⇒ a captured `adapterSessionId` is a
   *  dead end (e.g. hermes, mastra-agent) — never pass it as
   *  `resumeSessionId`. Omitted/`true` ⇒ unchanged (assumed resumable),
   *  preserving today's behaviour for every adapter that doesn't set this. */
  resumable?: boolean
  /**
   * Manifest-declared `capabilities.nativeTerminalResume` (AIP-45) — whether
   * THIS adapter has a verified native CLI resume into a real terminal/TUI
   * (e.g. `claude --resume <id>` or `hermes --resume <id> --tui`). Governs
   * the `pty-native` restart strategy: only adapters with this flag set may
   * be restarted via their native resume argv as a PTY session. ACP
   * resumability (`resumable`) does NOT imply terminal compatibility.
   * Omitted/`false` ⇒ the adapter falls back to ACP-level or fresh-spawn
   * restart even when a native resume id is available.
   */
  nativeTerminalResume?: boolean
} | null>

/**
 * UI-safe projection of an AIP-45 `modes[]` entry as surfaced by
 * `adapter_list`. Mirrors `@agentproto/cli`'s `AdapterMode` without
 * importing it (the runtime deliberately carries no cli dep — see the
 * `AgentAdapterLister` note above). Spawn internals (`bin_args_*`, `env`)
 * are intentionally omitted; `status` is normalised to `"active"` by the
 * lister when the manifest omits it, so a declared mode is never
 * silently statusless.
 */
export interface AdapterListMode {
  id: string
  description?: string
  status: "active" | "noop" | "planned"
  status_note?: string
}

/**
 * Compact adapter metadata for the discovery endpoints. Independent
 * of the resolver function above — hosts that can list installed
 * adapters wire this; hosts that can only resolve by-slug skip it
 * (the routes 501).
 */
export interface AdapterListEntry {
  slug: string
  name: string
  version: string
  description: string
  protocol: string
  streaming: boolean
  packageName: string
  /** Declared operation modes with their honest support status, so a
   *  client can see e.g. hermes' `lean` mode is a measured no-op instead
   *  of being silently accepted. Empty when the adapter declares none. */
  modes: AdapterListMode[]
  /**
   * How this adapter's spawn ROUTE relates to the chosen model (AIP-45
   * launch-menu drill-down): `"free"` = the route is an independent choice;
   * `"derived-from-model"` = the endpoint falls out of the model id's vendor
   * prefix (a read-only badge, not a choice). Absent ⇒ `"free"` (back-compat).
   * A capability-derived spawn/config drill-down reads this so no UI surface
   * has to re-infer it from the model list and drift. Mirrors `@agentproto/
   * cli`'s `AdapterInfo.routeSelection` without importing it.
   */
  routeSelection?: "free" | "derived-from-model"
}

export type AgentAdapterLister = () => Promise<AdapterListEntry[]>

/**
 * Loads harness capability-discovery records (`@agentproto/provider-kit`'s
 * `HarnessCapabilities`) for `harness_capabilities` — what each installed
 * adapter can actually DO on this host (creds present, reachable billing
 * providers, model-discovery mechanism, endpoint compat, model/posture
 * application). `adapter` optionally narrows to one slug; omitted → every
 * installed adapter. Mirrors `AgentAdapterLister`'s injection shape. Hosts
 * ship the cli's lister (built over `resolveAdapter`'s optional
 * `capabilitiesStrategy` + `discoverCapabilities`). Omitted ⇒ the tool
 * reports "not enabled" (same convention as `listAgentAdapters`).
 */
export type AdapterCapabilitiesLister = (opts?: {
  adapter?: string
}) => Promise<HarnessCapabilities[]>

/**
 * Outcome of an `adapter_install` / `POST /adapters/:slug/install` request.
 * Independent of the lister/resolver above — a host that can drive an
 * install path wires an `AgentAdapterInstaller`; a host that can't skips it
 * (the tool/route report "not enabled", same convention as the lister).
 *
 * `method` names WHICH install path ran so a client can explain it:
 *   - `"npm-global"`      — `npm i -g <packageName>` for an acp-catalog CLI
 *   - `"agentproto-install"` — drove `agentproto install <slug>` (the
 *                            manifest `install[]` pipeline for a first-party
 *                            adapter)
 *   - `"already-installed"` — nothing to do; the slug was already `ready`
 *   - `"unsupported"`     — no known install path for this slug
 *
 * `ok` reflects only whether the install COMMAND succeeded. `status` carries
 * the adapter's readiness re-read after the attempt (via the same lister the
 * discovery endpoints use), so a client can refresh a row without a second
 * round-trip; it's absent when the re-read itself failed.
 */
export interface AdapterInstallResult {
  slug: string
  ok: boolean
  method:
    | "npm-global"
    | "shell-hint"
    | "agentproto-install"
    | "already-installed"
    | "unsupported"
  /** Human-readable one-liner: what ran, and how it ended. */
  message: string
  /** The shell command that was run, for surfacing in logs / errors.
   *  Absent for the `already-installed` / `unsupported` methods. */
  command?: string
  /** Exit code of `command` when one ran. */
  exitCode?: number
  /** The adapter's readiness re-read after the attempt. Absent if the
   *  post-install re-list failed (the install itself may still have
   *  succeeded — read `ok`). */
  status?: "supported" | "available" | "ready" | "unresolvable"
  /** True when the install failed ONLY because a manifest setup step
   *  declares `interactive: true` and this process has no TTY to run it
   *  in (e.g. openclaw's `onboard --install-daemon` TUI). The remedy is a
   *  real terminal — `agentproto setup <slug>` — which a UI can offer
   *  directly as a PTY terminal session. */
  needsInteractiveSetup?: boolean
}

/**
 * Installs an agent CLI adapter by slug and reports the outcome. Wired by
 * the daemon from `@agentproto/cli`'s `installAdapter` (which knows the
 * catalog + the two install classes); the runtime stays cli-free and only
 * exposes the verb. Must never throw for an ordinary install failure —
 * report it via `ok:false` + `message` — so the MCP tool / HTTP route can
 * return a clean result instead of a 500.
 */
export type AgentAdapterInstaller = (
  slug: string,
) => Promise<AdapterInstallResult>

/** Loads the read-only vendor/product/route catalog (SPEC §5) for
 *  `GET /catalog/models` + the `catalog_models` MCP tool. A host wires this
 *  from `buildCatalogModels` (`catalog-models.ts`) fed by its installed
 *  adapters + `@agentproto/auth`'s `listAuthProfiles()` — the query params
 *  are forwarded verbatim from the request. Omitted ⇒ the route/tool
 *  report "not enabled" (same convention as `listAgentAdapters`). */
export type CatalogModelsLister = (
  query: CatalogModelsQuery,
) => Promise<CatalogModelsResponse>

export interface AuthOptions {
  mode: "none" | "bearer"
  token?: string
}

/**
 * Auth can be a fixed value (set at startup) or a getter (re-read on
 * every request). The getter form lets `remote_enable` flip bearer on
 * at runtime without restarting the gateway.
 */
export type AuthSource = AuthOptions | (() => AuthOptions)

export interface RuntimeHttpServerOptions {
  port: number
  bind?: string
  auth?: AuthSource
  /**
   * Per-request McpServer factory.
   *
   * The SDK's `StreamableHTTPServerTransport` is single-use — once a
   * transport has handled one request, the underlying `Protocol`
   * cannot be reattached, so subsequent requests on a shared transport
   * 500. The official stateless pattern (see SDK
   * `examples/server/simpleStatelessStreamableHttp.js`) builds a
   * fresh `McpServer` and `StreamableHTTPServerTransport` per request,
   * connects them, and tears both down on `res.close`. We follow that.
   *
   * The factory is invoked once per `/mcp` POST. It must register
   * tools / resources / prompts on the returned server before
   * resolving — by the time the transport's `handleRequest` fires,
   * the server is locked in.
   *
   * `denyTools`, when non-empty, is parsed from the request's
   * `?denyTools=a,b` query string (see `handleMcp` below) and is the
   * spawn-role-profiles tool gate for THIS surface: the hermes-default
   * `mcpServers` entry injected for an executor-role child (see
   * `session-spawn.ts`) carries this query param so the resulting
   * server excludes `agent_start`/`agent_prompt` while keeping every
   * other tool (fs, command_execute, …) — unlike the orchestrator's
   * curated allowlist, this surface can't just narrow to a small
   * subset without breaking the child's ability to do real work.
   *
   * `callerSessionId`, when present, is parsed from the request's
   * `?callerSessionId=<id>` query string (see `handleMcp` below) — the
   * same hermes-default `mcpServers` entry carries it (PR 7 / Gap 7)
   * so a `command_execute` call made through THIS one-shot server can
   * be attributed to the session that made it (see `command-tools.ts`'s
   * `RegisterCommandToolsOptions.callerSessionId`).
   */
  /**
   * `origin`, when present, is parsed from the request's `?origin=<label>`
   * query string (#session-visibility) — the connecting client's source label
   * (cowork/vscode/codex/cron). It becomes the DEFAULT origin for a spawn made
   * through this one-shot server when the tool input doesn't carry its own,
   * so a bridge client's spawn is attributed to its channel instead of landing
   * as a bare top-level root.
   */
  mcpServerFactory: (
    denyTools?: ReadonlySet<string>,
    callerSessionId?: string,
    origin?: string,
  ) => Promise<McpServer>
  /**
   * Optional scoped orchestrator sub-gateway (WP2). When BOTH this and
   * `verifyOrchestratorScope` are wired, the server mounts a second MCP
   * endpoint at `/mcp/orchestrator` that — unlike `/mcp` — has NO
   * loopback auth bypass: every request must present a valid scope-token
   * (`?scope=<token>` query or `X-Orchestrator-Scope` header). The token
   * resolves to a scope, and the factory builds a server exposing only
   * that scope's curated tool subset. This is what makes it safe to
   * point a child agent at the daemon (WP3 auto-injects the URL).
   */
  orchestratorMcpServerFactory?: OrchestratorMcpServerFactory
  /** Resolve a presented scope-token to its scope, or null when
   *  unknown/missing. Paired with `orchestratorMcpServerFactory`. */
  verifyOrchestratorScope?: (
    token: string | null | undefined,
  ) => OrchestratorScope | null
  conversations: ConversationStore
  events: RuntimeEvents
  heartbeat: HeartbeatRunner
  /** Optional — when wired, exposes /sessions routes for the CLI
   *  TUI and the guilde-web Active tab to navigate live child
   *  processes. Daemons that don't spawn anything (pure MCP servers)
   *  can omit this and the routes 404. */
  sessions?: SessionsRegistry
  /** Optional — when wired alongside `sessions`, enables
   *  `POST /sessions/agent` and `POST /sessions/:id/prompt` routes.
   *  Hosts that ship adapters (`agentproto serve`, playground)
   *  pass the cli's `resolveAdapter` via a thin shim. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional — mirrors `RegisterAgentToolsOptions.buildOrchestratorMcp`
   *  (agent-tools.ts). When wired, `POST /sessions/agent`'s
   *  `orchestrator` field mints a scoped sub-gateway token the same way
   *  the MCP `agent_start` tool does. Omitted → `orchestrator` on the
   *  HTTP route is rejected with a 501. */
  buildOrchestratorMcp?: BuildOrchestratorMcp
  /** Optional — mirrors `RegisterAgentToolsOptions.daemonMcpUrl`. When
   *  wired, a `POST /sessions/agent` spawn for a `hermes` adapter with
   *  no caller-supplied `mcpServers` defaults to mounting this gateway
   *  (same hermes safety net as the MCP tool). */
  daemonMcpUrl?: string
  /** Optional — mirrors `RegisterAgentToolsOptions.resolveSandboxProvider`
   *  (session-spawn.ts). When wired, `POST /sessions/agent`'s `sandbox`
   *  field can boot or reconnect a sandbox session, exactly as the MCP
   *  `agent_start` tool does (both share `spawnAgentSession`). Omitted →
   *  a sandbox spawn fails with `sandbox_provider_not_found`. */
  resolveSandboxProvider?: SpawnAgentSessionDeps["resolveSandboxProvider"]
  /** Optional — mirrors `RegisterAgentToolsOptions.provisionWorktree`. When
   *  wired, a `POST /sessions/agent` spawn honours `agent_start.worktree` and
   *  the daemon's `worktrees.isolation` policy, exactly as the MCP tool does
   *  (both share `spawnAgentSession`). Omitted → a spawn the policy says to
   *  isolate is rejected with `worktree_provisioner_not_enabled`. */
  provisionWorktree?: WorktreeProvisioner
  /** Optional — when wired, enables `GET /adapters` route + the
   *  MCP `adapter_list` tool so UIs can discover what's installed
   *  without trial-and-error against the resolver. Hosts ship the
   *  cli's `listInstalledAdapters` via a thin shim. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional — when wired, enables the MCP `harness_capabilities` tool so
   *  callers can introspect what each installed adapter can actually DO on
   *  this host (creds present, reachable providers, model-discovery
   *  mechanism, endpoint compat, application contract) instead of only its
   *  static manifest fields. Hosts ship the cli's lister built over
   *  `resolveAdapter` + `discoverCapabilities`. */
  listHarnessCapabilities?: AdapterCapabilitiesLister
  /** Optional — when wired, enables `POST /adapters/:slug/install` + the
   *  MCP `adapter_install` tool so UIs can install a not-yet-installed
   *  harness (both acp-catalog `npm i -g` CLIs and first-party workspace
   *  adapters). Hosts ship the cli's `installAdapter`. */
  installAgentAdapter?: AgentAdapterInstaller
  /** Optional — when wired, enables `GET /catalog/models` (read-only,
   *  no session) + the `catalog_models` MCP tool (SPEC §5). Hosts ship a
   *  shim over `buildCatalogModels` (`catalog-models.ts`). */
  listCatalogModels?: CatalogModelsLister
  /** Optional — when wired alongside `sessions`, enables
   *  `POST /sessions/browser` (same operation as MCP `start_browser`,
   *  exposed as an HTTP route for the CLI surface). */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Optional — passed to error messages on `POST /sessions/browser`
   *  to list available adapter ids when the requested one isn't found. */
  listBrowserAdapters?: BrowserAdapterLister
  /** Optional — MCP proxy registry. When wired, exposes
   *  `/mcps/proxy/*` routes that let the browser drive imported MCPs
   *  without going through the MCP wire protocol (useful for the
   *  /providers/mcp page's "Local" tab). */
  mcpProxy?: McpProxyRegistry
  /** Per-boot bearer token. When set, mutating /sessions/* routes
   *  + the /sessions/:id/pty WebSocket upgrade require either
   *  `Authorization: Bearer <token>` or an `Origin` header that
   *  matches `allowedOrigins`. Read-only routes (GET, SSE stream)
   *  stay open since the CORS surface already restricts origins
   *  enough for them. */
  token?: string
  /** Trusted browser origins. When a mutating request carries an
   *  `Origin: <url>` header (browser-set, JS can't forge), and that
   *  url is in this list, the request is allowed without a Bearer
   *  token. Browsers can't read the daemon's runtime.json (mode 0600)
   *  so they can't send the token — Origin-based auth lets a trusted
   *  page (Guilde web UI, local dev) drive the daemon. Non-browser
   *  callers (curl, the CLI) still use the token.
   *
   *  Match policy: exact origin (`https://guilde.work`) OR prefix
   *  with `:*` for any-port match (`http://localhost:*` matches
   *  `http://localhost:3000`).
   *
   *  Default (when undefined): localhost on any port is allowed via
   *  `DEFAULT_ALLOWED_ORIGINS`. Production origins are opt-in via
   *  `agentproto serve --allow-origin <url>`. Pair with `strictOrigins`
   *  to remove the localhost defaults entirely. */
  allowedOrigins?: readonly string[]
  /** When true, skip the localhost-wildcard defaults — only the
   *  explicit `allowedOrigins` list is honoured. Useful for daemons
   *  on shared hosts or when the user wants to lock dev to a
   *  specific port. Default false (current behaviour — any browser
   *  on `localhost` is trusted). */
  strictOrigins?: boolean
  /** Whether `POST /sessions/terminal` + WS upgrade are advertised.
   *  Reflects whether the host injected a PTY factory into the
   *  SessionsRegistry. When false, the terminal HTTP route returns
   *  501 and the WS upgrade rejects. */
  ptyEnabled?: boolean
  /** Optional — mirrors `RegisterSessionToolsOptions.listWorktreeStatuses`.
   *  When wired, enables `GET /worktrees` + the `worktree_status` MCP tool.
   *  Injected because the join lives in `@agentproto/worktree`, a dependency
   *  the runtime deliberately does NOT take. */
  listWorktreeStatuses?: WorktreeStatusLister
  /** Optional — mirrors `RegisterSessionToolsOptions.runWorktreeGc`. When
   *  wired, enables `POST /worktrees/gc` + the `worktree_gc` MCP tool.
   *  Injected because the plan/apply engine lives in `@agentproto/worktree`,
   *  a dependency the runtime deliberately does NOT take. */
  runWorktreeGc?: WorktreeGcRunner
  /** Optional — when wired, exposes /tunnels/* routes for creating and
   *  managing public tunnels for local ports. Without it the routes 404. */
  tunnels?: TunnelRegistry
  /** Optional — when wired, exposes /pairings/* routes for minting offers,
   *  listing pairings, and revoking them (E2E daemon pairing). Same service the
   *  MCP `pair_offer` / `pair_list` / `pair_revoke` tools call. Without it the
   *  routes 404. */
  pairings?: PairingRegistry
  /** Optional — the session lifecycle event bus. When wired alongside
   *  `sessions`, `eventRing`, enables `GET /sessions/:id/wait` (a blocking
   *  long-poll that resolves when the session fires a lifecycle event).
   *  Same machinery the MCP `session_monitor` tool uses. */
  sessionEvents?: SessionEventBus
  /** Optional — the cursor ring buffer over `sessionEvents`. Paired with
   *  `sessionEvents` to enable `GET /sessions/:id/wait` (cursor-based
   *  race-free replay via the `since` query param). */
  eventRing?: EventRing
  /** Optional — the completion-policy supervisor. When wired, enables
   *  `GET /policies/:id/wait` (a blocking long-poll that resolves when the
   *  policy leaves watching/gating → done/blocked/awaiting-ack/cancelled).
   *  Same state the MCP `policy_status` tool reports. */
  supervisor?: CompletionPolicySupervisor
  /** Optional — the Activity ledger projector (`activities.ts`). When
   *  wired, enables `GET /activities` — the unified active/pending
   *  read-model over policies, turns, routine/workflow steps, and opened
   *  PRs — plus `GET /activities/:id/wait` (a blocking long-poll that
   *  resolves when that record next announces a change, or immediately
   *  when it is already terminal). Same projector the MCP
   *  `activities_list` tool reads. Without it the routes 501. */
  activityProjector?: ActivityProjector
  /** Optional — the Task ledger (`task-ledger.ts`). When wired, enables
   *  the `/tasks` routes (GET/POST /tasks, GET/PATCH /tasks/:id) — the
   *  human-UI write path onto the same ledger the MCP `task_*` tools
   *  mutate. HTTP callers are OPERATOR context (like the /policies
   *  routes, which carry no per-caller scope either — the subtree-scoped
   *  surface is the `/mcp/orchestrator` gateway). Without it the routes
   *  404. */
  taskLedger?: TaskLedger
  /** Optional — when wired, exposes /cron routes for creating and
   *  managing durable cron jobs. Without it the routes 404. */
  cronScheduler?: import("./cron-scheduler.js").CronScheduler
  /** Optional — when wired, exposes `POST /routine-defs/:id/trigger` — fires
   *  an AIP-41 `.routines/<id>/ROUTINE.md` routine's target immediately,
   *  bypassing its schedule (mirrors `POST /cron/:id/run`) — and
   *  `POST /routine-defs/reconcile`, which re-scans `.routines/*` and
   *  registers/updates/removes live cron jobs to match (the same pass
   *  `index.ts` runs once at boot, callable on demand so a routine dropped
   *  after boot schedules without a daemon restart). Also backs
   *  `GET /routines` (routine DEFINITIONS). Without it `/routine-defs/*`
   *  404s and `GET /routines` 404s. */
  routineRegistrar?: import("./routine-registrar.js").RoutineRegistrar
  /** Optional — when wired, exposes /workflows/* routes for starting and
   *  managing background workflow runs (stage-barrier parallel steps).
   *  Same service the MCP `workflow_start/status/cancel/
   *  escalation_resolve/list` tools call. Without it the routes 404. */
  workflowRunner?: WorkflowRunner
  /** Optional — when wired, exposes /apps/:appId/apply, DELETE /apps/:appId/apply,
   *  and GET /scopes/:scopeId/apps routes for applying apps to scopes. Same
   *  service the MCP `app_apply/app_unapply/app_list_applied` tools use. */
  appRegistry?: AppRegistry
  /** Optional — mirrors the install logic from app-tools.ts, threaded through
   *  so both the MCP verb and the HTTP route can call it. Required when
   *  `appRegistry` is wired. */
  performAppInstall?: (
    dir: string,
    appRegistry: AppRegistry,
    listRegisteredToolIds: () => Promise<string[]>,
    resolveAgentAdapter?: AgentAdapterResolver,
    opts?: { dataDir?: string },
  ) => Promise<{ ok: true; record: any } | { ok: false; error: string }>
  /** Optional — required when `appRegistry` is wired, for tool validation during install. */
  listRegisteredToolIds?: () => Promise<string[]>
  /** Optional — when wired alongside `appRegistry`, backs the standalone app
   *  host routes: `GET /apps/:appId/ui` (an installed app's html with a REST
   *  `window.McpApp` bridge injected, so the same UI runs in a plain browser
   *  tab) and `POST /apps/:appId/tool-call` (the REST twin of the MCP
   *  `app_tool_call` gateway — same `ui.tools` allowlist, same dispatch
   *  chain, via `performAppToolCall`). `dispatchTool`/`callImportedTool` are
   *  the same functions index.ts hands `registerAppTools`; omitted ⇒
   *  tool-call dispatch reports "not enabled", the UI route still serves. */
  appToolCallDeps?: AppToolCallDeps
  /** Optional — when wired, enables `POST /inbound`, the push-ingress
   *  counterpart to `inbound-watcher.ts`'s poll loop. A human reply
   *  (e.g. from agentpush's Telegram webhook) routes into the session
   *  bound to its `contact_ref`, or spawns a fresh one — same helper
   *  `inbound-watcher.ts` uses for polled messages. Without it the
   *  route 501s. */
  routeInboundMessage?: (
    msg: InboundMessage,
    mode: InboundRouteMode,
  ) => Promise<{
    action: "routed" | "spawned" | "restarted-routed" | "skipped"
    sessionId?: string
  }>
  /** Optional — when wired alongside `routeInboundMessage`, enables provider-agnostic
   *  `POST /inbound/:slug` endpoints with per-slug signature verification. Without it,
   *  only the legacy `POST /inbound` bearer-gated native route is available. */
  endpointStore?: InboundEndpointStore
  /** Static fields surfaced via `/health`. */
  meta: {
    workspace: string
    registered: readonly string[]
    /** Daemon start timestamp. Defaults to `Date.now()` at server start. */
    startedAt?: number
    /** Daemon build version (the CLI's `__CLI_VERSION__` when served by
     *  `agentproto serve`). Surfaced via `/health` so lifecycle tooling can
     *  report what is actually RUNNING, not what is installed on disk. */
    version?: string
    /** Build identity of the binary actually serving — sha + builtAt are
     *  stamped into the CLI at build time, `source` is the serve command's
     *  runtime judgement ("workspace" | "published" | "unknown"). Version
     *  alone can't distinguish a workspace dist from the published tarball
     *  of the same release; this can. */
    build?: { sha?: string; builtAt?: string; source?: string }
    /** Effective `daemon.resumeSessionsOnBoot` knob (§5, PR-4). Kept in sync
     *  with the `daemon_health` MCP tool's field of the same name. */
    resumeSessionsOnBoot?: boolean
    /** Effective `daemon.idleReapAfterMs` knob (PR-6) — idle threshold (ms)
     *  before the reaper retires an idle agent-cli session, or 0 when off. Kept
     *  in sync with the `daemon_health` MCP tool's field of the same name. */
    idleReapAfterMs?: number
    /** Effective `daemon.crashDetectIntervalMs` knob (crash-detect PR-1) — the
     *  sweep interval (ms) the crash-detect pass runs on; DEFAULT ON (a sane
     *  default applies even when unset), 0 only when explicitly disabled. Kept
     *  in sync with the `daemon_health` MCP tool's field of the same name. */
    crashDetectIntervalMs?: number
    /** Effective `daemon.restartSweepIntervalMs` knob (restart-scheduler
     *  PR-2) — the sweep cadence (ms) that executes an already-scheduled
     *  restart, or 0 when off. Kept in sync with the `daemon_health` MCP
     *  tool's field of the same name. */
    restartSweepIntervalMs?: number
    /** Effective `daemon.turnStallAfterMs` knob (turn-liveness-watchdog
     *  chantier) — the silence threshold (ms) past which a busy, unblocked
     *  agent-cli session's turn is flagged stalled; DEFAULT ON (a sane
     *  default applies even when unset), 0 only when explicitly disabled.
     *  Kept in sync with the `daemon_health` MCP tool's field of the same
     *  name. */
    turnStallAfterMs?: number
  }
}

export interface RuntimeHttpServerHandle {
  url: string
  stop(): Promise<void>
}

export async function startHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const startedAt = opts.meta.startedAt ?? Date.now()
  const authSource: AuthSource = opts.auth ?? { mode: "none" }
  const readAuth = (): AuthOptions =>
    typeof authSource === "function" ? authSource() : authSource

  /**
   * Loopback bypass — requests originating from 127.0.0.1 / ::1 with
   * no `X-Forwarded-For` header skip the bearer check even when one is
   * configured. Rationale:
   *
   *   1. The bearer is meant to gate the *public tunnel*, not the
   *      loopback socket. Without this, calling `remote_enable` from a
   *      local MCP client immediately 401s that same local client —
   *      the user locks themselves out and the only recovery is a
   *      gateway restart. Hit this in real use; not a theoretical edge.
   *
   *   2. Cloudflared (and any reasonable tunnel) sets X-Forwarded-For
   *      when forwarding a public request to the loopback origin. So
   *      "loopback AND no XFF" is a tight characterisation of "this
   *      request never left the machine."
   *
   *   3. Local FS access already trumps bearer (the user can read
   *      runtime.json, kill -9 the daemon, etc.). Adding another check
   *      here doesn't raise the bar for someone with shell on the box.
   *
   * If your threat model is "untrusted users on the same loopback
   * interface" (unusual — usually a multi-tenant container scenario),
   * pass `auth: { mode: "bearer", … }` at startup instead of relying
   * on the controller's runtime flip; the auth getter will return the
   * stricter of the two and the bypass still applies (intentional —
   * the operator opted in to bearer with full knowledge of the trade).
   */
  function isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? ""
    const isLocalAddr =
      addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
    if (!isLocalAddr) return false
    // Any forwarding/proxy header ⇒ a tunnel or reverse proxy is in front
    // of us; the request crossed a network boundary to reach this loopback
    // socket, so it must NOT inherit the loopback auth bypass. Checking the
    // whole header family (not just X-Forwarded-For) closes the gap where a
    // proxy strips XFF but still sets X-Real-IP / Forwarded / CF-* — a lone
    // XFF check would wave those straight through.
    for (const h of PROXY_FORWARDING_HEADERS) {
      if (req.headers[h] !== undefined) return false
    }
    return true
  }

  /**
   * Loopback `Host` values this daemon answers to. A DNS-rebinding page points
   * `evil.com` at `127.0.0.1` and fetches it — but the browser still sends the
   * page's own hostname in `Host` (`evil.com:<port>`), which is not in this
   * set. The port is always present (the daemon runs on a non-default port).
   */
  const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    `[::1]:${opts.port}`,
  ])

  /**
   * DNS-rebinding defense. A request that reached us on the loopback socket
   * must carry a loopback `Host`; a rebinding page's request carries its own
   * hostname instead → refused. This complements the Origin guards
   * (`authorizeMcp`/`guardBrowserOrigin`): those stop the browser drive-by,
   * this stops the non-browser / rebinding vector. Skipped for forwarded/
   * tunnel traffic — that carries a dynamic public `Host` we can't enumerate
   * and is gated by the bearer token instead.
   */
  function validateHost(req: IncomingMessage): boolean {
    if (!isLoopback(req)) return true
    const host = (req.headers.host ?? "").toLowerCase()
    return LOOPBACK_HOSTS.has(host)
  }

  function authorize(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = readAuth()
    if (auth.mode === "none") return true
    if (isLoopback(req)) return true
    const header = req.headers.authorization
    const expected = `Bearer ${auth.token}`
    if (header !== expected) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return false
    }
    return true
  }

  /**
   * Auth gate for `/mcp`. Unlike `authorize()`, it does NOT let a browser
   * drive-by inherit the loopback bypass: `/mcp` registers `command_execute`,
   * `file_read`/`file_write`, `agent_start`, … (see index.ts's
   * `mcpServerFactory`), so a malicious web page that `fetch()`es
   * `http://127.0.0.1:<port>/mcp` must be refused even though it rides the
   * loopback socket. This is the CVE-2026-22812 class hole the `/sessions/*`
   * routes already close via `checkSessionsToken`.
   *
   * The distinguishing signal is the `Origin` header: a browser ALWAYS sets
   * it on a cross-origin `fetch`/POST and cannot forge it to a trusted value;
   * native MCP clients (the CLI, Claude Desktop's HTTP bridge, curl) send
   * none. So:
   *
   *   - `Origin` present AND not allowlisted → require a valid bearer token
   *     (which a browser can't read from runtime.json, mode 0600). No
   *     loopback bypass. Missing/invalid ⇒ 403. This branch is what blocks
   *     the drive-by that `authorize()` would otherwise wave through.
   *   - `Origin` absent, or an allowlisted Origin (localhost dev origins,
   *     the hosted panel) → fall through to `authorize()`, so today's
   *     native-local-client path and trusted browser pages keep working
   *     unchanged.
   */
  function authorizeMcp(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin
    if (
      typeof origin === "string" &&
      origin.length > 0 &&
      !originAllowed(origin)
    ) {
      const auth = readAuth()
      const header = req.headers.authorization
      if (auth.mode === "bearer" && header === `Bearer ${auth.token}`) {
        return true
      }
      res.writeHead(403, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "mcp_forbidden_origin",
          message:
            "Cross-origin browser requests to /mcp are refused. This " +
            "endpoint exposes shell + filesystem tools; a web page cannot " +
            "drive it. Add the origin to the daemon's allowlist " +
            "(`agentproto config set daemon.allowedOrigins <url>`) or present " +
            "the bearer token from <workspace>/.agentproto/runtime.json.",
        }),
      )
      return false
    }
    return authorize(req, res)
  }

  /**
   * Per-boot auth gate for mutating /sessions/* routes and the WS
   * upgrade for /sessions/:id/pty. Accepts EITHER:
   *
   *   1. `Authorization: Bearer <token>` matching the per-boot token
   *      (the CLI path — reads runtime.json mode 0600).
   *   2. A WS-upgrade query-string `?token=<token>` (browser
   *      WebSocket can't set headers; some non-browser clients use
   *      this too).
   *   3. An `Origin: <url>` header matching `allowedOrigins` — the
   *      browser path. Origin is browser-set, JS can't forge.
   *
   * UNLIKE `authorize()`, this does NOT have a loopback bypass: the
   * threat we're defending against (browser drive-by spawning shells
   * via fetch to 127.0.0.1) IS loopback. Browsers can't read
   * runtime.json (mode 0600); a same-origin trusted page can rely on
   * its Origin instead.
   *
   * When `opts.token` is unset (older host integrations), this is a
   * no-op so existing call sites keep working.
   */
  function checkSessionsToken(req: IncomingMessage): "ok" | "missing" | "bad" {
    if (!opts.token) return "ok"

    // 1. Header bearer token.
    const header = req.headers.authorization
    const expected = `Bearer ${opts.token}`
    if (header === expected) return "ok"

    // 2. ?token=<token> in the URL (WS upgrade convenience).
    const urlStr = req.url ?? ""
    if (urlStr.includes("?")) {
      const qs = new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1))
      const qsToken = qs.get("token")
      if (qsToken && qsToken === opts.token) return "ok"
    }

    // 3. Origin allowlist (browser path).
    const origin = req.headers.origin
    if (typeof origin === "string" && originAllowed(origin)) return "ok"

    return header ? "bad" : "missing"
  }

  function originAllowed(origin: string): boolean {
    // Defaults are normally in effect — `opts.allowedOrigins` extends
    // them rather than replacing. Otherwise setting one production
    // origin via config silently locks out `http://localhost:*`,
    // breaking local dev. Users who genuinely want a curated list
    // (shared host, paranoid local-only ports) set `strictOrigins:true`
    // which drops the defaults entirely.
    const list = opts.strictOrigins
      ? (opts.allowedOrigins ?? [])
      : [...DEFAULT_ALLOWED_ORIGINS, ...(opts.allowedOrigins ?? [])]
    for (const pattern of list) {
      if (pattern === origin) return true
      // `http://localhost:*` style: match the host prefix, any port.
      if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -2) // drop ":*"
        if (origin === prefix || origin.startsWith(prefix + ":")) return true
      }
    }
    return false
  }

  function rejectUnauthorizedSession(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "missing" | "bad",
  ): void {
    const origin = req.headers.origin ?? null
    const allowList = opts.strictOrigins
      ? (opts.allowedOrigins ?? [])
      : [...DEFAULT_ALLOWED_ORIGINS, ...(opts.allowedOrigins ?? [])]
    res.writeHead(401, { "content-type": "application/json" })
    const message =
      kind === "missing"
        ? origin
          ? `Origin "${origin}" not in the daemon's allowlist, and no Bearer token sent. ` +
            `Either add it (\`agentproto config set daemon.allowedOrigins ${origin}\` then restart the daemon), ` +
            `or send Authorization: Bearer <token> read from <workspace>/.agentproto/runtime.json.`
          : `Authorization: Bearer <token> required on mutating /sessions/* routes. ` +
            `Read the token from <workspace>/.agentproto/runtime.json. ` +
            `(Browser callers can use an Origin in the allowlist instead.)`
        : `Invalid bearer token. The daemon regenerated its token on its last boot — ` +
          `re-read <workspace>/.agentproto/runtime.json.`
    res.end(
      JSON.stringify({
        error: "sessions_unauthorized",
        message,
        // Debug data so a UI / network-tab inspection points the user
        // straight at the fix without needing the daemon's stderr.
        rejectedOrigin: origin,
        allowedOrigins: allowList,
        // We never echo the token; only the absence-or-presence flag.
        receivedAuthHeader: typeof req.headers.authorization === "string",
      }),
    )
  }

  /**
   * Returns true when this `path` + `method` is a mutating /sessions/*
   * route that should require the per-boot token. Kept narrow: GETs
   * (list, get, SSE stream) stay open for read-only telemetry from
   * existing tools that haven't learned about the token yet.
   */
  function isMutatingSessionsRoute(method: string, path: string): boolean {
    if (!path.startsWith("/sessions")) return false
    if (method === "POST" || method === "DELETE" || method === "PUT" || method === "PATCH") {
      return true
    }
    return false
  }

  // stderr is a launchd-redirected regular file, so every console.error is
  // a SYNCHRONOUS disk write on the event loop. An ungated line per failed
  // probe (clients retry precisely when they're already failing) is both a
  // log flood and a genuine stall risk under ~dozens of concurrent
  // sessions — first failure logs immediately, then ≤1 line/min with a
  // suppressed count.
  const mcpErrorLogGate = createReconnectLogGate()

  /**
   * Drive one MCP request over a fresh server+transport pair, per the
   * SDK's stateless pattern. Sharing either across requests breaks after
   * the first one because `Protocol.connect` rejects re-attachment.
   * Shared by `/mcp` and the scoped `/mcp/orchestrator` endpoint.
   */
  async function serveMcp(
    req: IncomingMessage,
    res: ServerResponse,
    server: McpServer,
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    // `onerror` is an unofficial SDK hook — guard before assigning so
    // a future SDK rename doesn't silently drop transport error logs.
    const transportInternal = transport as unknown as Record<string, unknown>
    if ("onerror" in (transport as object)) {
      transportInternal["onerror"] = (err: unknown) => {
        const line = mcpErrorLogGate.onFailure(
          "mcp:transport.onerror",
          `[mcp transport.onerror] ${err instanceof Error ? err.message : String(err)}`,
        )
        if (line) console.error(line)
      }
    }

    res.on("close", () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      const line = mcpErrorLogGate.onFailure(
        "mcp:handleRequest",
        `[mcp] handleRequest threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      )
      if (line) console.error(line)
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "mcp_transport_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
  }

  function parseDenyToolsQuery(url: string): Set<string> | undefined {
    const qIdx = url.indexOf("?")
    if (qIdx === -1) return undefined
    const raw = new URLSearchParams(url.slice(qIdx + 1)).get("denyTools")
    if (!raw) return undefined
    const names = raw.split(",").map(s => s.trim()).filter(Boolean)
    return names.length > 0 ? new Set(names) : undefined
  }

  /** Mirrors `parseDenyToolsQuery` for the `callerSessionId` query param
   *  (PR 7 / Gap 7) — see `mcpServerFactory`'s doc for the wire contract. */
  function parseCallerSessionIdQuery(url: string): string | undefined {
    const qIdx = url.indexOf("?")
    if (qIdx === -1) return undefined
    const raw = new URLSearchParams(url.slice(qIdx + 1)).get("callerSessionId")
    return raw && raw.length > 0 ? raw : undefined
  }

  /** Mirrors `parseCallerSessionIdQuery` for the `origin` query param
   *  (#session-visibility) — the connecting client's source label
   *  (cowork/vscode/codex/cron). A non-session bridge client that omits a
   *  `?callerSessionId=` still names itself here, so a spawn it makes is
   *  stamped with an origin instead of landing as a bare root. See
   *  `mcpServerFactory`'s doc for the wire contract. */
  function parseOriginQuery(url: string): string | undefined {
    const qIdx = url.indexOf("?")
    if (qIdx === -1) return undefined
    const raw = new URLSearchParams(url.slice(qIdx + 1)).get("origin")
    return raw && raw.length > 0 ? raw : undefined
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorizeMcp(req, res)) return
    const denyTools = parseDenyToolsQuery(req.url ?? "")
    const callerSessionId = parseCallerSessionIdQuery(req.url ?? "")
    const origin = parseOriginQuery(req.url ?? "")
    const server = await opts.mcpServerFactory(denyTools, callerSessionId, origin)
    await serveMcp(req, res, server)
  }

  /**
   * Scoped orchestrator sub-gateway (WP2). Mounted at
   * `/mcp/orchestrator`. CRITICALLY this does NOT call `authorize()`:
   * the loopback bypass that makes `/mcp` open to any local process is
   * exactly what we must not inherit here — a child gets the
   * orchestration subset ONLY by presenting a valid scope-token. The
   * token arrives via `?scope=<token>` (the injected URL form) or the
   * `X-Orchestrator-Scope` header.
   */
  async function handleOrchestratorMcp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!opts.orchestratorMcpServerFactory || !opts.verifyOrchestratorScope) {
      res.writeHead(501, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "orchestrator_gateway_not_configured",
          message:
            "The daemon was started without the scoped orchestrator " +
            "sub-gateway. Wire `orchestratorMcpServerFactory` + " +
            "`verifyOrchestratorScope` in createGateway.",
        }),
      )
      return
    }
    const urlStr = req.url ?? ""
    let token: string | null = null
    if (urlStr.includes("?")) {
      token = new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1)).get(
        "scope",
      )
    }
    if (!token) {
      const headerTok = req.headers["x-orchestrator-scope"]
      if (typeof headerTok === "string") token = headerTok
    }
    const scope = opts.verifyOrchestratorScope(token)
    if (!scope) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "orchestrator_scope_required",
          message:
            "A valid scope-token is required on /mcp/orchestrator " +
            "(pass `?scope=<token>` or the `X-Orchestrator-Scope` header). " +
            "Unlike /mcp, this endpoint has no loopback bypass.",
        }),
      )
      return
    }
    const server = await opts.orchestratorMcpServerFactory(scope)
    await serveMcp(req, res, server)
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        status: "ok",
        workspace: opts.meta.workspace,
        registered: opts.meta.registered,
        uptimeMs: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
        // What is actually running — version, process, and the exact
        // node+entry pair launchd (or the shell) exec'd. Lifecycle tooling
        // (`agentproto daemon start/stop/status`) reports these.
        version: opts.meta.version ?? null,
        build: opts.meta.build ?? null,
        pid: process.pid,
        node: process.execPath,
        entry: process.argv[1] ?? null,
        resumeSessionsOnBoot: opts.meta.resumeSessionsOnBoot === true,
        idleReapAfterMs: opts.meta.idleReapAfterMs ?? 0,
        crashDetectIntervalMs: opts.meta.crashDetectIntervalMs ?? 0,
        restartSweepIntervalMs: opts.meta.restartSweepIntervalMs ?? 0,
        turnStallAfterMs: opts.meta.turnStallAfterMs ?? 0,
      }),
    )
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    if (guardBrowserOrigin(req, res)) return
    if (!authorize(req, res)) return
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    res.write(`: connected\n\n`)
    const off = opts.events.onAny((ev: RuntimeEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    })
    req.on("close", off)
  }

  async function handleListConversations(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (guardBrowserOrigin(req, res)) return
    if (!authorize(req, res)) return
    const list = await opts.conversations.list()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(list))
  }

  async function handleGetConversation(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    if (guardBrowserOrigin(req, res)) return
    if (!authorize(req, res)) return
    try {
      const data = await opts.conversations.read(id)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(data))
    } catch (err) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "not_found",
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  async function handleHeartbeatTick(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!authorize(req, res)) return
    await opts.heartbeat.fireNow()
    res.writeHead(202, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "fired" }))
  }

  /**
   * POST /files/upload?cwd=<abs-dir>&name=<filename>
   *
   * Writes the raw request body bytes to
   * `{cwd}/.agentproto-attachments/{safe-name}`, creating the
   * subdirectory on demand, and returns `{path}` with the absolute
   * path the agent CLI can read. Used by the host UI's terminal
   * drag-drop: the browser can't read the dragged file's source path
   * (security), so we copy the bytes to a known location and tell the
   * UI to paste THAT path into the terminal — claude-code (and any
   * CLI with a Read tool) picks it up natively.
   *
   * Gated by `checkSessionsToken` so a drive-by HTTP request can't
   * write arbitrary files: only sessions-authorized callers (CLI or
   * an allow-listed browser origin) can hit it.
   *
   * Hardening:
   *   - `cwd` must be absolute and exist as a directory.
   *   - `name` is basename-sanitized (no `/`, `..`, NULs).
   *   - The resolved write target must stay within
   *     `{cwd}/.agentproto-attachments/` (defense-in-depth in case the
   *     name sanitizer ever drifts).
   *   - Body capped at 32 MiB. Larger uploads error 413 instead of
   *     filling the daemon's disk.
   */
  async function handleFileUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "")
    const cwd = qs.get("cwd")
    const rawName = qs.get("name")
    if (!cwd || !rawName) {
      reply(400, { error: "missing_cwd_or_name" })
      return
    }
    if (!isAbsolute(cwd)) {
      reply(400, { error: "cwd_not_absolute" })
      return
    }
    // basename-style sanitize: strip path separators + parent refs +
    // NUL bytes; collapse leading dots so the file is visible. The
    // resolvePath check below catches anything this misses.
    const safeName = rawName
      .replace(/[\x00/\\]/g, "_")
      .replace(/\.\.+/g, ".")
      .replace(/^\.+/, "")
      .slice(0, 200)
    if (safeName.length === 0) {
      reply(400, { error: "invalid_name" })
      return
    }
    try {
      const st = await stat(cwd)
      if (!st.isDirectory()) {
        reply(400, { error: "cwd_not_a_directory" })
        return
      }
    } catch {
      reply(400, { error: "cwd_not_found" })
      return
    }
    const dir = join(cwd, ".agentproto-attachments")
    const target = resolvePath(dir, safeName)
    // Defense-in-depth: the sanitized name should never escape `dir`,
    // but if the sanitizer ever drifts, this catches the escape.
    if (!target.startsWith(resolvePath(dir) + (dir.endsWith("/") ? "" : "/"))) {
      reply(400, { error: "path_traversal_blocked" })
      return
    }
    const MAX_BYTES = 32 * 1024 * 1024 // 32 MiB
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    await new Promise<void>((resolveBody, rejectBody) => {
      req.on("data", chunk => {
        if (aborted) return
        const buf = chunk as Buffer
        total += buf.length
        if (total > MAX_BYTES) {
          aborted = true
          reply(413, { error: "file_too_large", maxBytes: MAX_BYTES })
          rejectBody(new Error("too_large"))
          return
        }
        chunks.push(buf)
      })
      req.on("end", () => {
        if (!aborted) resolveBody()
      })
      req.on("error", err => rejectBody(err))
    }).catch(() => undefined)
    if (aborted) return
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(target, Buffer.concat(chunks))
      reply(200, { path: target, bytes: total })
    } catch (err) {
      reply(500, {
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Browser drive-by guard for Origin-sensitive READ routes that leak local
   * session state (`/conversations`, `/events`, `/workspaces`, `/worktrees`).
   * These are otherwise gated only by `authorize()` (loopback bypass) or not
   * at all, so — combined with CORS — a malicious page the user visits could
   * `fetch()` them cross-origin and read conversation transcripts, the live
   * event stream, and local workspace/worktree paths. Same threat and signal
   * as `authorizeMcp`: a browser ALWAYS sets `Origin` cross-origin and can't
   * forge it to a trusted value; native clients (CLI, curl) send none.
   *
   * Returns `true` when it has REJECTED the request (wrote a 403) — the caller
   * must stop. Returns `false` when the request may proceed to its normal
   * auth path (no Origin, an allowlisted Origin, or a valid bearer token).
   */
  function guardBrowserOrigin(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const origin = req.headers.origin
    if (
      typeof origin === "string" &&
      origin.length > 0 &&
      !originAllowed(origin)
    ) {
      const auth = readAuth()
      const header = req.headers.authorization
      if (auth.mode === "bearer" && header === `Bearer ${auth.token}`) {
        return false
      }
      res.writeHead(403, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "forbidden_origin",
          message:
            "Cross-origin browser access to this route is refused. It " +
            "exposes local session state (transcripts, events, workspace " +
            "paths); a web page cannot read it. Add the origin to the " +
            "daemon's allowlist or present the bearer token.",
        }),
      )
      return true
    }
    return false
  }

  // CORS for the loopback gateway. The Guilde web app (localhost:3041) and
  // the hosted panel probe /health + read-only routes from the browser;
  // without these headers the browser blocks the response. But a credentialed
  // response reflected back to an ARBITRARY origin lets an untrusted page read
  // it (data exfil) — so we only reflect + allow credentials for allowlisted
  // origins (localhost dev, cli.agentproto.sh). Everything else gets a bare
  // `*` with NO credentials: enough for a public /health probe, useless for
  // reading a credentialed/sensitive response (which the route gate also 403s).
  //
  // Private Network Access (Chrome 105+): an HTTPS page fetching a loopback
  // URL sends a preflight with `Access-Control-Request-Private-Network: true`.
  // We only grant `Access-Control-Allow-Private-Network` to allowlisted
  // origins — an untrusted page shouldn't be waved through the PNA gate.
  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    const trusted =
      typeof origin === "string" && origin.length > 0 && originAllowed(origin)
    if (trusted) {
      res.setHeader("Access-Control-Allow-Origin", origin as string)
      res.setHeader("Access-Control-Allow-Credentials", "true")
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*")
    }
    res.setHeader("Vary", "Origin")
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ??
        "authorization,content-type,mcp-session-id",
    )
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    )
    if (
      trusted &&
      req.headers["access-control-request-private-network"] === "true"
    ) {
      res.setHeader("Access-Control-Allow-Private-Network", "true")
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/"
        const path = url.split("?")[0] ?? "/"
        // Diagnostic: emit forwarded requests (those carrying XFF) onto
        // the events stream so /events tailers can see what cloudflared
        // actually sends. Loopback-only traffic stays quiet to avoid
        // flooding subscribers during normal local use.
        if (req.headers["x-forwarded-for"]) {
          // Redact the query string: it can carry secrets (`?token=`,
          // `?scope=`) that must not land in the event log / stderr.
          const loggedUrl = url.includes("?")
            ? url.slice(0, url.indexOf("?")) + "?<redacted>"
            : url
          opts.events.emit({
            type: "remote-log",
            at: new Date().toISOString(),
            line: `[http-in] ${req.method} ${loggedUrl} host=${req.headers.host ?? "?"} xff=${String(req.headers["x-forwarded-for"])}`,
          })
        }

        applyCors(req, res)
        if (req.method === "OPTIONS") {
          res.writeHead(204)
          res.end()
          return
        }

        // DNS-rebinding guard on the loopback path. /health is exempt — it's a
        // harmless public probe uptime monitors may hit via any hostname.
        if (path !== "/health" && !validateHost(req)) {
          res.writeHead(403, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: "forbidden_host",
              message:
                "Request rejected: a loopback request must use a loopback Host " +
                "(127.0.0.1/localhost). This blocks DNS-rebinding against the " +
                "local daemon.",
            }),
          )
          return
        }

        if (path === "/health" && req.method === "GET") {
          handleHealth(req, res)
          return
        }
        if (path === "/events" && req.method === "GET") {
          handleEvents(req, res)
          return
        }
        if (path === "/mcp/orchestrator") {
          await handleOrchestratorMcp(req, res)
          return
        }
        if (path === "/mcp") {
          await handleMcp(req, res)
          return
        }
        if (path === "/conversations" && req.method === "GET") {
          await handleListConversations(req, res)
          return
        }
        if (path.startsWith("/conversations/") && req.method === "GET") {
          const id = path.slice("/conversations/".length)
          await handleGetConversation(req, res, id)
          return
        }
        if (path === "/heartbeat/tick" && req.method === "POST") {
          await handleHeartbeatTick(req, res)
          return
        }

        if (path === "/files/upload" && req.method === "POST") {
          // Same auth gate as the mutating /sessions/* routes — drive-by
          // HTTP shouldn't be able to write arbitrary files to disk.
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          await handleFileUpload(req, res, url)
          return
        }

        if (path === "/inbound" && req.method === "POST") {
          // Legacy native path — bearer-gated, unchanged.
          await handleNativeInbound(req, res, { routeInboundMessage: opts.routeInboundMessage, endpointStore: opts.endpointStore, checkSessionsToken, rejectUnauthorizedSession })
          return
        }

        const inboundSlugMatch = path.match(/^\/inbound\/([^/]+)$/)
        if (inboundSlugMatch && req.method === "POST") {
          await handleProviderInbound(req, res, decodeURIComponent(inboundSlugMatch[1] ?? ""), { routeInboundMessage: opts.routeInboundMessage, endpointStore: opts.endpointStore, checkSessionsToken, rejectUnauthorizedSession })
          return
        }

// Sessions routes — only registered when the gateway was
        // built with a SessionsRegistry. /sessions, /sessions/:id,
        // /sessions/:id/stream (SSE), POST /sessions/:id/kill,
        // DELETE /sessions/:id (forget after exit).
        if (opts.sessions && path.startsWith("/sessions")) {
          if (isMutatingSessionsRoute(req.method ?? "GET", path)) {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handleSessions(
            req,
            res,
            path,
            opts.sessions,
            opts.resolveAgentAdapter,
            opts.ptyEnabled === true,
            opts.resolveBrowserAdapter,
            opts.listBrowserAdapters,
            opts.sessionEvents,
            opts.eventRing,
            opts.buildOrchestratorMcp,
            opts.daemonMcpUrl,
            opts.provisionWorktree,
            opts.listCatalogModels,
            opts.resolveSandboxProvider,
          )
          if (handled) return
        }

        if (path === "/workspaces" && req.method === "GET") {
          if (guardBrowserOrigin(req, res)) return
          // Surface ~/.agentproto/workspaces.json for UIs that
          // want a workspace dropdown (spawn dialog, MCP discovery
          // grouping, etc.). Read-only variant; mutation lives just
          // below (POST /workspaces, PUT /workspaces/active,
          // DELETE /workspaces/:slug) and via the CLI's
          // `agentproto workspace add/remove/use` verbs — both paths
          // go through the same pure helpers in workspaces-config.ts.
          try {
            const config = await loadWorkspacesConfig()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(config))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspaces_load_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        if (path === "/worktrees" && req.method === "GET") {
          if (guardBrowserOrigin(req, res)) return
          // Read-only worktree status surface — lists linked worktrees,
          // their live PR integration, and the sessions whose cwd sits in
          // each worktree. The heavy join is delegated to an injected lister
          // so the runtime stays free of `@agentproto/worktree`.
          if (!opts.listWorktreeStatuses) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "worktree_status_not_configured",
                message:
                  "GET /worktrees is not enabled — the daemon was started " +
                  "without a worktree status lister. The host must wire " +
                  "`listWorktreeStatuses` in createGateway.",
              })
            )
            return
          }
          const reqUrl = req.url ?? ""
          const queryString = reqUrl.includes("?")
            ? reqUrl.slice(reqUrl.indexOf("?") + 1)
            : ""
          const qs = new URLSearchParams(queryString)
          const repoRoot = qs.get("repoRoot") ?? undefined
          const workspaceSlug = qs.get("workspaceSlug") ?? undefined
          const openOnly =
            qs.get("openOnly") === "1" || qs.get("openOnly") === "true"
          const resolved = await resolveWorktreeQueryRoot({
            repoRoot: repoRoot ?? undefined,
            workspaceSlug: workspaceSlug ?? undefined,
          })
          if (!resolved.ok) {
            res.writeHead(resolved.status, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: resolved.error }))
            return
          }
          try {
            let worktrees = await opts.listWorktreeStatuses(resolved.repoRoot)
            if (openOnly) {
              worktrees = worktrees.filter(w => w.pr?.state === "open")
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ worktrees }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "worktree_status_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        if (path === "/worktrees/gc" && req.method === "POST") {
          if (guardBrowserOrigin(req, res)) return
          // Transport twin of `GET /worktrees`, over the `gc` engine
          // (`planGc` / `applyGc`). DEFAULTS TO A DRY RUN — `apply` must be
          // explicitly true to mutate. All classification + safety
          // (merge-gated reclaim, open-PR-is-hold, dirty-is-salvage-only)
          // lives in the injected runner's engine, untouched here.
          if (!opts.runWorktreeGc) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "worktree_gc_not_configured",
                message:
                  "POST /worktrees/gc is not enabled — the daemon was started " +
                  "without a worktree gc runner. The host must wire " +
                  "`runWorktreeGc` in createGateway.",
              })
            )
            return
          }
          const body = await readJsonBody(req)
          const obj: object =
            typeof body === "object" && body !== null ? body : {}
          const repoRoot =
            "repoRoot" in obj && typeof obj.repoRoot === "string"
              ? obj.repoRoot
              : undefined
          const workspaceSlug =
            "workspaceSlug" in obj && typeof obj.workspaceSlug === "string"
              ? obj.workspaceSlug
              : undefined
          // Accept a real JSON boolean or its "true"/"false" string form, so
          // the HTTP surface is as lenient as the MCP tool's `mcpBool`.
          const apply = "apply" in obj && (obj.apply === true || obj.apply === "true")
          const salvageDirty =
            "salvageDirty" in obj &&
            (obj.salvageDirty === true || obj.salvageDirty === "true")
          const includeDetached =
            "includeDetached" in obj &&
            (obj.includeDetached === true || obj.includeDetached === "true")
          const resolved = await resolveWorktreeQueryRoot({
            repoRoot,
            workspaceSlug,
          })
          if (!resolved.ok) {
            res.writeHead(resolved.status, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: resolved.error }))
            return
          }
          try {
            const result = await opts.runWorktreeGc({
              repoRoot: resolved.repoRoot,
              apply,
              salvageDirty,
              includeDetached,
              // The daemon's own live in-memory registry — fresher than
              // whatever's on disk, and always available here since this
              // route is only reachable when a SessionsRegistry is wired
              // (`opts.sessions`, e.g. the /sessions family above).
              protectedPaths: opts.sessions ? livingSessionCwds(opts.sessions) : undefined,
            })
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "worktree_gc_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // /activities/:id/wait — blocking long-poll on ONE activity record:
        // resolves with the freshly-projected ActivityRecord when it next
        // announces a change (`activity:changed` — state/waitingOn really
        // moved), immediately when it is already terminal (terminal records
        // are immutable, so there is nothing left to wait for), or with
        // `{timedOut:true}` when `timeoutMs` elapses (default 25000, cap
        // 55000 to stay under typical HTTP client/proxy timeouts — same
        // budget and response split as GET /policies/:id/wait; callers chain
        // requests for longer waits). Same origin guard + 501-when-unwired
        // as GET /activities below.
        const activityWaitMatch = path.match(/^\/activities\/([^/]+)\/wait$/)
        if (activityWaitMatch && req.method === "GET") {
          if (guardBrowserOrigin(req, res)) return
          if (!opts.activityProjector) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "activities_not_configured",
                message:
                  "GET /activities/:id/wait is not enabled — the daemon was " +
                  "started without an activity projector.",
              })
            )
            return
          }
          const activityId = decodeURIComponent(activityWaitMatch[1] ?? "")
          const reqUrl = req.url ?? ""
          const qs = new URLSearchParams(
            reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : ""
          )
          const timeoutMs = clampInt(qs.get("timeoutMs"), 25_000, 1_000, 55_000)
          try {
            // Fast 404 when no owner projects this id at all — no point
            // blocking on an id nothing will ever announce (mirrors the
            // policy wait's fast policy_not_found).
            const known = opts.activityProjector
              .list({ includeTerminal: true })
              .some(rec => rec.id === activityId)
            if (!known) {
              res.writeHead(404, { "content-type": "application/json" })
              res.end(JSON.stringify({ error: "activity_not_found", activityId }))
              return
            }
            const activity = await opts.activityProjector.wait(activityId, { timeoutMs })
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(activity ?? { timedOut: true, activityId }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "activities_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        if (path === "/activities" && req.method === "GET") {
          if (guardBrowserOrigin(req, res)) return
          // Read-only Activity ledger surface — the unified active/pending
          // read-model over completion policies, session turns, routine/
          // workflow steps, and opened PRs. Recomputed from the owners on
          // every call (a projection, never a registry). Mirrors the MCP
          // `activities_list` tool — same projector, same filter, same shape.
          if (!opts.activityProjector) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "activities_not_configured",
                message:
                  "GET /activities is not enabled — the daemon was started " +
                  "without an activity projector.",
              })
            )
            return
          }
          const reqUrl = req.url ?? ""
          const qs = new URLSearchParams(
            reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : ""
          )
          const sessionId = qs.get("sessionId")
          const state = parseActivityState(qs.get("state"))
          const kind = parseActivityKind(qs.get("kind"))
          const source = parseActivitySource(qs.get("source"))
          const includeTerminal =
            qs.get("includeTerminal") === "1" || qs.get("includeTerminal") === "true"
          const filter: ActivityListFilter = {
            ...(sessionId !== null ? { sessionId } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(includeTerminal ? { includeTerminal } : {}),
          }
          try {
            const activities = opts.activityProjector.list(filter)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ activities, counts: activityCounts(activities) }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "activities_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Workspace registry mutation — makes `agentproto workspace
        // add/remove/use` reachable off the CLI (e.g. the VS Code
        // "create workspace here" CTA). Same per-boot token gate as
        // other local mutating routes (POST /files/upload,
        // POST /permissions/:id): these edit ~/.agentproto/workspaces.json
        // and register directories the daemon will later use as a
        // session cwd, so they get the same protection as other
        // filesystem-mutating routes, not the ungated /mcps/imports
        // precedent.
        //
        // NOTE: this is hand-wired REST, not a `defineTool` isomorphic
        // verb — there's no existing machinery in this repo that
        // projects one `defineTool` contract to cli+http+mcp+sdk (see
        // packages/worktree for the closest precedent: defineTool
        // contracts wired to CLI only, by hand, per call site). Doing
        // that generically was out of scope for unblocking the VS Code
        // extension; a follow-up could promote `commands/workspace.ts`
        // + these three routes to share one `defineTool` contract each.
        if (path === "/workspaces" && req.method === "POST") {
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          const body = (await readJsonBody(req)) as {
            path?: unknown
            slug?: unknown
            label?: unknown
          } | null
          if (!body || typeof body.path !== "string" || !body.path) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing_path" }))
            return
          }
          if (!isAbsolute(body.path)) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspace_path_not_absolute",
                message: `path must be absolute, got "${body.path}".`,
              })
            )
            return
          }
          try {
            await stat(body.path)
          } catch {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspace_path_not_found",
                message: `"${body.path}" doesn't exist.`,
              })
            )
            return
          }
          if (body.slug !== undefined && typeof body.slug !== "string") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "invalid_slug" }))
            return
          }
          if (body.label !== undefined && typeof body.label !== "string") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "invalid_label" }))
            return
          }
          try {
            const config = await loadWorkspacesConfig()
            const next = addWorkspace(config, {
              slug: body.slug || basename(body.path),
              path: body.path,
              ...(body.label ? { label: body.label } : {}),
            })
            await saveWorkspacesConfig(next)
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify(next))
          } catch (err) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspace_add_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        if (path === "/workspaces/active" && req.method === "PUT") {
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          const body = (await readJsonBody(req)) as { slug?: unknown } | null
          if (!body || typeof body.slug !== "string" || !body.slug) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing_slug" }))
            return
          }
          try {
            const config = await loadWorkspacesConfig()
            const next = setActiveWorkspace(config, body.slug)
            await saveWorkspacesConfig(next)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(next))
          } catch (err) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "workspace_not_found",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Generic /workspaces/:slug — checked after the fixed
        // /workspaces/active path above so PUT-active never gets
        // mis-parsed as a slug (matters if this ever grows a same-path
        // method; today DELETE vs PUT already disambiguate, but the
        // ordering keeps that true even if a GET or PATCH variant is
        // added here later).
        const workspaceSlugMatch = path.match(/^\/workspaces\/([^/]+)$/)
        if (workspaceSlugMatch && req.method === "DELETE") {
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          const slug = decodeURIComponent(workspaceSlugMatch[1] ?? "")
          const config = await loadWorkspacesConfig()
          if (!findWorkspace(config, slug)) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "workspace_not_found", slug }))
            return
          }
          const next = removeWorkspace(config, slug)
          await saveWorkspacesConfig(next)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(next))
          return
        }

        if (path === "/mcps/imports" && req.method === "GET") {
          const config = await loadImportedMcps()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(config))
          return
        }
        if (path === "/mcps/imports" && req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            sourceMcpId?: string
            alias?: string
          } | null
          if (!body || typeof body.sourceMcpId !== "string") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing_sourceMcpId" }))
            return
          }
          const discovered = await discoverMcps()
          const snapshot = discovered.find(d => d.id === body.sourceMcpId)
          if (!snapshot) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "discovered_mcp_not_found",
                sourceMcpId: body.sourceMcpId,
              })
            )
            return
          }
          const cfg = await loadImportedMcps()
          const next = addImport(cfg, {
            snapshot,
            ...(body.alias ? { alias: body.alias } : {}),
          })
          await saveImportedMcps(next)
          res.writeHead(201, { "content-type": "application/json" })
          res.end(JSON.stringify(next.imports.find(e => e.id === snapshot.id)))
          return
        }
        const importMatch = path.match(/^\/mcps\/imports\/(.+)$/)
        if (importMatch && req.method === "DELETE") {
          // The id is URL-encoded since it contains colons + slashes
          // (e.g. claude-code:project:/path:name).
          const id = decodeURIComponent(importMatch[1] ?? "")
          const cfg = await loadImportedMcps()
          if (!cfg.imports.some(e => e.id === id)) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "import_not_found", id }))
            return
          }
          await saveImportedMcps(removeImport(cfg, id))
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, id }))
          return
        }

        if (path === "/mcps/discovered" && req.method === "GET") {
          // No host wiring needed — the scanner reads
          // ~/.claude.json + ~/.cursor/mcp.json + goose config
          // directly. Always available; cheap (~5ms typical).
          try {
            const mcps = await discoverMcps()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ mcps }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "discovery_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Browser-friendly proxy surface — same operations the MCP
        // tools expose (mcp_imported_status / list_tools / call) but
        // over plain HTTP so the /providers/mcp page can render them
        // without embedding an MCP client.
        if (path === "/mcps/proxy/status" && req.method === "GET") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          try {
            const imports = await opts.mcpProxy.listAliases()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ imports }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "proxy_status_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }
        const proxyToolsMatch = path.match(/^\/mcps\/proxy\/tools\/(.+)$/)
        if (proxyToolsMatch && req.method === "GET") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          const alias = decodeURIComponent(proxyToolsMatch[1] ?? "")
          const out = await opts.mcpProxy.listTools(alias)
          res.writeHead(out.ok ? 200 : 502, {
            "content-type": "application/json",
          })
          res.end(JSON.stringify(out))
          return
        }
        if (path === "/mcps/proxy/call" && req.method === "POST") {
          if (!opts.mcpProxy) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "mcp_proxy_not_configured" }))
            return
          }
          const body = (await readJsonBody(req)) as {
            alias?: unknown
            toolName?: unknown
            args?: unknown
          } | null
          if (
            !body ||
            typeof body.alias !== "string" ||
            typeof body.toolName !== "string"
          ) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "invalid_body",
                message: "expected { alias, toolName, args? }",
              })
            )
            return
          }
          const result = await opts.mcpProxy.callTool(
            body.alias,
            body.toolName,
            body.args ?? {}
          )
          res.writeHead(result.ok ? 200 : 502, {
            "content-type": "application/json",
          })
          res.end(JSON.stringify(result))
          return
        }

        if (path === "/adapters" && req.method === "GET") {
          if (!opts.listAgentAdapters) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "lister_not_configured",
                message:
                  "Daemon was started without `listAgentAdapters` — see " +
                  "@agentproto/cli's `listInstalledAdapters` for the canonical impl.",
              })
            )
            return
          }
          try {
            const adapters = await opts.listAgentAdapters()
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ adapters }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "list_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Install an adapter by slug. Companion mutation to `GET /adapters`:
        // drives the cli's install path (npm-global for acp-catalog CLIs, the
        // manifest install[] pipeline for first-party adapters) and returns
        // the re-read status. Ordinary install failures come back as
        // `{ ok:false }` with 200 — a non-2xx is reserved for "not wired" /
        // "bad slug". `POST /adapters/:slug/install`.
        {
          const installMatch = path.match(
            /^\/adapters\/([^/]+)\/install$/,
          )
          if (installMatch && req.method === "POST") {
            if (!opts.installAgentAdapter) {
              res.writeHead(501, { "content-type": "application/json" })
              res.end(
                JSON.stringify({
                  error: "installer_not_configured",
                  message:
                    "Daemon was started without `installAgentAdapter` — see " +
                    "@agentproto/cli's `installAdapter` for the canonical impl.",
                }),
              )
              return
            }
            const slug = decodeURIComponent(installMatch[1]!)
            if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
              res.writeHead(400, { "content-type": "application/json" })
              res.end(
                JSON.stringify({
                  error: "invalid_slug",
                  message: `invalid adapter slug '${slug}' — slugs are lower-kebab.`,
                }),
              )
              return
            }
            try {
              const result = await opts.installAgentAdapter(slug)
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(result))
            } catch (err) {
              res.writeHead(500, { "content-type": "application/json" })
              res.end(
                JSON.stringify({
                  error: "install_failed",
                  message: err instanceof Error ? err.message : String(err),
                }),
              )
            }
            return
          }
        }

        // Read-only catalog/vendor endpoint (SPEC §5) — no session, no auth
        // gate (same policy as /adapters and /presets). Query params:
        // adapter, vendor, route, runnableOnly.
        if (path === "/catalog/models" && req.method === "GET") {
          if (!opts.listCatalogModels) {
            res.writeHead(501, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "lister_not_configured",
                message:
                  "Daemon was started without `listCatalogModels` — see " +
                  "`buildCatalogModels` in `catalog-models.ts`.",
              })
            )
            return
          }
          try {
            const qs = new URLSearchParams(
              url.includes("?") ? url.slice(url.indexOf("?") + 1) : "",
            )
            const runnableOnlyParam = qs.get("runnableOnly")
            const catalog = await opts.listCatalogModels({
              ...(qs.get("adapter") ? { adapter: qs.get("adapter")! } : {}),
              ...(qs.get("vendor") ? { vendor: qs.get("vendor")! } : {}),
              ...(qs.get("route") ? { route: qs.get("route")! } : {}),
              ...(runnableOnlyParam === "true" ? { runnableOnly: true } : {}),
            })
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(catalog))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "list_failed",
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }

        // Named auth-profile lifecycle (SPEC §1c). The daemon owns the
        // keychain + `~/.agentproto/auth-profiles.json`, so a remote client
        // (VS Code, cloud operator) provisions through these routes rather
        // than writing the files itself. The credential is INPUT-only: the
        // create response returns metadata + a fingerprint, never the secret.
        // Same auth policy as the peer read routes above (no session gate).
        if (path === "/auth/profiles" && req.method === "GET") {
          try {
            const qs = new URLSearchParams(
              url.includes("?") ? url.slice(url.indexOf("?") + 1) : "",
            )
            const endpoint = qs.get("endpoint")
            const profiles = await listAuthProfiles(endpoint ?? undefined)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ profiles }))
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: "list_failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          }
          return
        }
        if (path === "/auth/profiles" && req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            id?: unknown
            endpoint?: unknown
            method?: unknown
            credential?: unknown
            source?: unknown
            label?: unknown
            credentialRef?: unknown
          } | null
          try {
            const created = await createAuthProfile(
              {
                id: String(body?.id ?? ""),
                endpoint: String(body?.endpoint ?? ""),
                method: body?.method as "oauth-bearer" | "api-key",
                ...(typeof body?.credential === "string" ? { credential: body.credential } : {}),
                ...(typeof body?.source === "string" ? { source: body.source } : {}),
                ...(typeof body?.label === "string" ? { label: body.label } : {}),
                ...(typeof body?.credentialRef === "string"
                  ? { credentialRef: body.credentialRef }
                  : {}),
              },
              defaultProfileProvisionDeps(),
            )
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify({ profile: created }))
          } catch (err) {
            const status = err instanceof AuthProfileValidationError ? 400 : 500
            res.writeHead(status, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error:
                  err instanceof AuthProfileValidationError
                    ? "invalid_input"
                    : "create_failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          }
          return
        }
        const authProfileMatch = path.match(/^\/auth\/profiles\/(.+)$/)
        if (authProfileMatch && req.method === "DELETE") {
          const id = decodeURIComponent(authProfileMatch[1] ?? "")
          try {
            const result = await deleteAuthProfile(id, defaultProfileProvisionDeps())
            res.writeHead(result.deleted ? 200 : 404, {
              "content-type": "application/json",
            })
            res.end(JSON.stringify(result))
          } catch (err) {
            const status = err instanceof AuthProfileValidationError ? 400 : 500
            res.writeHead(status, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error:
                  err instanceof AuthProfileValidationError
                    ? "invalid_input"
                    : "delete_failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          }
          return
        }

        // User presets are private saved spawn configurations. Keep this
        // deliberately distinct from `/presets` below, which is the static
        // provider-preset catalog retained for compatibility.
        if (path === "/user-presets" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ presets: await listUserPresets() }))
          return
        }
        // POST /user-presets — create or update a favorite (upsert by id).
        // `saveUserPreset` is the single validation boundary (the same Zod
        // parse the CLI goes through), so a bad body surfaces as a 400 with
        // the parse message rather than a silent 500. Token-gated like the
        // other filesystem-mutating routes (POST /workspaces above): a preset
        // pins a `cwd` the daemon will later spawn into and a profileRef the
        // spawn bills against, so it earns the same protection as a GET does
        // not. The body still carries only a profileRef *reference*, never
        // credential material.
        if (path === "/user-presets" && req.method === "POST") {
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          const body = (await readJsonBody(req)) as Partial<UserPreset> | null
          try {
            await saveUserPreset((body ?? {}) as UserPreset)
            const saved = await getUserPreset(String(body?.id ?? ""))
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ preset: saved }))
          } catch (err) {
            const status = err instanceof ZodError ? 400 : 500
            res.writeHead(status, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: err instanceof ZodError ? "invalid_input" : "save_failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            )
          }
          return
        }
        // DELETE /user-presets/:id — remove a favorite. 404 when it never
        // existed, mirroring DELETE /auth/profiles/:id above.
        const userPresetMatch = path.match(/^\/user-presets\/(.+)$/)
        if (userPresetMatch && req.method === "DELETE") {
          const gate = checkSessionsToken(req)
          if (gate !== "ok") {
            rejectUnauthorizedSession(req, res, gate)
            return
          }
          const id = decodeURIComponent(userPresetMatch[1] ?? "")
          const deleted = await deleteUserPreset(id)
          res.writeHead(deleted ? 200 : 404, { "content-type": "application/json" })
          res.end(JSON.stringify({ deleted }))
          return
        }

        // Preset routes — static data, always available (no registry opt-in).
        // GET /presets → { presets: AdapterEntry<PresetInfo>[] }
        if (path === "/presets" && req.method === "GET") {
          const handled = await handlePresets(req, res, path)
          if (handled) return
        }

        // Tunnel routes — only registered when the gateway was built with
        // a TunnelRegistry. /tunnels, /tunnels/:id.
        if (opts.tunnels && path.startsWith("/tunnels")) {
          const handled = await handleTunnels(req, res, path, opts.tunnels)
          if (handled) return
        }

        // GET /routines — AIP-41 routine DEFINITIONS from the registrar.
        // Mirrors the MCP `routine_list` tool (orchestration-tools.ts).
        if (opts.routineRegistrar && path === "/routines") {
          const handled = await handleRoutinesListing(req, res, path, opts.routineRegistrar)
          if (handled) return
        }

        // Workflow routes — only registered when the gateway was built with
        // a WorkflowRunner. /workflows, /workflows/:id, /workflows/:id/cancel,
        // /workflows/:id/escalation/resolve. Mirrors the MCP `workflow_*`
        // tools (orchestration-tools.ts) — same WorkflowRunner instance.
        if (
          opts.workflowRunner &&
          (path === "/workflows" || path.startsWith("/workflows/"))
        ) {
          const handled = await handleWorkflows(req, res, path, opts.workflowRunner)
          if (handled) return
        }

        // Policy routes — POST /policies (attach), GET /policies (list),
        // POST /policies/:id/cancel, POST /policies/:id/ack, and the
        // blocking long-poll `GET /policies/:id/wait` (resolves when the
        // policy leaves watching/gating → done/blocked/awaiting-ack/
        // cancelled, or timeoutMs elapses). Mirrors the MCP `policy_attach/
        // status/cancel/ack/list` tools — same CompletionPolicySupervisor
        // instance. Only mounted when a supervisor is wired.
        if (
          opts.supervisor &&
          (path === "/policies" || path.startsWith("/policies/"))
        ) {
          const handled = await handlePolicies(
            req,
            res,
            path,
            opts.supervisor,
            opts.sessions,
          )
          if (handled) return
        }

        // Task ledger routes — GET/POST /tasks, GET/PATCH /tasks/:id.
        // Mirrors the /policies block: thin adapters over the same
        // TaskLedger the MCP `task_*` tools mutate. HTTP callers are
        // OPERATOR context (the subtree-scoped surface is the
        // /mcp/orchestrator gateway — same split as the policy tools).
        // Browser-origin guarded like /activities; PATCH is the human-UI
        // write path, rev-CAS answers 409 {conflict, current}.
        if (
          opts.taskLedger &&
          (path === "/tasks" || path.startsWith("/tasks/"))
        ) {
          if (guardBrowserOrigin(req, res)) return
          const handled = await handleTasks(req, res, path, opts.taskLedger)
          if (handled) return
        }

        // Permission inbox routes — GET /permissions (list pending across all
        // permission-hold sessions), POST /permissions/:id (approve/deny).
        // Mirrors the MCP `permissions_list` / `permissions_respond` tools —
        // same SessionsRegistry inbox. Only mounted when a registry is wired.
        if (opts.sessions && path.startsWith("/permissions")) {
          // Non-GET (approve/deny) is a mutating action — same per-boot token
          // gate as the mutating /sessions/* routes. GET is read-only, ungated.
          if ((req.method ?? "GET") !== "GET") {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handlePermissions(req, res, path, opts.sessions)
          if (handled) return
        }

        // Pairing routes — E2E daemon pairing. POST /pairings/offer,
        // GET /pairings, DELETE /pairings/:fingerprint. All mutating routes
        // (and the offer route, which starts an outbound rendezvous dial) take
        // the per-boot token gate; GET is read-only. Only mounted when a
        // registry is wired.
        if (opts.pairings && path.startsWith("/pairings")) {
          if ((req.method ?? "GET") !== "GET") {
            const gate = checkSessionsToken(req)
            if (gate !== "ok") {
              rejectUnauthorizedSession(req, res, gate)
              return
            }
          }
          const handled = await handlePairings(req, res, path, opts.pairings)
          if (handled) return
        }

        // Cron routes — only registered when the gateway was built with
        // a CronScheduler. /cron, /cron/:id, /cron/:id/run.
        if (opts.cronScheduler && path.startsWith("/cron")) {
          const handled = await handleCron(req, res, path, opts.cronScheduler)
          if (handled) return
        }

        // AIP-41 routine-def manual trigger + reconcile — deliberately NOT
        // under /routines/* (see routine-registrar.ts). /routine-defs/:id/trigger
        // and /routine-defs/reconcile.
        if (opts.routineRegistrar && path.startsWith("/routine-defs/")) {
          const handled = await handleRoutineDefs(req, res, path, opts.routineRegistrar)
          if (handled) return
        }

        // Standalone app UI host — GET /apps/:appId/ui serves an installed
        // app's html with a REST `window.McpApp` bridge injected (the same
        // UI that renders in an MCP-Apps iframe works in a plain browser
        // tab), POST /apps/:appId/tool-call is the REST twin of the MCP
        // app_tool_call gateway. `(.+)` (not `[^/]+`): appIds are
        // `@scope/name`, so both the literal-slash and the %2F-encoded
        // spelling of the id must route. Gated like the other browser-
        // reachable routes: guardBrowserOrigin blocks a non-allowlisted
        // page's drive-by (the served UI itself is same-origin ⇒ loopback
        // ⇒ allowlisted), authorize() gates the tunnel path by bearer.
        if (opts.appRegistry && path.startsWith("/apps/")) {
          const uiMatch = path.match(/^\/apps\/(.+)\/ui$/)
          if (uiMatch && req.method === "GET") {
            if (guardBrowserOrigin(req, res)) return
            if (!authorize(req, res)) return
            await handleAppUiPage(res, decodeURIComponent(uiMatch[1]!), opts.appRegistry)
            return
          }
          const toolCallMatch = path.match(/^\/apps\/(.+)\/tool-call$/)
          if (toolCallMatch && req.method === "POST") {
            if (guardBrowserOrigin(req, res)) return
            if (!authorize(req, res)) return
            await handleAppUiToolCall(
              req,
              res,
              decodeURIComponent(toolCallMatch[1]!),
              opts.appRegistry,
              opts.appToolCallDeps ?? {},
            )
            return
          }
          // Binary sibling of the app_external_read MCP tool — streams a
          // file's raw bytes from a granted externalReadRoots entry instead
          // of returning them in a JSON tool response. Same gating as
          // /ui and /tool-call: guardBrowserOrigin blocks a non-allowlisted
          // page's drive-by, authorize() gates the tunnel path by bearer.
          const blobMatch = path.match(/^\/apps\/(.+)\/external-blob$/)
          if (blobMatch && req.method === "GET") {
            if (guardBrowserOrigin(req, res)) return
            if (!authorize(req, res)) return
            await handleAppExternalBlob(req, res, decodeURIComponent(blobMatch[1]!), opts.appRegistry)
            return
          }
        }

        // App routes — POST /apps/:appId/apply, DELETE /apps/:appId/apply,
        // GET /scopes/:scopeId/apps. Mirrors the MCP app_apply/app_unapply/
        // app_list_applied tools. Only mounted when appRegistry is wired.
        if (
          opts.appRegistry &&
          opts.performAppInstall &&
          opts.listRegisteredToolIds &&
          (path.startsWith("/apps/") || path.startsWith("/scopes/"))
        ) {
          const handled = await handleApps(
            req,
            res,
            path,
            opts.appRegistry,
            opts.performAppInstall,
            opts.listRegisteredToolIds,
            opts.resolveAgentAdapter,
          )
          if (handled) return
        }

        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not_found", path }))
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: "internal_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
    })()
  })

  // ── WebSocket upgrade: /sessions/:id/pty ──
  // Single WSS bound to the HTTP server's `upgrade` event. Connections
  // are accepted only when the SessionsRegistry is wired AND PTY
  // support is advertised. Frames are JSON-encoded over text WS
  // messages (binary mode is a future optimization — JSON keeps
  // wireshark/devtools debuggable):
  //   server → client: {kind:"data", b64:"..."}
  //   server → client: {kind:"exit", exitCode:0, signal?:1}
  //   client → server: {kind:"input", b64:"..."}  (or {kind:"input", text:"..."})
  //   client → server: {kind:"resize", cols:80, rows:24}
  //   client → server: {kind:"ping"}              (no-op keepalive)
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/"
    const path = url.split("?")[0] ?? "/"
    const ptyMatch = path.match(/^\/sessions\/([^/]+)\/pty$/)
    if (!ptyMatch) {
      socket.destroy()
      return
    }
    if (!opts.sessions || opts.ptyEnabled !== true) {
      rejectUpgrade(socket, 501, "pty_not_configured")
      return
    }
    // Per-boot token gate, no loopback bypass — see comment on
    // checkSessionsToken for why.
    const gate = checkSessionsToken(req)
    if (gate !== "ok") {
      rejectUpgrade(socket, 401, gate === "missing" ? "missing_token" : "bad_token")
      return
    }
    const id = ptyMatch[1]
    if (!id) {
      rejectUpgrade(socket, 400, "missing_id")
      return
    }
    // Resolve id-or-name BEFORE upgrading so a typo returns a clean
    // 404 instead of a successful WS that immediately closes.
    const desc = opts.sessions.findByIdOrName(id)
    if (!desc) {
      rejectUpgrade(socket, 404, "session_not_found")
      return
    }
    if (desc.pty !== true) {
      rejectUpgrade(socket, 400, "session_not_pty")
      return
    }
    // A descriptor for an exited/killed/error session lives on as
    // history — its PTY child is gone. Reject the upgrade with a
    // clear reason so the CLI/web client can suggest `restart`
    // instead of letting the user see a generic 1011 mid-attach.
    if (
      desc.status === "exited" ||
      desc.status === "killed" ||
      desc.status === "error"
    ) {
      rejectUpgrade(
        socket,
        410,
        `session_${desc.status}`,
        `Session ${desc.id}${desc.name ? ` (${desc.name})` : ""} has ${desc.status}. ` +
          `Spawn a fresh one with: agentproto sessions restart ${desc.name ?? desc.id}`,
      )
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      handlePtyWebSocket(ws, req, desc.id, opts.sessions!)
    })
  })

  const bind = opts.bind ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, bind, () => resolve())
  })

  return {
    url: `http://${bind}:${opts.port}`,
    async stop() {
      // Per-request transports/servers are torn down on `res.close`,
      // so we only need to stop the HTTP listener here. The WSS is
      // bound `noServer:true` so closing the HTTP server also tears
      // down its underlying TCP socket; live WS connections receive
      // a close frame from the kernel.
      wss.close()
      // `server.close()`'s callback only fires once every existing
      // connection has ended on its own — it does NOT sever them.
      // This daemon's whole purpose is long-lived keep-alive/SSE
      // connections (session_monitor long-polls, output streaming,
      // WS PTYs), so under normal load at least one is always open
      // and `close()` would hang forever, leaving SIGTERM/SIGINT
      // looking "ignored". `closeAllConnections()` (Node 18.2+)
      // forcibly destroys every open socket so shutdown actually
      // completes.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Reject an HTTP upgrade attempt with a structured plaintext body.
 * `ws.handleUpgrade` is meant to be the success path — if we can't
 * accept the upgrade we write a minimal HTTP response and destroy
 * the socket, matching ws's own internal error path.
 */
function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
  message?: string,
): void {
  const reasonText = `${status} ${reason}`
  const body: { error: string; message?: string } = { error: reason }
  if (message) body.message = message
  try {
    socket.write(
      `HTTP/1.1 ${reasonText}\r\n` +
        `Content-Type: application/json\r\n` +
        `Connection: close\r\n\r\n` +
        JSON.stringify(body) +
        `\n`,
    )
  } catch {
    // socket already gone — fall through
  }
  socket.destroy()
}

/**
 * Per-connection WS handler for /sessions/:id/pty. Attaches as a
 * subscriber to the SessionsRegistry; bridges JSON frames in both
 * directions. Per-subscriber backpressure: if the WS's `bufferedAmount`
 * exceeds a threshold, the next chunk is dropped (slow client must
 * not stall the daemon's fan-out to other subscribers).
 */
function handlePtyWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  sessionId: string,
  registry: SessionsRegistry,
): void {
  // Parse cols/rows from the query string for the initial dimension
  // hint. Real clients will send a {kind:"resize"} immediately after
  // connecting; this seeds the registry's min-size calculation so the
  // first replay frames render at a sensible width if no resize comes.
  const query = new URLSearchParams(
    (req.url ?? "").includes("?") ? (req.url ?? "").split("?")[1] : "",
  )
  const cols = clampPositiveInt(query.get("cols"), 80)
  const rows = clampPositiveInt(query.get("rows"), 24)

  // Backpressure threshold — when the socket has more than 256 KiB
  // queued, drop the next data frame for THIS subscriber rather than
  // letting the registry block on send. Other subscribers stay live.
  const BACKPRESSURE_BYTES = 256 * 1024

  const handle = registry.attachPty(
    sessionId,
    { cols, rows },
    chunk => {
      if (ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) return // drop
      ws.send(
        JSON.stringify({ kind: "data", b64: chunk.toString("base64") }),
      )
    },
    evt => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(
        JSON.stringify({
          kind: "exit",
          exitCode: evt.exitCode,
          ...(evt.signal != null ? { signal: evt.signal } : {}),
        }),
      )
      // Close ourselves once we've emitted exit — the session can be
      // reattached for a buffer replay but this socket is done.
      try {
        ws.close(1000, "session exited")
      } catch {
        // ignore
      }
    },
  )

  if (!handle) {
    // Race: the session may have vanished between the upgrade and
    // attach. Close politely.
    try {
      ws.close(1011, "session not attachable")
    } catch {
      // ignore
    }
    return
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // Binary frames not supported yet — wire format is JSON-only.
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(raw.toString("utf8"))
    } catch {
      return // malformed
    }
    if (!frame || typeof frame !== "object") return
    const f = frame as Record<string, unknown>
    switch (f.kind) {
      case "input": {
        // Accept either {text} (UTF-8) or {b64} (arbitrary bytes,
        // useful for clients sending raw key sequences).
        if (typeof f.text === "string") {
          handle.write(f.text)
        } else if (typeof f.b64 === "string") {
          try {
            handle.write(Buffer.from(f.b64, "base64").toString("utf8"))
          } catch {
            // ignore malformed base64
          }
        }
        break
      }
      case "resize": {
        const c =
          typeof f.cols === "number" && f.cols > 0 ? Math.floor(f.cols) : null
        const r =
          typeof f.rows === "number" && f.rows > 0 ? Math.floor(f.rows) : null
        if (c && r) handle.resize(c, r)
        break
      }
      case "ping":
        // Reply with pong so client keepalive logic works. Optional.
        try {
          ws.send(JSON.stringify({ kind: "pong" }))
        } catch {
          // ignore
        }
        break
      // Unknown kinds silently dropped; reserved for forward compat.
    }
  })

  ws.on("close", () => {
    handle.detach()
  })
  ws.on("error", () => {
    handle.detach()
  })
}

function clampPositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * The exactly-once replay→live handoff for `GET /sessions/:id/events/stream`,
 * pulled out of the route handler so the race it exists to close can be unit
 * tested with a fully controlled disk iterator and a fully controlled
 * subscribe callback instead of racing real fs/network timing.
 *
 * `subscribe` is called SYNCHRONOUSLY, before this function does anything
 * else — including before it starts consuming `diskRecords` — and the
 * returned `unsubscribe` is handed back to the caller before `done` even
 * starts resolving, so a caller can wire cleanup (e.g. `req.once("close",
 * unsubscribe)`) immediately, with zero awaited statements between
 * subscribing and the disk read starting. That ordering is what makes the
 * handoff gap-free: a record written after subscribe() is ALWAYS observed
 * by the live callback, whether or not the disk read also happens to reach
 * it first.
 *
 * Both channels feed the same `gate`, keyed on the highest seq sent so far
 * (seeded at `since`). Live records arriving while the disk read is still
 * in flight are parked in `buffered` rather than sent immediately — sending
 * them immediately would risk interleaving them ahead of not-yet-read disk
 * records, breaking ordering. Once the disk read finishes, `gate` already
 * reflects the highest seq it actually delivered, so draining `buffered`
 * through it for-free skips anything the disk read already sent and
 * forwards only what's new — that's what makes the handoff dupe-free too.
 */
export function deliverRecordsExactlyOnce(opts: {
  since: number
  diskRecords: AsyncIterable<Record<string, unknown>>
  subscribe: (onRecord: (record: Record<string, unknown>) => void) => () => void
  send: (record: Record<string, unknown>) => void
}): { unsubscribe: () => void; done: Promise<void> } {
  let lastSeqSent = opts.since
  let replaying = true
  const buffered: Record<string, unknown>[] = []
  const gate = (record: Record<string, unknown>): void => {
    const seq = record.seq
    if (typeof seq !== "number" || seq <= lastSeqSent) return
    lastSeqSent = seq
    opts.send(record)
  }
  const unsubscribe = opts.subscribe(record => {
    if (replaying) {
      buffered.push(record)
    } else {
      gate(record)
    }
  })
  const done = (async (): Promise<void> => {
    for await (const rec of opts.diskRecords) {
      gate(rec)
    }
    // Synchronous from here — no `await` between flipping `replaying` and
    // draining `buffered`, so no write can land in the gap between them.
    replaying = false
    for (const rec of buffered) gate(rec)
    buffered.length = 0
  })()
  return { unsubscribe, done }
}

/**
 * AI-SDK v6 "UI message stream" writer — the wire protocol the
 * `/sessions/:id/chat` and `/sessions/chat` routes speak. Same SSE framing
 * `createUIMessageStreamResponse` / `JsonToSseTransformStream` emit
 * (`data: <JSON UIMessageChunk>\n\n`, `x-vercel-ai-ui-message-stream: v1`),
 * but driven here by the daemon's RAW transcript records instead of a model
 * stream. Backlog + live are merged via `deliverRecordsExactlyOnce` (no dupe,
 * no hole); each record is mapped to chunk(s) and written as its own `data:`
 * frame. On a `turn-end` record the stream finalizes (`data: [DONE]\n\n`).
 */
function startAiUiMessageStream(opts: {
  res: ServerResponse
  since: number
  diskRecords: AsyncIterable<Record<string, unknown>>
  subscribe: (onRecord: (record: Record<string, unknown>) => void) => () => void
  map: (record: AgentprotoRawTranscriptRecord) => UIMessageChunk[]
}): { finalize: () => void; disconnect: () => void; done: Promise<void> } {
  const { res } = opts
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    "x-accel-buffering": "no",
  })
  // Unblocks `writeHead` (Node buffers it until the first write) so a session
  // with nothing new to replay doesn't hang the client — same `: connected`
  // convention `/events/stream` uses.
  res.write(`: connected\n\n`)
  let finalized = false
  let unsubscribeFn: (() => void) | null = null
  const ping = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`)
    } catch {
      finalize()
    }
  }, 25_000)
  const unwind = (): void => {
    clearInterval(ping)
    if (unsubscribeFn) {
      unsubscribeFn()
      unsubscribeFn = null
    }
  }
  const finalize = (): void => {
    if (finalized) return
    finalized = true
    try {
      res.write(`data: [DONE]\n\n`)
      res.end()
    } catch {
      // Socket already gone — nothing left to flush.
    }
    unwind()
  }
  const writeChunk = (chunk: UIMessageChunk): void => {
    try {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    } catch {
      finalize()
    }
  }
  const { unsubscribe, done } = deliverRecordsExactlyOnce({
    since: opts.since,
    diskRecords: opts.diskRecords,
    subscribe: opts.subscribe,
    send: record => {
      // The `turn-end` record finalized the response (`res.end()`). The
      // transcript writer can still emit POST-terminal records after it —
      // `runAgentTurn` writes the durable `usage_snapshot` (and possibly a
      // `usage_update`) in its finally block AFTER recording the turn-end
      // (sessions.ts). Those are turn bookkeeping, not part of the assistant
      // message stream, and writing them to the now-ended response would
      // raise ERR_STREAM_WRITE_AFTER_END. Drop them entirely — no map, no
      // write — once the stream is finalized.
      if (finalized) return
      for (const chunk of opts.map(record as unknown as AgentprotoRawTranscriptRecord))
        writeChunk(chunk)
      if (record.kind === "turn-end") finalize()
    },
  })
  unsubscribeFn = unsubscribe
  return { finalize, disconnect: unwind, done }
}

/** Highest `seq` currently on disk for a session's events.jsonl (0 if absent).
 *  Used as the chat stream's `since` edge so a continuation only replays the
 *  records that land AFTER the caller's prompt — never the session's prior
 *  turn history. */
async function currentTranscriptSeq(id: string): Promise<number> {
  const filePath = sessionEventsPath(id)
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: "utf8" })
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw err
  }
  let last = 0
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof rec.seq === "number") last = rec.seq
    } catch {
      continue
    }
  }
  return last
}

/** Async-iterable of a session's on-disk events.jsonl records. Tolerates a
 *  missing file (yields nothing) — unlike /events/stream's 404-on-ENOENT, a
 *  chat against a session with no transcript yet is a live-only stream. */
async function* transcriptDiskRecords(id: string): AsyncGenerator<Record<string, unknown>> {
  const filePath = sessionEventsPath(id)
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: "utf8" })
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
  }
}

/**
 * Shared body → `spawnAgentSession` input mapper used by BOTH
 * `POST /sessions/agent` and the create-variant `POST /sessions/chat`, so the
 * two surfaces can't drift from each other (or from the MCP `agent_start` core
 * they both delegate to).
 */
/** Map a `POST /sessions/agent` JSON body onto `SpawnAgentSessionInput` — the
 *  HTTP twin of the MCP `agent_start` arg mapping. Exported for unit tests
 *  (`session-http-agent-spawn.test.ts`) that assert field-forwarding parity —
 *  notably that the inline `sandbox` spec's `extraPorts`/`env` survive the map
 *  (the #1150 drop this guards against). */
export function buildSpawnSessionHttpArgs(
  b: Record<string, unknown>,
  adapter: string,
  preset?: UserPreset,
): SpawnAgentSessionInput {
  return {
    adapter,
    ...(typeof b.origin === "string" && b.origin.length > 0 ? { origin: b.origin } : {}),
    ...(typeof b.harness === "string" ? { harness: b.harness } : {}),
    ...(typeof b.cwd === "string" && b.cwd.length > 0 ? { cwd: b.cwd } : {}),
    ...(typeof b.workspaceSlug === "string" && b.workspaceSlug.length > 0
      ? { workspaceSlug: b.workspaceSlug }
      : {}),
    ...(typeof b.resumeSessionId === "string" && b.resumeSessionId.length > 0
      ? { resumeSessionId: b.resumeSessionId }
      : {}),
    ...(typeof b.mode === "string" && b.mode.length > 0 ? { mode: b.mode } : {}),
    ...(typeof b.model === "string" && b.model.length > 0 ? { model: b.model } : {}),
    ...(typeof b.effort === "string" && b.effort.length > 0 ? { effort: b.effort } : {}),
    ...(b.route !== undefined
      ? (() => {
          const parsed = parseRouteField(b.route)
          return parsed !== undefined ? { route: parsed } : {}
        })()
      : {}),
    ...(b.access !== undefined
      ? (() => {
          const parsed = parseAccessField(b.access)
          return parsed !== undefined ? { access: parsed } : {}
        })()
      : {}),
    ...(typeof b.posture === "string" && b.posture.length > 0
      ? { posture: parsePostureInput(b.posture) }
      : {}),
    ...(typeof b.contextProfile === "string" && b.contextProfile.length > 0
      ? { contextProfile: b.contextProfile }
      : {}),
    ...(preset ? { preset } : {}),
    ...(b.options !== undefined
      ? (() => {
          const parsed = parseOptionsField(b.options)
          return parsed !== undefined ? { options: parsed } : {}
        })()
      : {}),
    ...(b.auth !== undefined
      ? (() => {
          const parsed = parseAuthField(b.auth)
          return parsed !== undefined ? { auth: parsed } : {}
        })()
      : {}),
    ...(typeof b.prompt === "string" ? { prompt: b.prompt } : {}),
    ...(typeof b.label === "string" ? { label: b.label } : {}),
    // Explicit title override (SPEC-3 FIX C, `--title`) — wins over the
    // first-sentence derivation from the prompt (see session-spawn.ts).
    ...(typeof b.title === "string" ? { title: b.title } : {}),
    ...(typeof b.idempotencyKey === "string" && b.idempotencyKey.length > 0
      ? { idempotencyKey: b.idempotencyKey }
      : {}),
    // Per-call escape hatch for the daemon's `spawn.dedupe` policy — the
    // HTTP twin of the MCP `agent_start` tool's `dedupe` field. Tolerate
    // a stringified boolean like `trace`/`permissionHold`.
    ...(b.dedupe !== undefined
      ? (() => {
          const d =
            typeof b.dedupe === "boolean"
              ? b.dedupe
              : b.dedupe === "true"
                ? true
                : b.dedupe === "false"
                  ? false
                  : undefined
          return d !== undefined ? { dedupe: d } : {}
        })()
      : {}),
    // Parent-lineage hint (WP-R1) — the HTTP twin of the MCP `agent_start`
    // tool's `parentSessionId` field. This route carries no `callerScope`
    // (it's the anonymous root trust boundary), so the hint is honoured and
    // the child's depth is derived from the parent — see spawnAgentSession.
    ...(typeof b.parentSessionId === "string" && b.parentSessionId.length > 0
      ? { parentSessionId: b.parentSessionId }
      : {}),
    // Task-board pin — the HTTP twin of the MCP `agent_start` tool's
    // `boardId` field. Stamped onto the child's `meta.boardId`; the task
    // ledger prefers it over the lineage walk — see session-spawn.ts.
    ...(typeof b.boardId === "string" && b.boardId.length > 0
      ? { boardId: b.boardId }
      : {}),
    ...(typeof b.role === "string" && b.role.length > 0 ? { role: b.role } : {}),
    ...(typeof b.promptAppend === "string" ? { promptAppend: b.promptAppend } : {}),
    ...(b.orchestrator !== undefined
      ? (() => {
          const parsed = parseOrchestratorField(b.orchestrator)
          return parsed !== undefined ? { orchestrator: parsed } : {}
        })()
      : {}),
    ...(b.mcpServers !== undefined
      ? (() => {
          const parsed = parseMcpServersField(b.mcpServers)
          return parsed !== undefined ? { mcpServers: parsed } : {}
        })()
      : {}),
    // Opt this session into Langfuse tracing — the HTTP twin of the
    // MCP `agent_start` tool's `trace` field. Tolerate a stringified
    // boolean (JSON `true`, or `"true"`/`"false"` from form-ish callers)
    // so the REST driver reaches the same registry gate the MCP tool does.
    ...(b.trace !== undefined
      ? (() => {
          const t =
            typeof b.trace === "boolean"
              ? b.trace
              : b.trace === "true"
                ? true
                : b.trace === "false"
                  ? false
                  : undefined
          return t !== undefined ? { trace: t } : {}
        })()
      : {}),
    // Permission-hold mode — the HTTP twin of the MCP `agent_start` tool's
    // `permissionHold` field (and `agentproto sessions start
    // --hold-permissions`). Tolerate a stringified boolean like `trace`.
    ...(b.permissionHold !== undefined
      ? (() => {
          const h =
            typeof b.permissionHold === "boolean"
              ? b.permissionHold
              : b.permissionHold === "true"
                ? true
                : b.permissionHold === "false"
                  ? false
                  : undefined
          return h ? { permissionHold: true } : {}
        })()
      : {}),
    // Opt into direct in-band crash notification — the HTTP twin of the
    // MCP `agent_start` tool's `notifyParentOnCrash` field. Tolerate a
    // stringified boolean like `permissionHold`/`trace`.
    ...(b.notifyParentOnCrash !== undefined
      ? (() => {
          const n =
            typeof b.notifyParentOnCrash === "boolean"
              ? b.notifyParentOnCrash
              : b.notifyParentOnCrash === "true"
                ? true
                : b.notifyParentOnCrash === "false"
                  ? false
                  : undefined
          return n ? { notifyParentOnCrash: true } : {}
        })()
      : {}),
    // Worktree isolation — the HTTP twin of the MCP `agent_start` tool's
    // `worktree` field. Same `spawnAgentSession` core resolves the
    // `worktrees.isolation` policy, so `always` bites here too and there's
    // no policy-bypassing spawn path.
    ...(b.worktree !== undefined
      ? (() => {
          const parsed = parseWorktreeField(b.worktree)
          return parsed !== undefined ? { worktree: parsed } : {}
        })()
      : {}),
    // Opt-in auto-restart policy — the HTTP twin of the MCP `agent_start`
    // tool's `restartPolicy` field (restart-scheduler PR-2).
    ...(b.restartPolicy !== undefined
      ? (() => {
          const parsed = parseRestartPolicyField(b.restartPolicy)
          return parsed !== undefined ? { restartPolicy: parsed } : {}
        })()
      : {}),
    // Acknowledge an in-place spawn into a shared, dirty cwd — the HTTP
    // twin of the MCP `agent_start` tool's `allowSharedCwd` field. Tolerate
    // a stringified boolean like `permissionHold`/`trace`.
    ...(b.allowSharedCwd !== undefined
      ? (() => {
          const a =
            typeof b.allowSharedCwd === "boolean"
              ? b.allowSharedCwd
              : b.allowSharedCwd === "true"
                ? true
                : b.allowSharedCwd === "false"
                  ? false
                  : undefined
          return a ? { allowSharedCwd: true } : {}
        })()
      : {}),
    // Idle-reaper exemption — the HTTP twin of the MCP `agent_start` tool's
    // `keepAlive` field. Tolerate a stringified boolean like
    // `permissionHold`/`trace`/`allowSharedCwd`.
    ...(b.keepAlive !== undefined
      ? (() => {
          const k =
            typeof b.keepAlive === "boolean"
              ? b.keepAlive
              : b.keepAlive === "true"
                ? true
                : b.keepAlive === "false"
                  ? false
                  : undefined
          return k ? { keepAlive: true } : {}
        })()
      : {}),
    // Sandbox spawn — the HTTP twin of the MCP `agent_start` tool's `sandbox`
    // field. Accepts a provider slug string or an inline SandboxSpec object
    // (optionally carrying `reuse` for the reconnect path). Provider-specific
    // config is validated by the sandbox provider at boot time.
    ...(b.sandbox !== undefined
      ? (() => {
          const parsed = parseSandboxField(b.sandbox)
          return parsed !== undefined ? { sandbox: parsed } : {}
        })()
      : {}),
  }
}

/**
 * /sessions routes — split out of the main switch so the surface
 * stays scannable. Returns `true` when it handled the request, so
 * the dispatcher knows to skip the 404 path.
 *
 *   GET    /sessions              → list of SessionDescriptor[]
 *   GET    /sessions/summaries    → paginated SessionSummary[] (lightweight panel projection)
 *   GET    /sessions/:id          → one SessionDescriptor
 *   GET    /sessions/:id/stream   → SSE stream {line,stream} events
 *   GET    /sessions/:id/export   → ExportAgentSessionResult (transcript as markdown or JSON)
 *   GET    /sessions/:id/events   → raw structured events.jsonl records for a session.
 *                                    Query: since=<seq> (default 0), limit=<n> (default 500,
 *                                    max 2000). Returns {sessionId, events, nextSeq, complete};
 *                                    404 {error:"no_transcript"} when the file doesn't exist.
 *                                    Read-only GET, no auth gate (same policy as /export).
 *   POST   /sessions/:id/chat → enqueue a prompt + stream the turn as `ai` v6
 *                                    UI-message-stream `UIMessageChunk`s.
 *   POST   /sessions/chat      → create-and-chat: spawn (reusing /sessions/agent's
 *                                    spawnAgentSession) and stream the first turn.
 *   GET    /sessions/:id/events/stream → SSE live-push sibling of /events: replays every
 *                                    record after since=<seq> (default 0) from disk, then
 *                                    switches to live push as new records are written — one
 *                                    `data:` frame per record, same JSON shape /events returns
 *                                    per array element. 404 {error:"no_transcript"} parity with
 *                                    /events. Read-only GET, no auth gate (same policy as /events).
 *   GET    /sessions/:id/wait     → block until a lifecycle event fires (long-poll;
 *                                    requires sessionEvents + eventRing wired). Query:
 *                                    event=turn-end|awaiting-input|exited|any (default any),
 *                                    since=<cursor>, timeoutMs=<n> (default 25000, cap 55000).
 *   POST   /sessions/:id/kill     → SIGTERM, returns {ok}
 *   POST   /sessions/:id/pin      → set/clear the list-visibility pin, body
 *                                    {pinned: boolean}; returns {ok, sessionId,
 *                                    pinned}. Pure sort/display state — the
 *                                    HTTP twin of the `session_set_pinned`
 *                                    MCP verb, never touches keepAlive/reaper.
 *   POST   /sessions/:id/interrupt → cancel the in-flight turn, leave the
 *                                    session alive and idle; returns
 *                                    {ok, id, wasBusy}. No-op (wasBusy:
 *                                    false) on an idle or terminal session.
 *   POST   /sessions/:id/terminal/input → write raw input into a live PTY
 *                                    session (terminal-view reply); mirrors
 *                                    the MCP `terminal_input` verb. Body:
 *                                    { text, enter? (default true) }. 404 no
 *                                    session, 400 not a live PTY.
 *   DELETE /sessions/:id          → forget (drop from registry; only
 *                                    valid for exited/killed/error)
 *   POST   /sessions/gc           → bulk GC terminal sessions (session_gc's
 *                                    HTTP twin); body { olderThanDays?,
 *                                    forget? }; returns { mode, ids, count }
 *   POST   /sessions/browser      → start a browser adapter and register
 *                                    as a tracked session; body:
 *                                    { adapter, port?, camofoxPort?, label?,
 *                                      location?, baseUrl?, binPath? }
 *                                    (requires `resolveBrowserAdapter` wired)
 */
/** Parse the `orchestrator` body field on `POST /sessions/agent` — the
 *  same flexible `boolean | object` shape the MCP `agent_start` tool's
 *  `jsonTolerant` schema accepts, including a JSON-stringified form of
 *  either (some HTTP clients serialize nested fields as strings the
 *  same way the MCP-over-stdio clients that motivated `jsonTolerant`
 *  do). Malformed values are dropped (undefined) rather than 400'd —
 *  matches this route's existing lenient body-field parsing. */
function parseOrchestratorField(
  raw: unknown,
): boolean | { tools?: string[]; maxDepth?: number; maxChildren?: number } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (typeof value === "boolean") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const tools = Array.isArray(obj.tools)
      ? obj.tools.filter((t): t is string => typeof t === "string")
      : undefined
    const maxDepth = typeof obj.maxDepth === "number" ? obj.maxDepth : undefined
    const maxChildren = typeof obj.maxChildren === "number" ? obj.maxChildren : undefined
    return {
      ...(tools ? { tools } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxChildren !== undefined ? { maxChildren } : {}),
    }
  }
  return undefined
}

/** Parse the `worktree` body field — the same `boolean | { slug?, base? }`
 *  shape the MCP tool accepts, tolerant of a JSON-stringified value and a
 *  stringified boolean (see `parseOrchestratorField`). An object is reduced
 *  to only its recognised string keys; anything unparseable ⇒ undefined. */
function parseWorktreeField(raw: unknown): WorktreeField | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) ?? raw : raw
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const slug = typeof obj.slug === "string" ? obj.slug : undefined
    const base = typeof obj.base === "string" ? obj.base : undefined
    const async = typeof obj.async === "boolean" ? obj.async : undefined
    return {
      ...(slug !== undefined ? { slug } : {}),
      ...(base !== undefined ? { base } : {}),
      ...(async !== undefined ? { async } : {}),
    }
  }
  return undefined
}

/** Parse the `mcpServers` body field — the same `AcpMcpServer[]` shape
 *  the MCP tool accepts, tolerant of a JSON-stringified array (see
 *  `parseOrchestratorField`). Entries missing a valid `name`/`transport`
 *  are dropped rather than failing the whole array. */
function parseMcpServersField(raw: unknown): AcpMcpServer[] | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!Array.isArray(value)) return undefined
  const servers: AcpMcpServer[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.name !== "string") continue
    if (o.transport !== "stdio" && o.transport !== "http" && o.transport !== "sse") continue
    servers.push({
      name: o.name,
      transport: o.transport,
      ...(typeof o.ref === "string" ? { ref: o.ref } : {}),
    })
  }
  return servers
}

/** Parse the `options` body field — the same manifest-declared option
 *  id → value map (AIP-45 `options`, e.g. claude-code/claude-sdk's
 *  `base_url`/`auth_token`) the MCP `agent_start` tool accepts, tolerant of
 *  a JSON-stringified object (see `parseOrchestratorField`). Non-primitive
 *  values are dropped rather than failing the whole map — `composeSpawn`
 *  validates the survivors against each option's declared type. */
function parseOptionsField(
  raw: unknown,
): Record<string, boolean | number | string> | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, boolean | number | string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      out[k] = v
    }
  }
  return out
}

/** Parse the `auth` body field — `{ mode?, token?, apiKey? }`, tolerant of a
 *  JSON-stringified object (see `parseOrchestratorField`). Deliberately
 *  narrow: only the known keys survive, so an unrelated stray field can't
 *  smuggle anything unexpected into the resolved spawn config. */
function parseAuthField(
  raw: unknown,
): { mode?: "subscription" | "api-key"; token?: string; apiKey?: string } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const mode = obj.mode === "subscription" || obj.mode === "api-key" ? obj.mode : undefined
  const token = typeof obj.token === "string" ? obj.token : undefined
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : undefined
  return {
    ...(mode ? { mode } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

function parseRouteField(raw: unknown): { gateway: string; baseUrl?: string } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.gateway !== "string" || obj.gateway.length === 0) return undefined
  return {
    gateway: obj.gateway,
    ...(typeof obj.baseUrl === "string" && obj.baseUrl.length > 0 ? { baseUrl: obj.baseUrl } : {}),
  }
}

function parseAccessField(raw: unknown): { profileRef?: string } | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const profileRef = (value as Record<string, unknown>).profileRef
  return typeof profileRef === "string" && profileRef.length > 0 ? { profileRef } : {}
}

/** Parse the `restartPolicy` body field on `POST /sessions/agent` — the HTTP
 *  twin of the MCP `agent_start` tool's `restartPolicy` field (restart-
 *  scheduler PR-2). Tolerates a JSON-stringified object (see
 *  `parseOrchestratorField`). All six required fields must parse to their
 *  expected primitive type or the whole field is dropped (`undefined`) —
 *  never a partial/malformed policy that would silently misbehave. */
function parseRestartPolicyField(raw: unknown): RestartPolicy | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const on = Array.isArray(obj.on)
    ? obj.on.filter((v): v is "crashed" | "error" => v === "crashed" || v === "error")
    : undefined
  const maxRetries = typeof obj.maxRetries === "number" ? obj.maxRetries : undefined
  const windowMs = typeof obj.windowMs === "number" ? obj.windowMs : undefined
  const baseDelayMs = typeof obj.baseDelayMs === "number" ? obj.baseDelayMs : undefined
  const factor = typeof obj.factor === "number" ? obj.factor : undefined
  const maxDelayMs = typeof obj.maxDelayMs === "number" ? obj.maxDelayMs : undefined
  if (
    !on ||
    on.length === 0 ||
    maxRetries === undefined ||
    windowMs === undefined ||
    baseDelayMs === undefined ||
    factor === undefined ||
    maxDelayMs === undefined
  ) {
    return undefined
  }
  const resume = typeof obj.resume === "boolean" ? obj.resume : undefined
  return {
    on,
    maxRetries,
    windowMs,
    baseDelayMs,
    factor,
    maxDelayMs,
    ...(resume !== undefined ? { resume } : {}),
  }
}

/** Parse the `sandbox` body field — a provider slug string (e.g. `"e2b"`) or
 *  an inline `SandboxSpecInput` object, optionally carrying `reuse:
 *  "<sandboxId>"` for the reconnect path. Tolerates a JSON-stringified value.
 *
 *  The inline object is validated against the SAME `sandboxSpecWithReuseSchema`
 *  the MCP `agent_start` tool uses, and the WHOLE validated spec is forwarded.
 *  The previous hand-rolled version pulled out only `provider`/`config`/`reuse`
 *  and silently dropped `extraPorts`, `env` (passthrough/auth), `lifecycle`,
 *  and everything else — so a box booted via HTTP came up with no ports and no
 *  secrets while the identical MCP call worked (the #1150 regression). An
 *  object that fails validation yields `undefined` (the caller then spawns
 *  with no sandbox) rather than a half-populated spec. */
function parseSandboxField(raw: unknown): string | SandboxSpecInput | undefined {
  const value = typeof raw === "string" ? tryParseJson(raw) ?? raw : raw
  if (typeof value === "string" && value.length > 0) return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  // `config` is required by the schema; default it so a minimal `{provider}`
  // spec still validates (matching the prior tolerant behaviour) while every
  // other field flows through the schema untouched.
  const candidate = { config: {}, ...(value as Record<string, unknown>) }
  const parsed = sandboxSpecWithReuseSchema.safeParse(candidate)
  if (!parsed.success) return undefined
  return parsed.data as SandboxSpecInput
}

/**
 * Reverse-map a cwd onto a registered workspace slug — the same rule
 * spawnAgentSession applies (session-spawn.ts), hoisted here so the terminal
 * and raw spawn paths agree with the agent path.
 *
 * Why: a SessionDescriptor carries only `workspaceSlug`, and until this existed
 * only POST /sessions/agent derived it from cwd. Every other spawn path dumped
 * the session into "default" even when its cwd sat inside a registered
 * workspace — measured at 160/209 sessions on one real daemon — which made the
 * slug useless as a grouping key for any client.
 *
 * Never throws: an unreadable/absent registry yields undefined and the caller
 * keeps its "default".
 */
async function resolveSlugFromCwd(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined
  try {
    const config = await loadWorkspacesConfig()
    return findWorkspaceByPath(config, cwd)?.slug
  } catch {
    return undefined
  }
}

async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
  resolveAgentAdapter?: AgentAdapterResolver,
  ptyEnabled = false,
  resolveBrowserAdapter?: BrowserAdapterResolver,
  listBrowserAdapters?: BrowserAdapterLister,
  sessionEvents?: SessionEventBus,
  eventRing?: EventRing,
  buildOrchestratorMcp?: BuildOrchestratorMcp,
  daemonMcpUrl?: string,
  provisionWorktree?: WorktreeProvisioner,
  listCatalogModels?: CatalogModelsLister,
  resolveSandboxProvider?: SpawnAgentSessionDeps["resolveSandboxProvider"],
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/sessions" && req.method === "GET") {
    // ?includeArchived=true opts into the rows session_archive hides by
    // default (the VSCode extension's "show archived" tree toggle).
    const reqUrl = req.url ?? ""
    const queryString = reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : ""
    const params = new URLSearchParams(queryString)
    const includeArchived = params.get("includeArchived") === "true"
    const kindParam = params.get("kind")
    const includeCommands = params.get("includeCommands") === "true"
    let rows = registry.list({ includeArchived })
    // Same default-view semantics as the `session_list` MCP tool: a
    // `kind:"command"` row is a shell-execution LOG (already reachable via
    // `command_list` / `?kind=command`), not a resumable session, so it's
    // excluded from the default (unfiltered / `?kind=all`) view unless
    // `?includeCommands=true` opts into the union.
    if (kindParam && kindParam !== "all") {
      rows = rows.filter(s => s.kind === kindParam)
    } else if (!includeCommands) {
      rows = rows.filter(s => s.kind !== "command")
    }
    json(200, { sessions: rows })
    return true
  }

  if (path === "/sessions/summaries" && req.method === "GET") {
    // Lightweight, paginated panel projection of list(). Query params:
    //   includeArchived=true  (default false)
    //   limit=N               (default 50, clamped to [1,200])
    //   offset=N              (default 0, min 0)
    const reqUrl = req.url ?? ""
    const queryString = reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : ""
    const params = new URLSearchParams(queryString)
    const includeArchived = params.get("includeArchived") === "true"
    const limit = Number.parseInt(params.get("limit") ?? "", 10)
    const offset = Number.parseInt(params.get("offset") ?? "", 10)
    const result = registry.listSummaries({
      includeArchived,
      limit: Number.isNaN(limit) ? undefined : limit,
      offset: Number.isNaN(offset) ? undefined : offset,
    })
    json(200, result)
    return true
  }

  // GET /usage/rollup?window=<w>&profileRef=<ref>&probe=<bool> — local-derived,
  // provider-agnostic spend estimate over a rolling window, aggregated from the
  // durable per-session usage_snapshot records. Full daemon view (REST has no
  // callerScope / subtree scoping). Same collector + reducer the `usage_rollup`
  // MCP tool uses, so the two surfaces can't drift. `probe=true` opts into a
  // live provider refresh of `byProfile[].remaining` (default: side-effect-free,
  // last-seen only).
  if (path === "/usage/rollup" && req.method === "GET") {
    const reqUrl = req.url ?? ""
    const queryString = reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : ""
    const params = new URLSearchParams(queryString)
    const window = params.get("window") ?? ""
    const profileRef = params.get("profileRef") ?? undefined
    const probe = params.get("probe") === "true"
    const parsed = parseWindow(window)
    if ("error" in parsed) {
      json(400, { error: "invalid_window", message: parsed.error })
      return true
    }
    const sessions = await collectSessionSnapshots(
      registry,
      profileRef ? { profileRef } : {},
    )
    const baseRollup = rollupUsage(sessions, { window, nowMs: Date.now() })
    // Best-effort per-provider "remaining quota" enrichment — never fatal:
    // any failure returns the un-enriched rollup unchanged.
    const rollup = await enrichRollupWithProviderQuota(baseRollup, window, { probe })
    // Best-effort per-provider "account credits" (prepaid balance) enrichment —
    // also never fatal: any failure returns the rollup unchanged.
    const rollupWithCredits = await enrichRollupWithAccountCredits(rollup)
    json(200, rollupWithCredits)
    return true
  }

  // Long-running agent session — spawn via the cli's adapter
  // resolver, hold across multiple turns. Body shape:
  //   {adapter: "claude-code"|"hermes"|...,
  //    workspaceSlug, cwd, prompt?, label?, orchestrator?, mcpServers?}
  // Delegates to the same `spawnAgentSession` the MCP `agent_start`
  // tool uses (session-spawn.ts) — keeps this route from re-implementing
  // (and re-drifting from) the orchestrator/mcpServers/hermes-default
  // logic that lives there.
  if (path === "/sessions/agent" && req.method === "POST") {
    if (!resolveAgentAdapter) {
      json(501, {
        error: "agent_resolver_not_configured",
        message:
          "POST /sessions/agent needs the host to inject `resolveAgentAdapter` " +
          "(e.g. via @agentproto/cli's resolveAdapter shim).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const presetId = typeof b.presetId === "string" && b.presetId.length > 0 ? b.presetId : undefined
    const preset = presetId ? await getUserPreset(presetId) : undefined
    if (presetId && !preset) {
      json(400, { error: "preset_not_found", message: `No user preset "${presetId}" found.` })
      return true
    }
    const adapter = typeof b.adapter === "string" ? b.adapter : (typeof b.harness === "string" ? b.harness : (preset?.adapter ?? preset?.harness ?? ""))
    if (!adapter) {
      json(400, { error: "missing_adapter" })
      return true
    }
    const result = await spawnAgentSession(
      {
        registry,
        resolveAgentAdapter,
        buildOrchestratorMcp,
        daemonMcpUrl,
        ...(provisionWorktree ? { provisionWorktree } : {}),
        ...(listCatalogModels ? { listCatalogModels } : {}),
        ...(resolveSandboxProvider ? { resolveSandboxProvider } : {}),
      },
      buildSpawnSessionHttpArgs(b, adapter, preset),
    )
    if (!result.ok) {
      const status =
        result.code === "adapter_not_found" || result.code === "no_cwd"
          ? 404
          : result.code === "orchestrator_not_enabled"
            ? 501
            : result.code === "orchestrator_max_depth_exceeded" ||
                result.code === "orchestrator_child_quota_exceeded" ||
                result.code === "role_spawn_denied"
              ? 409
            : result.code === "invalid_role" ||
                result.code === "worktree_requires_explicit_repo" ||
                result.code === "access_profile_not_found" ||
                result.code === "access_profile_ineligible"
                ? 400
                : 500
      json(status, {
        error: result.code,
        message: result.message,
        ...result.details,
      })
      return true
    }
    json(201, {
      ...result.descriptor,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.deduped ? { deduped: true } : {}),
      ...(result.dedupeSource ? { dedupeSource: result.dedupeSource } : {}),
    })
    return true
  }

  // POST /sessions/chat — create-style sibling of POST /sessions/:id/chat.
  // Spawns a fresh agent session via the SAME core `/sessions/agent` feeds
  // (`spawnAgentSession`, shared body→args mapper `buildSpawnSessionHttpArgs`)
  // and, unlike /sessions/agent, REQUIRES a `prompt` and immediately bleeds
  // the new session's first turn into the `ai` UI message stream instead of
  // returning a JSON descriptor. Body = the /sessions/agent spawn fields
  // PLUS `prompt` (the opening user message). On success the response is the
  // /sessions/:id/chat SSE stream (first turn), not a 201 descriptor.
  if (path === "/sessions/chat" && req.method === "POST") {
    if (!resolveAgentAdapter) {
      json(501, {
        error: "agent_resolver_not_configured",
        message:
          "POST /sessions/chat needs the host to inject `resolveAgentAdapter` " +
          "(e.g. via @agentproto/cli's resolveAdapter shim).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const chatPrompt = typeof b.prompt === "string" ? b.prompt.trim() : ""
    if (!chatPrompt) {
      json(400, { error: "missing_prompt", message: "body.prompt (non-empty string) is required" })
      return true
    }
    const presetId = typeof b.presetId === "string" && b.presetId.length > 0 ? b.presetId : undefined
    const preset = presetId ? await getUserPreset(presetId) : undefined
    if (presetId && !preset) {
      json(400, { error: "preset_not_found", message: `No user preset "${presetId}" found.` })
      return true
    }
    const adapter =
      typeof b.adapter === "string"
        ? b.adapter
        : typeof b.harness === "string"
          ? b.harness
          : preset?.adapter ?? preset?.harness ?? ""
    if (!adapter) {
      json(400, { error: "missing_adapter" })
      return true
    }
    const result = await spawnAgentSession(
      {
        registry,
        resolveAgentAdapter,
        buildOrchestratorMcp,
        daemonMcpUrl,
        ...(provisionWorktree ? { provisionWorktree } : {}),
        ...(listCatalogModels ? { listCatalogModels } : {}),
        ...(resolveSandboxProvider ? { resolveSandboxProvider } : {}),
      },
      buildSpawnSessionHttpArgs(b, adapter, preset),
    )
    if (!result.ok) {
      const status =
        result.code === "adapter_not_found" || result.code === "no_cwd"
          ? 404
          : result.code === "orchestrator_not_enabled"
            ? 501
            : result.code === "orchestrator_max_depth_exceeded" ||
                result.code === "orchestrator_child_quota_exceeded" ||
                result.code === "role_spawn_denied"
              ? 409
              : result.code === "invalid_role" ||
                  result.code === "worktree_requires_explicit_repo" ||
                  result.code === "access_profile_not_found" ||
                  result.code === "access_profile_ineligible"
                ? 400
                : 500
      json(status, {
        error: result.code,
        message: result.message,
        ...result.details,
      })
      return true
    }
    const id = result.descriptor.id
    // `since` edge is 0 (a fresh session has no prior turn history), but the
    // replay must tolerate the spawn already having flushed early records.
    const since = await currentTranscriptSeq(id)
    const stream = startAiUiMessageStream({
      res,
      since,
      diskRecords: transcriptDiskRecords(id),
      subscribe: onRecord => registry.subscribeToRecords(id, onRecord),
      map: createTranscriptToUiMapper(id),
    })
    req.once("close", () => stream.disconnect())
    await stream.done
    return true
  }

  // Browser service session — start the adapter and register as a tracked
  // session. HTTP equivalent of the MCP `start_browser` tool.
  // Body: { adapter: string, port?: number, camofoxPort?: number, label?: string,
  //         location?: "local"|"cloud", baseUrl?: string, binPath?: string }
  if (path === "/sessions/browser" && req.method === "POST") {
    if (!resolveBrowserAdapter) {
      json(501, {
        error: "browser_resolver_not_configured",
        message:
          "POST /sessions/browser needs the host to inject `resolveBrowserAdapter` " +
          "(e.g. via `agentproto serve`).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const adapterId = typeof b.adapter === "string" ? b.adapter : ""
    if (!adapterId) {
      json(400, { error: "missing_adapter" })
      return true
    }
    const rawPort = b.port
    if (rawPort !== undefined) {
      const p = typeof rawPort === "number" ? rawPort : Number(rawPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        json(400, {
          error: "invalid_port",
          message: `port must be an integer in range 1–65535 (got ${JSON.stringify(rawPort)})`,
        })
        return true
      }
    }
    const rawCamofoxPort = b.camofoxPort
    if (rawCamofoxPort !== undefined) {
      const p = typeof rawCamofoxPort === "number" ? rawCamofoxPort : Number(rawCamofoxPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        json(400, {
          error: "invalid_camofox_port",
          message: `camofoxPort must be an integer in range 1–65535 (got ${JSON.stringify(rawCamofoxPort)})`,
        })
        return true
      }
    }
    const adapter = resolveBrowserAdapter(adapterId)
    if (!adapter) {
      const available = listBrowserAdapters
        ? listBrowserAdapters()
            .map(a => a.id)
            .join(", ")
        : "camofox, bureau"
      json(404, {
        error: "adapter_not_found",
        adapter: adapterId,
        message: `Browser adapter "${adapterId}" not found. Available: ${available}.`,
      })
      return true
    }
    const rawLocation = b.location
    if (rawLocation !== undefined && rawLocation !== "local" && rawLocation !== "cloud") {
      json(400, {
        error: "invalid_location",
        message: `location must be "local" or "cloud" (got ${JSON.stringify(rawLocation)})`,
      })
      return true
    }
    const location = rawLocation as "local" | "cloud" | undefined
    const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl : undefined
    const binPath = typeof b.binPath === "string" ? b.binPath : undefined
    try {
      const instance = await adapter.ensure({
        port: typeof b.port === "number" ? b.port : undefined,
        camofoxPort: typeof b.camofoxPort === "number" ? b.camofoxPort : undefined,
        location,
        baseUrl,
        binPath,
        initialWaitMs: 6_000,
      })
      const desc = registry.registerBrowser({
        adapterId: instance.id,
        port: instance.port,
        baseUrl: instance.baseUrl,
        location: location ?? adapter.location,
        pid: instance.pid,
        wasAlreadyRunning: instance.wasAlreadyRunning,
        status: instance.healthy ? "running" : "starting",
        stop: instance.stop.bind(instance),
        label: typeof b.label === "string" ? b.label : undefined,
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "browser_start_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Long-running PTY session — spawn argv under node-pty. Bytes flow
  // through the registry's byte ring buffer; attach via the WebSocket
  // upgrade at /sessions/:id/pty. Body shape:
  //   {argv: string[], cwd?, workspaceSlug?, cols, rows, env?, name?, label?}
  if (path === "/sessions/terminal" && req.method === "POST") {
    if (!ptyEnabled) {
      json(501, {
        error: "pty_not_configured",
        message:
          "POST /sessions/terminal needs the host to inject `spawnPty` into createGateway " +
          "(node-pty optional dep — install in @agentproto/cli).",
      })
      return true
    }
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const argv = Array.isArray(b.argv)
      ? (b.argv as unknown[]).filter((v): v is string => typeof v === "string")
      : []
    if (argv.length === 0) {
      json(400, { error: "missing_argv" })
      return true
    }
    const cols = typeof b.cols === "number" && b.cols > 0 ? Math.floor(b.cols) : 80
    const rows = typeof b.rows === "number" && b.rows > 0 ? Math.floor(b.rows) : 24
    // cwd resolution mirrors /sessions/agent exactly.
    let cwd: string | null =
      typeof b.cwd === "string" && b.cwd.length > 0 ? b.cwd : null
    let workspaceSlug =
      typeof b.workspaceSlug === "string" ? b.workspaceSlug : ""
    if (!cwd) {
      try {
        const config = await loadWorkspacesConfig()
        const ws = workspaceSlug
          ? findWorkspace(config, workspaceSlug)
          : getActiveWorkspace(config)
        if (ws) {
          cwd = ws.path
          workspaceSlug = ws.slug
        }
      } catch {
        // fall through to process.cwd()
      }
    }
    if (!cwd) {
      cwd = process.cwd()
      console.warn(
        `[/sessions/terminal] no cwd resolvable for argv=${argv.join(" ")} ` +
          `— falling back to daemon's cwd ${cwd}`
      )
    }
    if (!workspaceSlug) {
      // cwd given (or defaulted) but no explicit slug — reverse-map it, exactly
      // as spawnAgentSession does (session-spawn.ts). Without this a terminal
      // whose cwd sits inside a registered workspace still lands in "default",
      // so it can never be grouped or filtered by project.
      workspaceSlug = (await resolveSlugFromCwd(cwd)) ?? "default"
    }
    try {
      const desc = registry.spawnPty({
        argv,
        cwd,
        workspaceSlug,
        cols,
        rows,
        ...(b.env && typeof b.env === "object"
          ? { env: b.env as Record<string, string> }
          : {}),
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
      })
      json(201, desc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("already in use")
        ? 409
        : msg.includes("no PTY factory")
          ? 501
          : 500
      json(status, { error: "pty_spawn_failed", message: msg })
    }
    return true
  }

  // Send a follow-up turn to a live agent session.
  // Body: { prompt: string | ContentBlock | ContentBlock[], interrupt?: boolean, queue?: boolean, force?: boolean }
  //   - string                → auto-wrapped to a single text block by
  //                             the registry (legacy / convenience).
  //   - ContentBlock          → e.g. `{type:"image", source:{...}}`
  //   - ContentBlock[]        → text + image mix for multimodal turns.
  //                             Forwarded as-is to `agentSession.send`
  //                             so the adapter (claude-agent-acp, …)
  //                             negotiates its own content shape.
  //   - interrupt             → when true and the session is mid-turn,
  //                             cancel the in-flight turn and deliver
  //                             this prompt on the same session instead
  //                             of the usual mid-turn rejection. No-op
  //                             on an idle session. Default false.
  //   - queue                 → when true and the session is mid-turn
  //                             (and `interrupt` didn't already settle
  //                             it), append this prompt to the
  //                             session's FIFO instead of the usual
  //                             mid-turn rejection — dispatched once
  //                             the current (and any earlier-queued)
  //                             turns finish. No-op on an idle session.
  //                             Default false — omitted reproduces the
  //                             busy rejection byte-for-byte.
  //   - force                 → only meaningful alongside `queue`:
  //                             insert at the FRONT of the FIFO instead
  //                             of the back, jumping everything already
  //                             waiting WITHOUT touching the live turn
  //                             (that's `interrupt`'s job). Default false.
  //
  // Validation is intentionally loose — we accept anything object-
  // shaped + non-empty arrays + non-empty strings. The adapter will
  // reject ill-formed blocks with a clear error projected into the
  // session's ring buffer; throwing here would just duplicate that.
  //
  // Query: ?wait=false → fire-and-forget (return 202 after sync
  //   validation; output streams via /sessions/:id/stream). Default
  //   wait=true keeps the call blocking until the turn drains, which
  //   is what curl scripts + the MCP bridge expect. `interrupt` /
  //   `queue` / `force` only take effect on this fire-and-forget arm
  //   (mirroring MCP `agent_prompt`, which always calls `enqueuePrompt`).
  const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompt$/)
  if (promptMatch && req.method === "POST") {
    const id = promptMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const prompt = (body as { prompt?: unknown } | null)?.prompt
    const interrupt = (body as { interrupt?: unknown } | null)?.interrupt === true
    const queue = (body as { queue?: unknown } | null)?.queue === true
    const force = (body as { force?: unknown } | null)?.force === true
    const validPrompt =
      (typeof prompt === "string" && prompt.length > 0) ||
      (Array.isArray(prompt) &&
        prompt.length > 0 &&
        prompt.every(b => b !== null && typeof b === "object")) ||
      (prompt !== null && typeof prompt === "object" && !Array.isArray(prompt))
    if (!validPrompt) {
      json(400, {
        error: "missing_prompt",
        message:
          "Body `prompt` must be a non-empty string, a content block object, or an array of content blocks.",
      })
      return true
    }
    const reqUrl = req.url ?? ""
    const queryString = reqUrl.includes("?")
      ? reqUrl.slice(reqUrl.indexOf("?") + 1)
      : ""
    const wait = new URLSearchParams(queryString).get("wait")
    const fireAndForget = wait === "false" || wait === "0"
    try {
      if (fireAndForget) {
        // Awaited: enqueuePrompt only resolves once the resume attempt
        // (if any) + admission checks pass — a dead or busy session
        // rejects here, before the 202 goes out, instead of us
        // reporting `queued: true` for a prompt nothing will dispatch.
        // `interrupt: true` lets a mid-turn session redirect instead of
        // rejecting — see `SessionsRegistry.enqueuePrompt`'s doc comment.
        // `queueId` is minted here (not by the registry) so it can be
        // echoed straight back in the response below without a second
        // round-trip to read the descriptor back for it.
        const queueId = queue ? `q_${randomUUID().slice(0, 8)}` : undefined
        // `origin: "user"` labels a queued item as coming from the human/
        // operator surface (POST /sessions/:id/prompt — the CLI, the VS Code
        // panel, curl). It only affects the after-the-fact queue origin
        // badge; transcript provenance is untouched (`source` is not set).
        await registry.enqueuePrompt(id, prompt, { interrupt, queue, force, queueId, origin: "user" })
        const promptQueue = queueId ? registry.get(id)?.promptQueue : undefined
        const queuePosition = promptQueue?.findIndex(p => p.id === queueId) ?? -1
        json(202, {
          ok: true,
          id,
          queued: true,
          // Present only when this prompt actually landed in the FIFO
          // (busy + `queue: true`) rather than dispatching immediately —
          // an idle session's `queueId` never appears in `promptQueue`,
          // so `queuePosition` stays -1 and this is omitted.
          ...(queuePosition >= 0
            ? { pending: true, queueId, queuePosition: queuePosition + 1 }
            : {}),
        })
      } else {
        // `interrupt` used to be parsed and then silently DROPPED on this
        // arm — it only took effect under ?wait=false. A caller asking to
        // redirect a mid-turn session got the busy 409 it explicitly asked
        // not to get. Both arms now honour it identically. `queue`/`force`
        // are NOT supported here — a blocking caller can't be told "your
        // prompt is waiting" without a second read; use ?wait=false.
        await registry.sendPrompt(id, prompt, { interrupt })
        json(200, { ok: true, id })
      }
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        json(409, { error: "session_not_alive", status: err.status })
        return true
      }
      const msg = err instanceof Error ? err.message : String(err)
      // Differentiate "not found" / "wrong kind" / "busy" — they
      // surface as readable thrown messages from the registry.
      const status = msg.includes("no session")
        ? 404
        : msg.includes("not an agent")
          ? 400
          : msg.includes("mid-turn")
            ? 409
            : 500
      json(status, { error: "send_prompt_failed", message: msg })
    }
    return true
  }

  // Cancel one not-yet-dispatched item in a session's prompt FIFO before
  // it fires — the composer's per-item "remove" action. Idempotent: an
  // id that's already gone (dispatched, already removed, or never
  // existed) still returns 200 with `removed: false` rather than 404 —
  // same no-op-is-not-an-error shape as `POST /sessions/:id/interrupt`.
  const queueItemMatch = path.match(/^\/sessions\/([^/]+)\/queue\/([^/]+)$/)
  if (queueItemMatch && req.method === "DELETE") {
    const id = queueItemMatch[1]
    const queueId = queueItemMatch[2]
    if (!id || !queueId) return false
    const { removed } = registry.removeQueuedPrompt(id, queueId)
    json(200, { ok: true, id, queueId, removed })
    return true
  }
  // Promote an already-queued item to the FRONT without touching the
  // in-flight turn — the reorder-only force (`session_queue_promote`). The
  // after-the-fact counterpart of the enqueue-time `force` opt.
  const queuePromoteMatch = path.match(/^\/sessions\/([^/]+)\/queue\/([^/]+)\/promote$/)
  if (queuePromoteMatch && req.method === "POST") {
    const id = queuePromoteMatch[1]
    const queueId = queuePromoteMatch[2]
    if (!id || !queueId) return false
    const result = registry.promoteQueuedPrompt(id, queueId)
    if (!result.promoted) {
      json(404, { error: "queued_item_not_found", id, queueId })
      return true
    }
    json(200, { ok: true, id, queueId, position: result.position })
    return true
  }
  // Deliver-now: interrupt whatever's mid-flight and dispatch THIS item as
  // the new turn (`session_queue_deliver`). The "I need this NOW" op.
  const queueDeliverMatch = path.match(/^\/sessions\/([^/]+)\/queue\/([^/]+)\/deliver$/)
  if (queueDeliverMatch && req.method === "POST") {
    const id = queueDeliverMatch[1]
    const queueId = queueDeliverMatch[2]
    if (!id || !queueId) return false
    try {
      const result = await registry.deliverQueuedPrompt(id, queueId)
      if (!result.delivered) {
        json(404, { error: "queued_item_not_found", id, queueId })
        return true
      }
      json(200, { ok: true, id, queueId, interrupted: result.interrupted })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(msg.includes("no session") ? 404 : 409, { error: "deliver_queued_failed", message: msg })
    }
    return true
  }
  // Inspect the queue after the fact — GET /sessions/:id/queue returns the
  // ordered list (origin, preview, queuedAt, position). 0 = next to dispatch.
  const queueListMatch = path.match(/^\/sessions\/([^/]+)\/queue$/)
  if (queueListMatch && req.method === "GET") {
    const id = queueListMatch[1]
    if (!id) return false
    const queue = registry.listQueuedPrompts(id)
    if (queue === null) {
      json(404, { error: "no_such_session", id })
      return true
    }
    json(200, { ok: true, id, queue })
    return true
  }

  // Cancel the in-flight turn on a live agent session and leave the
  // session itself alive and idle — the bare "interrupt, no next prompt"
  // primitive `POST /sessions/:id/prompt`'s own `interrupt` option lacks,
  // since that option always redirects onto a NEW prompt. See
  // `SessionsRegistry.interruptSession`'s doc comment for the full
  // idempotency contract (idle/terminal/unknown-but-alive all no-op).
  const interruptMatch = path.match(/^\/sessions\/([^/]+)\/interrupt$/)
  if (interruptMatch && req.method === "POST") {
    const id = interruptMatch[1]
    if (!id) return false
    try {
      const { wasBusy } = await registry.interruptSession(id)
      json(200, { ok: true, id, wasBusy })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "does not support interrupt" is a state/capability refusal (the
      // adapter's cancel() itself rejected) — not a server fault.
      const status = msg.includes("no session")
        ? 404
        : msg.includes("does not support interrupt")
          ? 409
          : 500
      json(status, { error: "interrupt_failed", message: msg })
    }
    return true
  }

  // Write raw input into a live PTY/terminal session — the terminal-view
  // sibling of `POST /sessions/:id/prompt` (which is agent-cli only and 400s
  // for kind=terminal, so the transcript composer can't reply on a terminal
  // through it). Mirrors the MCP `terminal_input` verb: the `text` is written
  // verbatim, then — unless `enter:false` — a LONE `\r` is written in a
  // SECOND, separate write so paste-detecting TUIs (Claude Code in bracketed-
  // paste mode) see the CR as the Enter key (submit) rather than a trailing
  // pasted newline. Body: { text: string, enter?: boolean (default true) }.
  const terminalInputMatch = path.match(/^\/sessions\/([^/]+)\/terminal\/input$/)
  if (terminalInputMatch && req.method === "POST") {
    const id = terminalInputMatch[1]
    if (!id) return false
    if (!ptyEnabled) {
      json(501, {
        error: "pty_not_configured",
        message:
          "POST /sessions/:id/terminal/input needs the host to inject `spawnPty` into createGateway " +
          "(node-pty optional dep — install in @agentproto/cli).",
      })
      return true
    }
    const desc = registry.get(id)
    if (!desc) {
      json(404, { error: "no_session", message: `no session "${id}"` })
      return true
    }
    const body = await readJsonBody(req)
    const text = (body as { text?: unknown } | null)?.text
    if (typeof text !== "string") {
      json(400, { error: "missing_text", message: "Body `text` must be a string." })
      return true
    }
    if (desc.kind !== "terminal" || desc.pty !== true) {
      json(400, {
        error: "not_a_pty",
        message: `session "${id}" is not a live PTY (kind=${desc.kind})`,
      })
      return true
    }
    const enter = (body as { enter?: unknown } | null)?.enter !== false
    let ok = true
    if (text.length > 0) ok = registry.writeTerminalInput(id, text) && ok
    if (enter) ok = registry.writeTerminalInput(id, "\r") && ok
    if (!ok) {
      json(400, {
        error: "not_a_pty",
        message: `session "${id}" has no live PTY to write to`,
      })
      return true
    }
    json(200, { ok: true })
    return true
  }

  // Switch the model on a LIVE agent-cli session without restarting it —
  // see `SessionsRegistry.setModel`'s doc comment for the full dispatch
  // (config/command/arg apply strategies) + event-emission contract. A
  // structured `{applied:false, reason}` (unsupported strategy, agent
  // rejected the id, no live driver support) is still a 200 — the request
  // was well-formed and got a definitive answer, it's just not "yes".
  const modelMatch = path.match(/^\/sessions\/([^/]+)\/model$/)
  if (modelMatch && req.method === "POST") {
    const id = modelMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const model =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).model === "string"
        ? ((body as Record<string, unknown>).model as string)
        : undefined
    if (!model) {
      json(400, { error: "missing_model" })
      return true
    }
    try {
      const result = await registry.setModel(id, model)
      json(200, { ok: true, id, ...result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("no session")
        ? 404
        : msg.includes("not an agent-cli session")
          ? 400
          : 500
      json(status, { error: "set_model_failed", message: msg })
    }
    return true
  }

  // Restart-with-override (SPEC §4.3, step 6) — the single HTTP path for all
  // four restart-only axes (incl. access/auth-profile). Body carries the same
  // optional axis overrides as the `session_restart` MCP verb; each present
  // axis overlays the prior session, an omitted one is carried forward. Always
  // forces the agent-cli resume path (auth re-resolution + fresh descriptor),
  // so it only applies to agent-cli sessions. An unknown/ineligible access
  // profile (SPEC Rx/Ry) is a real 400, never a silent wallet swap.
  const restartMatch = path.match(/^\/sessions\/([^/]+)\/restart$/)
  if (restartMatch && req.method === "POST") {
    const id = restartMatch[1]
    if (!id) return false
    if (!resolveAgentAdapter) {
      json(501, {
        error: "restart_not_enabled",
        message:
          "POST /sessions/:id/restart needs the host to inject `resolveAgentAdapter`.",
      })
      return true
    }
    const prev = registry.findByIdOrName(id)
    if (!prev) {
      json(404, { error: "no_session", message: `no session "${id}" found` })
      return true
    }
    if (!prev.adapterSlug) {
      json(400, {
        error: "restart_override_invalid",
        message:
          "restart-with-override only applies to agent-cli sessions " +
          "(a PTY/command session has no config axes to override).",
      })
      return true
    }
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
    const b = body && typeof body === "object" ? body : {}
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
    const overrides: RestartOverrides = {
      ...(str(b.model) !== undefined ? { model: str(b.model)! } : {}),
      ...(str(b.effort) !== undefined ? { effort: str(b.effort) as RestartOverrides["effort"] } : {}),
      ...(b.access && typeof b.access === "object" &&
      str((b.access as Record<string, unknown>).profileRef) !== undefined
        ? { access: { profileRef: str((b.access as Record<string, unknown>).profileRef)! } }
        : {}),
      ...(b.route && typeof b.route === "object" &&
      str((b.route as Record<string, unknown>).gateway) !== undefined
        ? {
            route: {
              gateway: str((b.route as Record<string, unknown>).gateway)!,
              ...(str((b.route as Record<string, unknown>).baseUrl) !== undefined
                ? { baseUrl: str((b.route as Record<string, unknown>).baseUrl)! }
                : {}),
            },
          }
        : {}),
      ...(b.posture !== undefined ? { posture: b.posture as RestartOverrides["posture"] } : {}),
      ...(str(b.contextProfile) !== undefined ? { contextProfile: str(b.contextProfile)! } : {}),
      ...(str(b.mode) !== undefined ? { mode: str(b.mode)! } : {}),
    }
    try {
      const restarted = await restartAgentSession(registry, resolveAgentAdapter, prev, {
        forceAgentResume: true,
        overrides,
        ...(listCatalogModels ? { listCatalogModels } : {}),
      })
      json(200, {
        ...restarted.desc,
        resumedFrom: restarted.resumedFrom,
        resumeVia: restarted.resumeVia,
        ...(restarted.resumeFallback ? { resumeFallback: true } : {}),
      })
    } catch (err) {
      if (err instanceof RestartOverrideError) {
        json(err.status, { error: err.code, message: err.message, sessionId: prev.id })
        return true
      }
      json(500, {
        error: "restart_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Switch the reasoning/compute budget (effort) on a LIVE agent-cli session —
  // the effort-axis sibling of `POST /sessions/:id/model` (SPEC §4.2, step 5).
  // See `SessionsRegistry.setEffort`. Effort is model-dependent (SPEC §3.9); a
  // label the current model rejects is a well-formed `{applied:false, reason}`
  // (still 200 — the request got a definitive answer, just not "yes").
  const effortMatch = path.match(/^\/sessions\/([^/]+)\/effort$/)
  if (effortMatch && req.method === "POST") {
    const id = effortMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const effort =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).effort === "string"
        ? ((body as Record<string, unknown>).effort as string)
        : undefined
    if (!effort) {
      json(400, { error: "missing_effort" })
      return true
    }
    try {
      const result = await registry.setEffort(id, effort)
      json(200, { ok: true, id, ...result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("no session")
        ? 404
        : msg.includes("not an agent-cli session")
          ? 400
          : 500
      json(status, { error: "set_effort_failed", message: msg })
    }
    return true
  }

  // Switch the posture on a LIVE agent-cli session (SPEC §4.2/§3.4a, step 5).
  // A posture that maps to a native advertised harness mode switches live via
  // ACP `setSessionMode`; one with no native mode returns
  // `{applied:false, reason:"requires-restart"}` (still 200 — the caller routes
  // it through the restart-override, step 6). The wire `posture` string is a
  // canonical vocabulary value (`plan`/`bypass`/…) or a raw harness mode id;
  // `parsePostureInput` picks which.
  const postureMatch = path.match(/^\/sessions\/([^/]+)\/posture$/)
  if (postureMatch && req.method === "POST") {
    const id = postureMatch[1]
    if (!id) return false
    const body = await readJsonBody(req)
    const postureRaw =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).posture === "string"
        ? ((body as Record<string, unknown>).posture as string)
        : undefined
    if (!postureRaw) {
      json(400, { error: "missing_posture" })
      return true
    }
    try {
      const result = await registry.setPosture(id, parsePostureInput(postureRaw))
      json(200, { ok: true, id, ...result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("no session")
        ? 404
        : msg.includes("not an agent-cli session")
          ? 400
          : 500
      json(status, { error: "set_posture_failed", message: msg })
    }
    return true
  }

  // Rename a session — set or clear its user-facing `title`/`label` (SPEC-3
  // FIX B write-path). The ONLY session mutation route that isn't a POST: it's
  // a partial update of the descriptor's display fields, so PATCH. Body:
  // `{ title?: string | null, label?: string | null }` — a string sets (the
  // registry trims + caps), `null` or `""` clears (reverts to derived/
  // fallback), an omitted key leaves that field untouched. Persist + the
  // `session:renamed` event are the registry's job. 404 on an unknown id.
  const renameMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (renameMatch && req.method === "PATCH") {
    const rawIdOrName = renameMatch[1]
    if (!rawIdOrName) return false
    const resolved = registry.findByIdOrName(rawIdOrName)
    if (!resolved) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    // A present key with a string OR explicit null is honoured; any other
    // type (number, object) is ignored rather than 400 — a well-formed
    // rename should never fail because an unrelated stray field rode along.
    const field = (v: unknown): string | null | undefined =>
      typeof v === "string" ? v : v === null ? null : undefined
    const patch: { title?: string | null; label?: string | null } = {
      ...("title" in b ? { title: field(b.title) } : {}),
      ...("label" in b ? { label: field(b.label) } : {}),
    }
    try {
      const desc = registry.renameSession(resolved.id, patch)
      json(200, desc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(msg.includes("no session") ? 404 : 500, { error: "rename_failed", message: msg })
    }
    return true
  }

  // Bulk garbage-collect terminal-status sessions — the HTTP twin of the
  // `session_gc` MCP verb, powering `agentproto sessions gc`. Body:
  // `{ olderThanDays?: number, forget?: boolean }`. ARCHIVES by default
  // (reversible — hidden from the default list, still readable + importable);
  // `forget:true` DROPS each descriptor to reclaim sessions.json space (the
  // native conversation on disk survives). The registry never touches a live
  // (running/starting) session. Operator surface — no subtree scoping (unlike
  // the scoped MCP verb): the CLI operator GCs the whole registry. Collection
  // route, so it MUST precede the per-id `idMatch` below (which would else eat
  // `/sessions/gc` as an id).
  if (path === "/sessions/gc" && req.method === "POST") {
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const olderThanDays =
      typeof b.olderThanDays === "number" && b.olderThanDays > 0 ? b.olderThanDays : undefined
    const forget = b.forget === true
    try {
      const res = registry.gcSessions({
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(forget ? { forget: true } : {}),
      })
      json(200, res)
    } catch (err) {
      json(500, {
        error: "gc_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  if (path === "/sessions" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const argv = Array.isArray(b.argv)
      ? (b.argv as unknown[]).filter((v): v is string => typeof v === "string")
      : []
    if (argv.length === 0) {
      json(400, { error: "missing_argv" })
      return true
    }
    try {
      const rawCwd = typeof b.cwd === "string" ? b.cwd : process.cwd()
      const desc = registry.spawn({
        kind:
          b.kind === "terminal" || b.kind === "agent-cli" || b.kind === "command"
            ? b.kind
            : "command",
        // Same reverse-map as /sessions/terminal and spawnAgentSession: an
        // explicit slug wins, otherwise derive it from cwd rather than
        // dumping the session into "default".
        workspaceSlug:
          typeof b.workspaceSlug === "string"
            ? b.workspaceSlug
            : ((await resolveSlugFromCwd(rawCwd)) ?? "default"),
        cwd: rawCwd,
        argv,
        env:
          b.env && typeof b.env === "object"
            ? (b.env as Record<string, string>)
            : undefined,
        label: typeof b.label === "string" ? b.label : undefined,
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // Per-id routes. The `:id` slot also accepts a session's `name`
  // when one was set at spawn time — `findByIdOrName` resolves both
  // and the rest of the handler operates on the canonical id.
  // `/events/stream` MUST be tried before the bare `/events` alternative:
  // both are valid suffixes and `/events` is a prefix of `/events/stream`,
  // so putting the longer one first matches it directly instead of relying
  // on regex backtracking (JS alternation does backtrack across `$`, so
  // either order technically works today, but ordering by specificity
  // keeps that from being a load-bearing accident).
  const idMatch = path.match(
    /^\/sessions\/([^/]+)(\/events\/stream|\/stream|\/kill|\/pin|\/preview|\/export|\/conversation|\/events|\/wait|\/chat)?$/,
  )
  if (!idMatch) return false
  const [, rawIdOrName, suffix] = idMatch
  if (!rawIdOrName) return false
  const resolvedDesc = registry.findByIdOrName(rawIdOrName)
  const id = resolvedDesc?.id ?? rawIdOrName

  if (suffix === "/conversation" && req.method === "GET") {
    // Provider-native conversation behind this session, on ANY session kind
    // (agent-cli or PTY) — see conversation-read.ts. `conversation: null`
    // with a `reason` (no conversation, or ambiguous with `candidates`) is a
    // normal outcome, not an error — only an unresolvable session id is a
    // 404. Read-only GET, no auth gate (same policy as /preview / /export).
    if (!resolvedDesc) {
      json(404, {
        error: "session_not_found",
        message: `session "${rawIdOrName}" not found`,
        sessionId: rawIdOrName,
      })
      return true
    }
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const fmt = qs.get("format") === "json" ? "json" as const : "markdown" as const
    const result = await readConversation(registry, { idOrName: rawIdOrName, format: fmt })
    json(200, result)
    return true
  }

  if (suffix === "/export" && req.method === "GET") {
    // Transcript export — reads the adapter's native persistence layer
    // (claude-code JSONL / hermes SQLite) and returns a rendered
    // transcript. Query params: format (markdown|json), adapter, cwd.
    // Read-only GET, no auth gate (same policy as /preview).
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const fmt = qs.get("format") === "json" ? "json" as const : "markdown" as const
    const adapterOverride = qs.get("adapter") ?? undefined
    const cwdOverride = qs.get("cwd") ?? undefined
    const sourceParam = qs.get("source")
    const source =
      sourceParam === "native" || sourceParam === "daemon" ? sourceParam : undefined
    const result = await exportAgentSession({
      sessionId: rawIdOrName,
      registry,
      format: fmt,
      ...(adapterOverride ? { adapter: adapterOverride } : {}),
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(source ? { source } : {}),
    })
    if (result.content.startsWith("Error:")) {
      const isNotFound =
        result.content.includes("not found in registry") ||
        result.content.includes("not found") ||
        result.content.includes("not found")
      json(isNotFound ? 404 : 422, {
        error: "export_failed",
        message: result.content,
        sessionId: rawIdOrName,
        adapter: result.adapter,
      })
    } else {
      json(200, result)
    }
    return true
  }

  if (suffix === "/events" && req.method === "GET") {
    // Raw structured events.jsonl records — the same on-disk capture
    // /export's daemon-events strategy reads, exposed directly so a web
    // panel can render rich components instead of the collapsed
    // markdown/JSON transcript. Read-only GET, no auth gate (same
    // policy as /export / /preview).
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sinceRaw = qs.get("since")
    if (sinceRaw !== null && !/^\d+$/.test(sinceRaw)) {
      json(400, {
        error: "invalid_since",
        message: "since must be a non-negative integer",
      })
      return true
    }
    const since = sinceRaw !== null ? Number.parseInt(sinceRaw, 10) : 0
    const limit = clampInt(qs.get("limit"), 500, 1, 2000)

    // events.jsonl is always keyed by the agentproto session id (same
    // resolution export's daemon-events strategy relies on) — `id` above
    // already resolved to that via findByIdOrName, falling back to the
    // raw path segment when the registry doesn't know it.
    const filePath = sessionEventsPath(id)
    let fileStream: ReturnType<typeof createReadStream>
    try {
      fileStream = createReadStream(filePath, { encoding: "utf8" })
      await new Promise<void>((resolve, reject) => {
        fileStream.once("error", reject)
        fileStream.once("open", resolve)
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        json(404, { error: "no_transcript" })
        return true
      }
      throw err
    }

    const events: Record<string, unknown>[] = []
    let truncated = false
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof rec.seq !== "number" || rec.seq <= since) continue
      if (events.length >= limit) {
        truncated = true
        continue
      }
      events.push(rec)
    }

    const nextSeq =
      events.length > 0 ? (events[events.length - 1]?.seq as number) : since
    json(200, {
      sessionId: id,
      events,
      nextSeq,
      complete: !truncated,
    })
    return true
  }

  if (suffix === "/events/stream" && req.method === "GET") {
    // SSE live-push sibling of /events — same source file, same record
    // shape per `data:` frame, so a client's poll-route reducer works
    // unchanged against this stream. Read-only GET, no auth gate (same
    // policy as /events).
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sinceRaw = qs.get("since")
    if (sinceRaw !== null && !/^\d+$/.test(sinceRaw)) {
      json(400, {
        error: "invalid_since",
        message: "since must be a non-negative integer",
      })
      return true
    }
    const since = sinceRaw !== null ? Number.parseInt(sinceRaw, 10) : 0

    // Existence check up front, same ENOENT→404 contract as /events —
    // lets a caller distinguish "no transcript" from "connection refused"
    // before any SSE bytes go out.
    const filePath = sessionEventsPath(id)
    let fileStream: ReturnType<typeof createReadStream>
    try {
      fileStream = createReadStream(filePath, { encoding: "utf8" })
      await new Promise<void>((resolve, reject) => {
        fileStream.once("error", reject)
        fileStream.once("open", resolve)
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        json(404, { error: "no_transcript" })
        return true
      }
      throw err
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    // Node buffers `writeHead` until the first `res.write` — without this,
    // a session with nothing new to replay would leave the client's
    // connection attempt hanging (no bytes at all) until the first live
    // record or the 25s keep-alive ping, whichever comes first. Matches
    // the `: connected` convention `/events` (the bus route) already uses.
    res.write(`: connected\n\n`)
    const ping = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`)
      } catch {
        clearInterval(ping)
      }
    }, 25_000)

    async function* diskRecords(): AsyncGenerator<Record<string, unknown>> {
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          yield JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
      }
    }

    const { unsubscribe, done } = deliverRecordsExactlyOnce({
      since,
      diskRecords: diskRecords(),
      subscribe: onRecord => registry.subscribeToRecords(id, onRecord),
      send: record => {
        try {
          res.write(`data: ${JSON.stringify(record)}\n\n`)
        } catch {
          // Client gone — cleanup happens on `close`.
        }
      },
    })
    // Registered immediately after subscribing (deliverRecordsExactlyOnce
    // subscribes synchronously before returning) so a client that
    // disconnects mid-replay — a large backlog, a slow pipe — still tears
    // down the subscription instead of leaking it for the rest of the
    // daemon's life.
    req.once("close", () => {
      unsubscribe()
      clearInterval(ping)
    })

    await done
    return true
  }

  if (suffix === "/chat" && req.method === "POST") {
    // POST /sessions/:id/chat — enqueue a follow-up prompt on an EXISTING
    // /sessions/:id session and fan the daemon's RAW transcript records
    // (events.jsonl) into the `ai` v6 UI message stream as `UIMessageChunk`s
    // (same SSE framing + `x-vercel-ai-ui-message-stream` header the ai SDK
    // emits). Body: { prompt, interrupt?, source? }.
    //
    // Two-phase so a rejected prompt (dead session, or busy without
    // `interrupt`) surfaces as a clean HTTP error instead of a half-open
    // stream: we snapshot the current disk edge, await `enqueuePrompt`'s
    // admission gate (which is the only phase that can reject), then open the
    // stream. Turn records land either via the live subscribe or the disk
    // replay (deduped exactly-once by `deliverRecordsExactlyOnce`) — the
    // `since` edge is the pre-prompt seq so the session's PRIOR turn history
    // is never replayed into the chat wire.
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""
    if (!prompt) {
      json(400, { error: "missing_prompt", message: "body.prompt (non-empty string) is required" })
      return true
    }
    const interrupt = b.interrupt === true
    const source =
      typeof b.source === "string" && b.source.length > 0 ? b.source : "http:chat"
    const since = await currentTranscriptSeq(id)
    try {
      await registry.enqueuePrompt(id, prompt, {
        interrupt,
        ...(source ? { source } : {}),
      })
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        json(409, { error: "session_not_alive", message: `session "${id}" not alive` })
        return true
      }
      const message = err instanceof Error ? err.message : String(err)
      json(409, { error: "prompt_rejected", message })
      return true
    }
    const stream = startAiUiMessageStream({
      res,
      since,
      diskRecords: transcriptDiskRecords(id),
      subscribe: onRecord => registry.subscribeToRecords(id, onRecord),
      map: createTranscriptToUiMapper(id),
    })
    req.once("close", () => stream.disconnect())
    await stream.done
    return true
  }

  if (suffix === "/preview" && req.method === "GET") {
    // Read-only snapshot of the recent ring buffer — used by the
    // dashboard's detail pane so the user sees what the session was
    // doing without committing to an attach. Returns BOTH lines
    // (for agent-cli/command sessions) and recent-bytes (for PTY).
    // Caller picks whichever is populated.
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const lineCap = clampInt(qs.get("lines"), 10, 1, 200)
    const byteCap = clampInt(qs.get("bytes"), 16 * 1024, 256, 64 * 1024)
    // No registry method exists for "give me the recent buffer
    // snapshot" — readTerminalOutput is the closest. For non-PTY
    // sessions, attach with a no-op subscriber, read backfill,
    // detach. Cheap; the backfill is synchronous on attach.
    const lines: string[] = []
    if (resolvedDesc.pty !== true) {
      const unsub = registry.attach(id, line => {
        lines.push(line)
      })
      if (unsub) unsub()
    }
    const bufBytes = registry.readTerminalOutput(id, byteCap)
    json(200, {
      id: resolvedDesc.id,
      lines: lines.slice(-lineCap),
      bytes: bufBytes ? bufBytes.toString("base64") : null,
    })
    return true
  }

  if (suffix === "/wait" && req.method === "GET") {
    // Blocking long-poll — same machinery as the MCP `session_monitor`
    // tool (monitorSessionWait). Resolves when the session fires a
    // matching lifecycle event, or when timeoutMs elapses. Read-only GET,
    // no auth gate (same policy as /preview / /stream).
    if (!sessionEvents || !eventRing) {
      json(501, {
        error: "wait_not_configured",
        message:
          "GET /sessions/:id/wait needs the host to wire `sessionEvents` + `eventRing` " +
          "into the HTTP server (the daemon does this in createGateway).",
      })
      return true
    }
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    // 404 when the session is unknown AND no `since` cursor was passed —
    // a cursor implies "replay events I might have missed", so we still
    // honour it for a now-dead session. Without a cursor, waiting on a
    // missing session would block until timeout for nothing.
    if (!resolvedDesc && qs.get("since") === null) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const rawEvent = qs.get("event")
    const event: SessionWaitEvent =
      rawEvent === "turn-end" ||
      rawEvent === "awaiting-input" ||
      rawEvent === "exited" ||
      rawEvent === "any"
        ? (rawEvent as SessionWaitEvent)
        : "any"
    const rawSince = qs.get("since")
    const since =
      rawSince !== null && /^\d+$/.test(rawSince)
        ? Number.parseInt(rawSince, 10)
        : undefined
    // Cap at 55s to stay under typical HTTP client/proxy timeouts; the
    // CLI chains multiple calls when its total --timeout exceeds this.
    const timeoutMs = clampInt(qs.get("timeoutMs"), 25_000, 1_000, 55_000)
    const result = await monitorSessionWait({
      registry,
      sessionEvents,
      eventRing,
      sessionIds: [id],
      event,
      timeoutMs,
      ...(since !== undefined ? { since } : {}),
    })
    json(200, result)
    return true
  }

  if (suffix === "/stream" && req.method === "GET") {
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    // Keep-alive ping every 25s — proxies / browsers eventually
    // close idle SSE connections; the comment line keeps the pipe
    // warm without confusing the EventSource parser (it ignores
    // anything starting with `:`).
    const ping = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`)
      } catch {
        clearInterval(ping)
      }
    }, 25_000)
    const unsub = registry.attach(id, (line, stream) => {
      try {
        res.write(
          `data: ${JSON.stringify({ line, stream })}\n\n`
        )
      } catch {
        // Client gone — cleanup happens on `close`.
      }
    })
    if (!unsub) {
      clearInterval(ping)
      res.end()
      return true
    }
    req.once("close", () => {
      unsub()
      clearInterval(ping)
    })
    return true
  }

  if (suffix === "/kill" && req.method === "POST") {
    const ok = registry.kill(id)
    json(ok ? 200 : 404, { ok, sessionId: id })
    return true
  }

  // Pin/unpin — the HTTP twin of the `session_set_pinned` MCP verb, so the
  // CLI's `agentproto sessions pin`/`unpin` doesn't need to go through the
  // MCP JSON-RPC path for a simple toggle. Body: `{ pinned: boolean }`
  // (tolerates a stringified boolean, same convention as `keepAlive` on the
  // spawn route). Purely a sort/display flag — never touches the idle-reaper
  // or emits any notification.
  if (suffix === "/pin" && req.method === "POST") {
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const pinned =
      typeof b.pinned === "boolean"
        ? b.pinned
        : b.pinned === "true"
          ? true
          : b.pinned === "false"
            ? false
            : undefined
    if (pinned === undefined) {
      json(400, { error: "invalid_body", message: "`pinned` must be a boolean" })
      return true
    }
    try {
      registry.setPinned(id, pinned)
      json(200, { ok: true, sessionId: id, pinned })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(msg.includes("no session") ? 404 : 500, { error: "set_pinned_failed", message: msg })
    }
    return true
  }

  if (!suffix && req.method === "GET") {
    if (!resolvedDesc) {
      json(404, { error: "session_not_found", id: rawIdOrName })
      return true
    }
    json(200, resolvedDesc)
    return true
  }

  if (!suffix && req.method === "DELETE") {
    const ok = registry.forget(id)
    json(ok ? 200 : 404, { ok, id })
    return true
  }

  return false
}

/**
 * /presets route — list built-in provider gateway presets with live key-env
 * status. Static data (no registry), so this route is registered
 * unconditionally — no opt-in flag like /tunnels's TunnelRegistry.
 *
 *   GET /presets → { presets: AdapterEntry<PresetInfo>[] }
 *
 * Status reflects THIS process's environment (the daemon's — i.e. where agents
 * spawn), not the CLI caller's: "ready" when the provider's key env var is set,
 * "available" otherwise.
 */
async function handlePresets(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/presets" && req.method === "GET") {
    json(200, { presets: listPresets() })
    return true
  }
  return false
}

/**
 * /tunnels routes — create, list, get, and stop public tunnels.
 * Returns `true` when it handled the request so the dispatcher
 * skips the 404 path.
 *
 *   GET    /tunnels              → { tunnels: TunnelDescriptor[] }
 *   POST   /tunnels              → TunnelDescriptor (creates a new tunnel)
 *   GET    /tunnels/:id          → TunnelDescriptor
 *   DELETE /tunnels/:id          → { ok, tunnelId }
 */
async function handleTunnels(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: TunnelRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/tunnels" && req.method === "GET") {
    const urlStr = req.url ?? ""
    const qs = urlStr.includes("?")
      ? new URLSearchParams(urlStr.slice(urlStr.indexOf("?") + 1))
      : new URLSearchParams()
    const onlyActive = qs.get("onlyActive") === "true"
    let tunnels = registry.list()
    if (onlyActive) {
      tunnels = tunnels.filter(
        t => t.status === "starting" || t.status === "active",
      )
    }
    json(200, { tunnels })
    return true
  }

  if (path === "/tunnels" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const targetPort =
      typeof b.targetPort === "number" && b.targetPort > 0
        ? Math.floor(b.targetPort)
        : null
    if (!targetPort) {
      json(400, {
        error: "missing_targetPort",
        message: "body must include `targetPort` (integer 1-65535)",
      })
      return true
    }
    try {
      const desc = await registry.create({
        targetPort,
        // Any provider slug (built-in, legacy alias, or third-party) — the
        // registry resolves/validates it and surfaces an unknown slug as a
        // create_failed error below.
        ...(typeof b.provider === "string" ? { provider: b.provider } : {}),
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.label === "string" ? { label: b.label } : {}),
        ...(typeof b.targetHost === "string" ? { targetHost: b.targetHost } : {}),
        ...(b.autostart === true ? { autostart: true } : {}),
        ...(typeof b.hostname === "string" ? { hostname: b.hostname } : {}),
        ...(typeof b.tunnelId === "string" ? { tunnelId: b.tunnelId } : {}),
        ...(typeof b.credentialsFile === "string"
          ? { credentialsFile: b.credentialsFile }
          : {}),
      })
      json(201, desc)
    } catch (err) {
      json(500, {
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  const tunnelMatch = path.match(/^\/tunnels\/([^/]+)$/)
  if (!tunnelMatch) return false
  const rawIdOrName = decodeURIComponent(tunnelMatch[1] ?? "")

  if (req.method === "GET") {
    const desc = registry.findByIdOrName(rawIdOrName)
    if (!desc) {
      json(404, { error: "tunnel_not_found", id: rawIdOrName })
      return true
    }
    json(200, desc)
    return true
  }

  if (req.method === "DELETE") {
    const ok = await registry.stop(rawIdOrName)
    if (!ok) {
      json(404, { error: "tunnel_not_found", id: rawIdOrName })
      return true
    }
    json(200, { ok, tunnelId: rawIdOrName })
    return true
  }

  return false
}

/**
 * GET /routines → { routines: RoutineFrontmatter[] } — the AIP-41
 * registrar's `list()` (routine DEFINITIONS from `.routines/*`), mirroring
 * the MCP `routine_list` tool in orchestration-tools.ts.
 *
 * Returns `true` when it handled the request so the dispatcher skips the
 * 404 path.
 */
async function handleRoutinesListing(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  routineRegistrar: import("./routine-registrar.js").RoutineRegistrar,
): Promise<boolean> {
  if (path !== "/routines" || req.method !== "GET") return false
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ routines: routineRegistrar.list() }))
  return true
}

/**
 * /workflows routes — start, list, poll, cancel, and resolve escalations
 * for background workflow runs (ordered stages of steps that run
 * concurrently within a stage, gated by a barrier). Returns `true` when
 * it handled the request so the dispatcher skips the 404 path.
 *
 *   POST /workflows                          → start a run (WorkflowRun)
 *   GET  /workflows                          → { runs: WorkflowRun[] }
 *   GET  /workflows/:id                      → WorkflowRun
 *   POST /workflows/:id/cancel               → { runId, status }
 *   POST /workflows/:id/escalation/resolve   → { runId, ok }
 *
 * Thin adapters over the same WorkflowRunner the MCP `workflow_start/
 * status/cancel/escalation_resolve/list` tools call — no duplicated
 * orchestration logic between the two transports.
 */
async function handleWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  workflowRunner: WorkflowRunner,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/workflows" && req.method === "GET") {
    json(200, { runs: workflowRunner.list() })
    return true
  }

  if (path === "/workflows" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const workflowId = typeof b.workflowId === "string" ? b.workflowId : ""
    if (!workflowId) {
      json(400, { error: "missing_workflowId" })
      return true
    }
    if (!Array.isArray(b.stages) || b.stages.length === 0) {
      json(400, {
        error: "missing_stages",
        message: "body must include a non-empty `stages` array",
      })
      return true
    }
    try {
      const run = await workflowRunner.start({
        workflowId,
        stages: b.stages as WorkflowStage[],
        ...(typeof b.workspaceSlug === "string" ? { workspaceSlug: b.workspaceSlug } : {}),
        ...(typeof b.cwd === "string" ? { cwd: b.cwd } : {}),
        ...(typeof b.notifyUrl === "string" ? { notifyUrl: b.notifyUrl } : {}),
      })
      json(201, run)
    } catch (err) {
      json(400, {
        error: "start_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /workflows/:id/cancel
  const cancelMatch = path.match(/^\/workflows\/([^/]+)\/cancel$/)
  if (cancelMatch && req.method === "POST") {
    const runId = decodeURIComponent(cancelMatch[1] ?? "")
    if (!workflowRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    workflowRunner.cancel(runId)
    const run = workflowRunner.status(runId)
    json(200, { runId, status: run?.status ?? "not_found" })
    return true
  }

  // /workflows/:id/escalation/resolve
  const resolveMatch = path.match(/^\/workflows\/([^/]+)\/escalation\/resolve$/)
  if (resolveMatch && req.method === "POST") {
    const runId = decodeURIComponent(resolveMatch[1] ?? "")
    if (!workflowRunner.status(runId)) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const stageIndex = typeof b.stageIndex === "number" ? b.stageIndex : undefined
    const stepIndex = typeof b.stepIndex === "number" ? b.stepIndex : undefined
    const response = typeof b.response === "string" ? b.response : undefined
    if (stageIndex === undefined || stepIndex === undefined || response === undefined) {
      json(400, {
        error: "invalid_body",
        message:
          "body must include `stageIndex` (number), `stepIndex` (number), and `response` (string)",
      })
      return true
    }
    workflowRunner.resolve(runId, stageIndex, stepIndex, response)
    json(200, { runId, ok: true })
    return true
  }

  // /workflows/:id
  const idMatch = path.match(/^\/workflows\/([^/]+)$/)
  if (idMatch && req.method === "GET") {
    const runId = decodeURIComponent(idMatch[1] ?? "")
    const run = workflowRunner.status(runId)
    if (!run) {
      json(404, { error: "run_not_found", runId })
      return true
    }
    json(200, run)
    return true
  }

  return false
}

/**
 * /policies routes — attach, list, cancel, ack, and blocking-wait for
 * completion policies. Returns `true` when it handled the request so
 * the dispatcher skips the 404 path.
 *
 *   POST /policies              → attach a policy (PolicyRunState)
 *   GET  /policies              → { policies: PolicyRunState[] }
 *        ?sessionId=<id>        → only policies watching that session
 *                                 (its `sessionId` or any fan-in member)
 *   POST /policies/:id/cancel   → { policyId, status }
 *   POST /policies/:id/ack      → { policyId, status, sha?, error? }
 *   GET  /policies/:id/wait     → block until the policy resolves, then
 *                                 return the full PolicyRunState. Same
 *                                 shape the MCP `policy_status` tool
 *                                 returns. `{timedOut:true}` when
 *                                 `timeoutMs` elapses with no resolution.
 *
 * Thin adapters over the same CompletionPolicySupervisor the MCP
 * `policy_attach/status/cancel/ack/list` tools call — no duplicated
 * policy-state-machine logic between the two transports. Only mounted
 * when a supervisor is wired (the dispatcher guards on `opts.supervisor`).
 */
async function handlePolicies(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  supervisor: CompletionPolicySupervisor,
  registry?: SessionsRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/policies" && req.method === "GET") {
    // `?sessionId=<id>` answers the reverse question — which policies are
    // attached to this session — matching its single `sessionId` or any
    // member of its fan-in `sessionIds` group. Absent → the full list,
    // unchanged.
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sessionId = qs.get("sessionId")
    const policies = supervisor.list()
    json(200, {
      policies:
        sessionId === null
          ? policies
          : policies.filter(p => policyWatchesSession(p, sessionId)),
    })
    return true
  }

  if (path === "/policies" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const sessionId = typeof b.sessionId === "string" ? b.sessionId : undefined
    const sessionIds = Array.isArray(b.sessionIds)
      ? b.sessionIds.filter((s): s is string => typeof s === "string")
      : undefined
    if (!sessionId && !(sessionIds && sessionIds.length > 0)) {
      json(400, {
        error: "missing_sessions",
        message: "body must include `sessionId` or a non-empty `sessionIds`",
      })
      return true
    }
    const then = b.then as "emit" | "commit"
    if (then !== "emit" && then !== "commit") {
      json(400, { error: "invalid_then", message: 'body.then must be "emit" or "commit"' })
      return true
    }
    if (then === "commit" && !b.commit) {
      json(400, {
        error: "missing_commit",
        message: 'then:"commit" requires a `commit` spec',
      })
      return true
    }
    try {
      const state = supervisor.attach({
        ...(sessionId ? { sessionId } : {}),
        ...(sessionIds && sessionIds.length > 0 ? { sessionIds } : {}),
        ...(b.gate ? { gate: b.gate as AttachPolicyInput["gate"] } : {}),
        then,
        ...(b.commit ? { commit: b.commit as AttachPolicyInput["commit"] } : {}),
        ...(b.onFail ? { onFail: b.onFail as AttachPolicyInput["onFail"] } : {}),
        ...(b.next ? { next: b.next as AttachPolicyInput["next"] } : {}),
      })
      json(201, state)
    } catch (err) {
      json(400, {
        error: "attach_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /policies/:id/cancel
  const cancelMatch = path.match(/^\/policies\/([^/]+)\/cancel$/)
  if (cancelMatch && req.method === "POST") {
    const policyId = decodeURIComponent(cancelMatch[1] ?? "")
    if (!supervisor.getStatus(policyId)) {
      json(404, { error: "policy_not_found", policyId })
      return true
    }
    supervisor.cancel(policyId)
    const state = supervisor.getStatus(policyId)
    json(200, { policyId, status: state?.status ?? "not_found" })
    return true
  }

  // /policies/:id/ack
  const ackMatch = path.match(/^\/policies\/([^/]+)\/ack$/)
  if (ackMatch && req.method === "POST") {
    const policyId = decodeURIComponent(ackMatch[1] ?? "")
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const approve = typeof b.approve === "boolean" ? b.approve : undefined
    if (approve === undefined) {
      json(400, { error: "missing_approve", message: "body must include boolean `approve`" })
      return true
    }
    const state = await supervisor.ack(policyId, approve)
    if (!state) {
      json(404, { error: "policy_not_found", policyId })
      return true
    }
    json(200, {
      policyId: state.policyId,
      status: state.status,
      ...(state.commitSha ? { sha: state.commitSha } : {}),
      ...(state.error ? { error: state.error } : {}),
    })
    return true
  }

  // /policies/:id/wait — block until the named completion policy
  // transitions out of watching/queued/gating/nudging (i.e. reaches
  // done/blocked/awaiting-ack/cancelled), then return the full
  // PolicyRunState. Query params: timeoutMs=<n> (default 25000, cap
  // 55000 to stay under typical HTTP client/proxy timeouts; the CLI
  // chains multiple calls for longer budgets). Read-only GET — no auth
  // gate, same policy as the other /sessions read routes.
  const waitMatch = path.match(/^\/policies\/([^/]+)\/wait$/)
  if (!waitMatch) return false
  const policyId = decodeURIComponent(waitMatch[1] ?? "")
  if (!policyId) return false
  if (req.method !== "GET") {
    json(405, { error: "method_not_allowed", message: "GET only" })
    return true
  }

  // Fast 404 when the policy doesn't exist at all — no point blocking.
  const current = supervisor.getStatus(policyId)
  if (!current) {
    json(404, { error: "policy_not_found", policyId })
    return true
  }

  const reqUrl = req.url ?? ""
  const qs = new URLSearchParams(
    reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
  )
  const timeoutMs = clampInt(qs.get("timeoutMs"), 25_000, 1_000, 55_000)

  const result = await monitorPolicyWait({
    supervisor,
    policyId,
    timeoutMs,
  })
  // monitorPolicyWait returns `{timedOut:false, state}` on resolution, or
  // `{timedOut:true}` on timeout. Forward the full PolicyRunState for parity
  // with policy_status — including the `awaitingQuestions` enrichment the
  // MCP policy_status tool applies (harness-parity): cross-reference the
  // watched sessions' live awaitingQuestion so a REST caller can tell
  // "stuck on a question" from "still legitimately running".
  if ("timedOut" in result && result.timedOut) {
    json(200, { timedOut: true, policyId })
    return true
  }
  const state = result.state
  if (registry) {
    const awaitingQuestions = state.sessionIds
      .map(id => ({ sessionId: id, desc: registry.get(id) }))
      .filter((s): s is { sessionId: string; desc: NonNullable<ReturnType<typeof registry.get>> } => !!s.desc?.awaitingInput)
      .map(s => ({ sessionId: s.sessionId, question: s.desc.awaitingQuestion }))
    if (awaitingQuestions.length > 0) {
      json(200, { ...state, awaitingQuestions })
      return true
    }
  }
  json(200, state)
  return true
}

/**
 * /tasks routes — the Task ledger's REST surface (human-UI write path).
 * Returns `true` when it handled the request so the dispatcher skips the
 * 404 path.
 *
 *   GET   /tasks                → { boardId, tasks: TaskRecord[] }
 *         ?boardId=&status=&includeClosed=1
 *   POST  /tasks                → 201 TaskRecord (create)
 *   GET   /tasks/:id            → TaskRecord | 404
 *   PATCH /tasks/:id            → 200 { task, verifying? }
 *                                 | 409 { conflict: true, current }
 *                                 | 400 { error }
 *
 * Thin adapters over the same TaskLedger the MCP `task_create/list/claim/
 * update` tools call — no duplicated state-machine logic between the two
 * transports (the /policies pattern). Every write takes/returns `rev`; a
 * CAS miss is 409 with the current record so the caller rebases. There is
 * no separate claim route: a REST claim is `PATCH {rev, owner, status:
 * "in_progress"}` in operator context, which may assign anyone.
 */

/** Plain-object narrow for parsed JSON bodies — a guard, not a cast. */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Minimal structural check for a `verify` gate spec arriving over REST —
 *  shell (`command`) or judge (`judge.adapter` + `judge.prompt`). The
 *  ledger reuses the supervisor's GateSpec verbatim, so this only needs to
 *  reject non-gate shapes, not re-validate every field. */
function isGateSpecShape(value: unknown): value is GateSpec {
  if (!isJsonRecord(value)) return false
  if ("judge" in value) {
    return (
      isJsonRecord(value.judge) &&
      typeof value.judge.adapter === "string" &&
      typeof value.judge.prompt === "string"
    )
  }
  return typeof value.command === "string"
}

/** string→string map narrow for `meta`. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isJsonRecord(value) && Object.values(value).every(v => typeof v === "string")
  )
}

async function handleTasks(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ledger: TaskLedger,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  // HTTP callers are operator context — see the dispatcher comment.
  const caller: TaskCaller = { kind: "operator" }

  const writeResult = (result: TaskWriteResult, createdStatus = 200): void => {
    if (result.ok) {
      json(createdStatus, {
        task: result.task,
        ...(result.verifying ? { verifying: true } : {}),
      })
      return
    }
    if (result.conflict) {
      json(409, { conflict: true, current: result.current })
      return
    }
    json(400, { error: result.error })
  }

  if (path === "/tasks" && req.method === "GET") {
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const boardId = qs.get("boardId")
    const status = parseTaskStatus(qs.get("status"))
    const includeClosed =
      qs.get("includeClosed") === "1" || qs.get("includeClosed") === "true"
    const filter = {
      ...(boardId !== null ? { boardId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(includeClosed ? { includeClosed } : {}),
    }
    json(200, {
      boardId: ledger.resolveBoardId(caller, boardId ?? undefined),
      tasks: ledger.list(filter, caller),
    })
    return true
  }

  if (path === "/tasks" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!isJsonRecord(body)) {
      json(400, { error: "invalid_body" })
      return true
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      json(400, { error: "missing_title", message: "body must include a non-empty `title`" })
      return true
    }
    const input: TaskCreateInput = {
      title: body.title,
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.boardId === "string" ? { boardId: body.boardId } : {}),
      ...(typeof body.owner === "string" ? { owner: body.owner } : {}),
      ...(Array.isArray(body.blockedBy)
        ? { blockedBy: body.blockedBy.filter((t): t is string => typeof t === "string") }
        : {}),
      ...(isGateSpecShape(body.verify) ? { verify: body.verify } : {}),
      ...(isStringRecord(body.meta) ? { meta: body.meta } : {}),
    }
    const result = ledger.create(input, caller)
    writeResult(result, 201)
    return true
  }

  // /tasks/:id
  const idMatch = path.match(/^\/tasks\/([^/]+)$/)
  if (!idMatch) return false
  const taskId = decodeURIComponent(idMatch[1] ?? "")
  if (!taskId) return false

  if (req.method === "GET") {
    const task = ledger.get(taskId, caller)
    if (!task) {
      json(404, { error: "task_not_found", taskId })
      return true
    }
    json(200, task)
    return true
  }

  if (req.method === "PATCH") {
    const body = await readJsonBody(req)
    if (!isJsonRecord(body)) {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body
    if (typeof b.rev !== "number" || !Number.isInteger(b.rev) || b.rev < 0) {
      json(400, { error: "missing_rev", message: "body must include the integer `rev` last read" })
      return true
    }
    if (!ledger.get(taskId, caller)) {
      json(404, { error: "task_not_found", taskId })
      return true
    }
    const status = typeof b.status === "string" ? parseTaskStatus(b.status) : undefined
    if (typeof b.status === "string" && status === undefined) {
      json(400, { error: "invalid_status", message: `unknown status "${b.status}"` })
      return true
    }
    const evidence =
      b.evidence &&
      typeof b.evidence === "object" &&
      "policyId" in b.evidence &&
      typeof b.evidence.policyId === "string"
        ? { policyId: b.evidence.policyId }
        : undefined
    const input: TaskUpdateInput = {
      taskId,
      rev: b.rev,
      ...(status !== undefined ? { status } : {}),
      ...(typeof b.title === "string" ? { title: b.title } : {}),
      ...(typeof b.description === "string" ? { description: b.description } : {}),
      ...(Array.isArray(b.blockedBy)
        ? { blockedBy: b.blockedBy.filter((t): t is string => typeof t === "string") }
        : {}),
      ...(typeof b.owner === "string" || b.owner === null ? { owner: b.owner } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(typeof b.note === "string" ? { note: b.note } : {}),
    }
    writeResult(ledger.update(input, caller))
    return true
  }

  json(405, { error: "method_not_allowed", message: "GET or PATCH only" })
  return true
}

/**
 * /permissions routes — the cross-session permission inbox:
 *   GET  /permissions            → { permissions: [...] } across all sessions
 *                                  (optional ?sessionId=<id> filter)
 *   POST /permissions/:id        → { decision, optionId?, scope?, feedback? } approve/deny
 *
 * Mirrors the MCP `permissions_list` / `permissions_respond` tools over the
 * same SessionsRegistry inbox. Each list entry is enriched with the owning
 * session's adapter/title for a self-contained render, and carries the
 * request's raw tool input (`rawInput`) when the driver supplied one.
 */
async function handlePermissions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: SessionsRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/permissions" && req.method === "GET") {
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(
      reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "",
    )
    const sessionId = qs.get("sessionId") ?? undefined
    const permissions = registry
      .listPendingPermissions(sessionId ? { sessionId } : undefined)
      .map(p => enrichPermission(p, registry))
    json(200, { permissions })
    return true
  }

  const idMatch = path.match(/^\/permissions\/([^/]+)$/)
  if (idMatch && req.method === "POST") {
    const id = decodeURIComponent(idMatch[1] ?? "")
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const decision = b.decision
    if (decision !== "approve" && decision !== "deny") {
      json(400, {
        error: "invalid_decision",
        message: 'body.decision must be "approve" or "deny"',
      })
      return true
    }
    const optionId = typeof b.optionId === "string" ? b.optionId : undefined
    const scope = b.scope === "always" || b.scope === "once" ? b.scope : undefined
    const feedback = typeof b.feedback === "string" ? b.feedback : undefined
    const result = await registry.respondPermission(id, {
      decision,
      ...(optionId ? { optionId } : {}),
      ...(scope ? { scope } : {}),
      ...(feedback ? { feedback } : {}),
    })
    if (!result.ok) {
      const status = result.error === "not_found" || result.error === "session_gone" ? 404 : 409
      json(status, { error: result.error, message: result.message })
      return true
    }
    json(200, {
      ok: true,
      id,
      sessionId: result.permission.sessionId,
      decision: result.decision,
      ...(result.optionId ? { optionId: result.optionId } : {}),
    })
    return true
  }

  if (path === "/permissions" || idMatch) {
    json(405, { error: "method_not_allowed", message: "GET /permissions or POST /permissions/:id" })
    return true
  }
  return false
}

/** Enrich a raw PendingPermission with the owning session's adapter/title/age
 *  so a REST/MCP list entry is self-contained. */
function enrichPermission(
  p: import("./sessions.js").PendingPermission,
  registry: SessionsRegistry,
): Record<string, unknown> {
  const desc = registry.get(p.sessionId)
  const ageMs = Date.now() - new Date(p.requestedAt).getTime()
  return {
    ...p,
    ...(desc?.adapterSlug ? { adapter: desc.adapterSlug } : {}),
    ...(desc?.label ? { sessionLabel: desc.label } : {}),
    ...(desc?.command ? { sessionTitle: desc.command } : {}),
    ageMs: ageMs >= 0 ? ageMs : 0,
  }
}

/**
 * /pairings routes — E2E daemon pairing (design: DESIGN §6):
 *   POST   /pairings/offer         → { ttlMinutes?, rendezvous? } mint offer
 *                                    → { url, fingerprint, rendezvous,
 *                                        rendezvousIsHostedDefault, expiresAt }
 *   GET    /pairings               → { pairings: [...] }
 *   DELETE /pairings/:fingerprint  → revoke by fingerprint (or name)
 *
 * Mirrors the MCP `pair_offer` / `pair_list` / `pair_revoke` tools over the same
 * registry. Imitates the /permissions surface from #308.
 */
async function handlePairings(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: PairingRegistry,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/pairings/offer" && req.method === "POST") {
    const body = await readJsonBody(req)
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const ttlMinutes = typeof b.ttlMinutes === "number" ? b.ttlMinutes : undefined
    const rendezvous = typeof b.rendezvous === "string" ? b.rendezvous : undefined
    try {
      const offer = await registry.createOffer({
        ...(ttlMinutes ? { ttlMs: ttlMinutes * 60_000 } : {}),
        ...(rendezvous ? { rendezvousUrl: rendezvous } : {}),
      })
      json(200, {
        url: offer.url,
        fingerprint: offer.fingerprint,
        rendezvous: offer.rendezvousUrl,
        rendezvousIsHostedDefault: offer.rendezvousIsHostedDefault,
        expiresAt: new Date(offer.exp * 1000).toISOString(),
      })
    } catch (err) {
      json(400, {
        error: "offer_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  if (path === "/pairings" && req.method === "GET") {
    const pairings = (await registry.list()).map(p => ({
      name: p.name,
      fingerprint: p.fingerprint,
      createdAt: p.createdAt,
      lastSeen: p.lastSeen,
      rendezvous: p.rendezvousUrl,
    }))
    json(200, { pairings })
    return true
  }

  const fpMatch = path.match(/^\/pairings\/([^/]+)$/)
  if (fpMatch && req.method === "DELETE") {
    const target = decodeURIComponent(fpMatch[1] ?? "")
    const revoked = await registry.revoke(target)
    if (!revoked) {
      json(404, { error: "not_found", message: `no pairing matched "${target}"` })
      return true
    }
    json(200, { ok: true, revoked: target })
    return true
  }

  if (path === "/pairings" || path === "/pairings/offer" || fpMatch) {
    json(405, {
      error: "method_not_allowed",
      message: "POST /pairings/offer · GET /pairings · DELETE /pairings/:fingerprint",
    })
    return true
  }
  return false
}

/**
 * /cron routes:
 *   POST   /cron          → create a new cron job
 *   GET    /cron          → list all cron jobs
 *   DELETE /cron/:id      → delete a cron job
 *   POST   /cron/:id/run  → manually fire a cron job
 */
async function handleCron(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  scheduler: import("./cron-scheduler.js").CronScheduler,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/cron" && req.method === "GET") {
    json(200, { jobs: scheduler.list() })
    return true
  }

  if (path === "/cron" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (!body || typeof body !== "object") {
      json(400, { error: "invalid_body" })
      return true
    }
    const b = body as Record<string, unknown>
    const schedule = typeof b.schedule === "string" ? b.schedule : ""
    if (!schedule) {
      json(400, { error: "missing_schedule" })
      return true
    }
    const action = b.action
    if (!action || typeof action !== "object") {
      json(400, { error: "missing_action" })
      return true
    }
    try {
      const job = scheduler.create({
        label: typeof b.label === "string" ? b.label : undefined,
        schedule,
        recurring: typeof b.recurring === "boolean" ? b.recurring : true,
        action: action as import("./cron-scheduler.js").CronAction,
      })
      json(201, job)
    } catch (err) {
      json(400, {
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // /cron/:id/run — manual fire
  const runMatch = path.match(/^\/cron\/([^/]+)\/run$/)
  if (runMatch && req.method === "POST") {
    const jobId = decodeURIComponent(runMatch[1] ?? "")
    try {
      const result = await scheduler.run(jobId)
      json(200, { jobId, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("not found") ? 404 : 500
      json(status, { error: "run_failed", message: msg })
    }
    return true
  }

  // /cron/:id
  const idMatch = path.match(/^\/cron\/([^/]+)$/)
  if (!idMatch) return false
  const jobId = decodeURIComponent(idMatch[1] ?? "")

  if (req.method === "GET") {
    const job = scheduler.get(jobId)
    if (!job) {
      json(404, { error: "job_not_found", jobId })
      return true
    }
    json(200, job)
    return true
  }

  if (req.method === "DELETE") {
    try {
      scheduler.delete(jobId)
      json(200, { ok: true, jobId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(404, { error: "job_not_found", message: msg })
    }
    return true
  }

  return false
}

/**
 * /routine-defs routes:
 *   POST /routine-defs/:id/trigger → fire an AIP-41 routine's target
 *   immediately, bypassing its schedule (mirrors POST /cron/:id/run).
 *   POST /routine-defs/reconcile → re-scan `.routines/*` and
 *   register/update/remove live cron jobs to match (the boot-time pass,
 *   callable on demand — see `routine_reconcile` in orchestration-tools.ts).
 *
 * Mounted at a different prefix than /routines (the AIP-41 registrar
 * listing) on purpose — see routine-registrar.ts SPEC note.
 */
async function handleRoutineDefs(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registrar: import("./routine-registrar.js").RoutineRegistrar,
): Promise<boolean> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  if (path === "/routine-defs/reconcile" && req.method === "POST") {
    try {
      const result = registrar.reconcile()
      json(200, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(500, { error: "reconcile_failed", message: msg })
    }
    return true
  }

  const triggerMatch = path.match(/^\/routine-defs\/([^/]+)\/trigger$/)
  if (triggerMatch && req.method === "POST") {
    const routineId = decodeURIComponent(triggerMatch[1] ?? "")
    try {
      const result = await registrar.trigger(routineId)
      json(200, { routineId, ...result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes("not found") ? 404 : 500
      json(status, { error: "trigger_failed", message: msg })
    }
    return true
  }

  return false
}


interface InboundHandlerDeps {
  routeInboundMessage?: RuntimeHttpServerOptions["routeInboundMessage"]
  endpointStore?: InboundEndpointStore
  checkSessionsToken: (req: IncomingMessage) => "ok" | "missing" | "bad"
  rejectUnauthorizedSession: (req: IncomingMessage, res: ServerResponse, reason: "missing" | "bad") => void
}

// Provider-agnostic raw-body push ingress. Mirrors `readJsonBody` but preserves
// bytes for HMAC verification. Cap: 1 MB (expand later if large media pre-signed URLs arrive).
async function readRawBody(req: IncomingMessage): Promise<{ ok: true; raw: string } | { ok: false; status: number; error: string }> {
  const MAX_RAW_BODY_BYTES = 1_024 * 1_024
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer)
    total += buf.length
    if (total > MAX_RAW_BODY_BYTES) {
      return { ok: false, status: 413, error: "payload_too_large" }
    }
    chunks.push(buf)
  }
  return { ok: true, raw: Buffer.concat(chunks).toString("utf8") }
}

function isInboundRouteMode(mode: string): mode is InboundRouteMode {
  return mode === "spawn" || mode === "route" || mode === "route-or-spawn"
}

async function handleNativeInbound(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InboundHandlerDeps,
): Promise<void> {
  // Push-ingress counterpart to inbound-watcher.ts's poll loop —
  // same bearer gate as the other mutating routes since this lets
  // a caller inject a user turn into a live session.
  const gate = deps.checkSessionsToken(req)
  if (gate !== "ok") {
    deps.rejectUnauthorizedSession(req, res, gate)
    return
  }
  const body = (await readJsonBody(req)) as {
    alias?: unknown
    source?: unknown
    contact_ref?: unknown
    text?: unknown
    messages?: unknown
    mode?: unknown
  } | null
  if (!body || typeof body.alias !== "string" || !body.alias) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "missing_alias" }))
    return
  }
  if (typeof body.source !== "string" || !body.source) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "missing_source" }))
    return
  }
  if (typeof body.contact_ref !== "string" || !body.contact_ref) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "missing_contact_ref" }))
    return
  }
  if (typeof body.text !== "string" || !body.text) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "missing_text" }))
    return
  }
  let mode: InboundRouteMode = "route-or-spawn"
  if (body.mode !== undefined) {
    if (!isInboundRouteMode(String(body.mode))) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "invalid_mode",
          message: `mode must be one of "spawn", "route", "route-or-spawn", got ${JSON.stringify(body.mode)}.`,
        })
      )
      return
    }
    mode = body.mode as InboundRouteMode
  }
  if (!deps.routeInboundMessage) {
    res.writeHead(501, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: "inbound_routing_not_configured",
        message:
          "POST /inbound is not enabled — the daemon was started " +
          "without a routeInboundMessage handler. The host must " +
          "wire `routeInboundMessage` in createGateway.",
      })
    )
    return
  }
  const msg: InboundMessage = {
    alias: body.alias,
    source: body.source,
    contactRef: body.contact_ref,
    text: body.text,
    ...(Array.isArray(body.messages)
      ? { messages: body.messages }
      : {}),
  }
  const result = await deps.routeInboundMessage(msg, mode)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(result))
}

function inboundRequestHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = v
  }
  return out
}

async function handleProviderInbound(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  deps: InboundHandlerDeps,
): Promise<void> {
  if (!deps.endpointStore) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unknown_inbound_endpoint" }))
    return
  }

  const endpoint = deps.endpointStore.get(slug)
  if (!endpoint || !endpoint.enabled) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unknown_inbound_endpoint" }))
    return
  }

  const rawResult = await readRawBody(req)
  if (!rawResult.ok) {
    res.writeHead(rawResult.status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: rawResult.error }))
    return
  }
  const rawBody = rawResult.raw

  if (endpoint.secret) {
    const verified = verifyInboundSignature(endpoint.provider, {
      rawBody,
      headers: inboundRequestHeaders(req),
      secret: endpoint.secret,
      nowMs: Date.now(),
    })
    if (!verified.ok) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "bad_signature", reason: verified.reason }))
      return
    }
  } else {
    const gate = deps.checkSessionsToken(req)
    if (gate !== "ok") {
      deps.rejectUnauthorizedSession(req, res, gate)
      return
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "invalid_json" }))
    return
  }

  const normalized = normalizeInbound(endpoint.provider, parsed, {
    alias: endpoint.alias,
    sourceOverride: endpoint.source,
  })

  if (!normalized.ok) {
    switch (normalized.error) {
      case "no_text":
      case "bot_or_self_message":
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ action: "ignored", reason: normalized.error, message: normalized.message }))
        return
      default:
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: normalized.error }))
        return
    }
  }

  if ("challenge" in normalized) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ challenge: normalized.challenge }))
    return
  }

  let mode: InboundRouteMode = endpoint.mode
  const urlStr = req.url ?? ""
  const queryStart = urlStr.indexOf("?")
  const modeParam = queryStart >= 0 ? new URLSearchParams(urlStr.slice(queryStart + 1)).get("mode") : null
  if (modeParam) {
    if (!isInboundRouteMode(modeParam)) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: "invalid_mode",
          message: `mode must be one of "spawn", "route", "route-or-spawn", got ${JSON.stringify(modeParam)}.`,
        })
      )
      return
    }
    mode = modeParam
  }

  if (normalized.providerMessageId) {
    if (!deps.endpointStore.markSeen(slug, normalized.providerMessageId)) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ action: "duplicate" }))
      return
    }
  }

  if (!deps.routeInboundMessage) {
    res.writeHead(501, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: "inbound_routing_not_configured",
        message:
          "POST /inbound is not enabled — the daemon was started " +
          "without a routeInboundMessage handler. The host must " +
          "wire `routeInboundMessage` in createGateway.",
      })
    )
    return
  }

  const result = await deps.routeInboundMessage(normalized.msg, mode)
  deps.endpointStore.upsert({
    ...endpoint,
    lastSeenTs: Date.now(),
  })
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(result))
}

/** `GET /apps/:appId/ui` — an installed app's `ui.path` html, with the
 *  standalone REST bridge injected so `window.McpApp.connect()` works with
 *  no host iframe (callTool POSTs to the sibling `./tool-call` route —
 *  `./` resolves against the document URL, so the appId segment carries
 *  over whichever spelling it used). `frame-ancestors 'none'`: standalone
 *  means a top-level tab — refusing embedding closes the drive-by where a
 *  hostile page iframes the UI and lets the app's own boot sequence fire
 *  allowlisted tools. */
async function handleAppUiPage(
  res: ServerResponse,
  appId: string,
  appRegistry: AppRegistry,
): Promise<void> {
  const app = appRegistry.getApp(appId)
  if (!app?.ui) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: `app "${appId}" is not installed or has no UI.` }))
    return
  }
  let raw: string
  try {
    raw = await readFile(app.ui.path, "utf8")
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: `could not read app "${appId}"'s ui html at "${app.ui.path}": ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
    return
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  })
  res.end(injectStandaloneAppBridge(raw))
}

/** Map a file extension to the `OutboundAttachment["type"]` bucket
 *  `mimeTypeFor` (outbound-adapters.ts) expects, so `/external-blob` can
 *  reuse that lookup instead of hand-rolling a second MIME table. Any
 *  extension not recognized here still resolves through `mimeTypeFor`'s
 *  "document" branch, which falls back to `application/octet-stream`. */
function outboundKindForExt(ext: string): "photo" | "document" | "video" | "audio" {
  const e = ext.toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(e)) return "photo"
  if ([".mp4", ".mov", ".webm"].includes(e)) return "video"
  if ([".mp3", ".ogg", ".wav", ".m4a"].includes(e)) return "audio"
  return "document"
}

/** `GET /apps/:appId/external-blob?root=<exact-granted-root>&path=<relative>`
 *  — streams a file's raw bytes from one of an installed app's granted
 *  `InstalledApp.externalReadRoots`, the binary-content sibling of the
 *  `app_external_read` MCP tool (app-external.ts), which only serves an
 *  allowlist of text-ish extensions into a tool's JSON response. `root`
 *  must be an exact string match to a granted entry (same boundary as the
 *  MCP tools — no prefix/fuzzy match); `path` is resolved against it with
 *  `resolveExternalPath` + a symlink-escape recheck, the exact same guard
 *  `app_external_list`/`app_external_read` use, not a re-derived one. GET
 *  only, read-only: this route never writes/deletes, and there is no size
 *  cap — PDFs/images are meant to flow through here unlike the text tool. */
async function handleAppExternalBlob(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  appRegistry: AppRegistry,
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const app = appRegistry.getApp(appId)
  if (!app) {
    reply(404, { error: `app "${appId}" is not installed.` })
    return
  }
  const reqUrl = req.url ?? ""
  const qs = new URLSearchParams(reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "")
  const root = qs.get("root")
  const relPath = qs.get("path") ?? ""
  if (!root) {
    reply(400, { error: "missing_root" })
    return
  }
  if (!isExternalRootGranted(app, root)) {
    reply(403, { error: `root "${root}" is not granted to app "${appId}".` })
    return
  }
  const safeRoot = await realpathExternalRoot(root)
  if (!safeRoot) {
    reply(404, { error: `root "${root}" is not accessible.` })
    return
  }
  let target: string
  try {
    target = resolveExternalPath(safeRoot, relPath)
    await assertExternalPathRealInside(safeRoot, target)
  } catch (err) {
    reply(400, { error: err instanceof Error ? err.message : String(err) })
    return
  }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(target)
  } catch {
    reply(404, { error: `"${relPath}" not found under root "${root}".` })
    return
  }
  if (st.isDirectory()) {
    reply(400, { error: `"${relPath}" is a directory, not a file.` })
    return
  }
  const ext = extname(target)
  res.writeHead(200, {
    "content-type": mimeTypeFor(ext, outboundKindForExt(ext)),
    "content-disposition": "inline",
    "cache-control": "no-store",
  })
  const stream = createReadStream(target)
  stream.on("error", () => res.destroy())
  stream.pipe(res)
}

/** `POST /apps/:appId/tool-call` `{ tool, args? }` — the REST twin of the
 *  MCP `app_tool_call` gateway, sharing its exact allowlist + dispatch via
 *  `performAppToolCall`. Replies 200 with the MCP result envelope (isError
 *  ones included — a postMessage host's `tools/call` reply RESOLVES with
 *  those, so the REST bridge must too); only a malformed body is a 400.
 *
 *  The bundled UIs address the daemon-level gateway through their bridge
 *  (`callTool("app_tool_call", { appId, tool, args })` — see media-viewer's
 *  `callApp`), so that meta-call is unwrapped here: the inner tool runs
 *  against THIS route's app, and an inner appId naming a different app is
 *  refused rather than silently re-scoped. */
async function handleAppUiToolCall(
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  appRegistry: AppRegistry,
  deps: AppToolCallDeps,
): Promise<void> {
  const body = (await readJsonBody(req)) as { tool?: unknown; args?: unknown } | null
  const badRequest = (message: string): void => {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "bad_request", message }))
  }
  if (!body || typeof body.tool !== "string") {
    badRequest('body must be `{ "tool": string, "args"?: object }`.')
    return
  }
  let tool = body.tool
  let args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {}
  if (tool === "app_tool_call") {
    const inner = args as { appId?: unknown; tool?: unknown; args?: unknown }
    if (typeof inner.tool !== "string") {
      badRequest('an "app_tool_call" meta-call needs `args.tool` (string).')
      return
    }
    if (typeof inner.appId === "string" && inner.appId !== appId) {
      badRequest(
        `an "app_tool_call" meta-call must target this route's app ("${appId}"), got "${inner.appId}".`,
      )
      return
    }
    tool = inner.tool
    args =
      inner.args && typeof inner.args === "object" && !Array.isArray(inner.args)
        ? (inner.args as Record<string, unknown>)
        : {}
  }
  const result = await performAppToolCall(appRegistry, { appId, tool, args }, deps)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(result))
}

async function handleApps(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  appRegistry: AppRegistry,
  performInstall: (
    dir: string,
    appRegistry: AppRegistry,
    listRegisteredToolIds: () => Promise<string[]>,
    resolveAgentAdapter?: AgentAdapterResolver,
    opts?: { dataDir?: string },
  ) => Promise<{ ok: true; record: any } | { ok: false; error: string }>,
  listRegisteredToolIds: () => Promise<string[]>,
  resolveAgentAdapter?: AgentAdapterResolver,
): Promise<boolean> {
  const method = req.method ?? "GET"

  const applyMatch = path.match(/^\/apps\/([^/]+)\/apply$/)
  if (applyMatch && method === "POST") {
    const appId = decodeURIComponent(applyMatch[1]!)
    const body = (await readJsonBody(req)) as { scopeId?: string; dir?: string; dataDir?: string } | null
    const scopeId = body?.scopeId ?? "root"

    let installed = appRegistry.getApp(appId)
    if (!installed && body?.dir) {
      const installResult = await performInstall(body.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter, {
        ...(body.dataDir !== undefined ? { dataDir: body.dataDir } : {}),
      })
      if (!installResult.ok) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: installResult.error }))
        return true
      }
      installed = installResult.record
    }

    if (!installed) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: `app "${appId}" is not installed. Either call app_install first or provide a 'dir' parameter.`,
        }),
      )
      return true
    }

    if (installed.requires && installed.requires.length > 0) {
      const applied = appRegistry.listApplied(scopeId)
      const appliedIds = new Set(applied.map(m => m.appId))
      const missing = installed.requires.filter(reqId => !appliedIds.has(reqId))
      if (missing.length > 0) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: `app "${appId}" requires the following apps to be applied to scope "${scopeId}" first: ${missing.join(", ")}`,
          }),
        )
        return true
      }
    }

    const mount = appRegistry.applyApp({ scopeId, appId })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        scopeId: mount.scopeId,
        appId: mount.appId,
        appliedAt: mount.appliedAt,
        agents: installed.agents,
        workflows: installed.workflows,
        unvalidatedAgentTools: installed.unvalidatedAgentTools,
      }),
    )
    return true
  }

  if (applyMatch && method === "DELETE") {
    const appId = decodeURIComponent(applyMatch[1]!)
    const body = (await readJsonBody(req)) as { scopeId?: string } | null
    const url = new URL(req.url ?? "", `http://${req.headers.host}`)
    const scopeId = body?.scopeId ?? url.searchParams.get("scopeId") ?? "root"

    const applied = appRegistry.listApplied(scopeId)
    const dependents: string[] = []
    for (const mount of applied) {
      if (mount.appId === appId) continue
      const app = appRegistry.getApp(mount.appId)
      if (app?.requires?.includes(appId)) {
        dependents.push(mount.appId)
      }
    }

    if (dependents.length > 0) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: `cannot unapply app "${appId}" from scope "${scopeId}" — the following apps in this scope require it: ${dependents.join(", ")}`,
        }),
      )
      return true
    }

    const removed = appRegistry.unapplyApp({ scopeId, appId })
    if (!removed) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: `app "${appId}" is not applied to scope "${scopeId}".` }))
      return true
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ scopeId: removed.scopeId, appId: removed.appId, appliedAt: removed.appliedAt }))
    return true
  }

  const scopesMatch = path.match(/^\/scopes\/([^/]+)\/apps$/)
  if (scopesMatch && method === "GET") {
    const scopeId = decodeURIComponent(scopesMatch[1]!)
    const mounts = appRegistry.listApplied(scopeId)
    const result = mounts.map(mount => {
      const app = appRegistry.getApp(mount.appId)
      return {
        scopeId: mount.scopeId,
        appId: mount.appId,
        appliedAt: mount.appliedAt,
        ...(app
          ? {
              agents: app.agents,
              workflows: app.workflows,
              unvalidatedAgentTools: app.unvalidatedAgentTools,
            }
          : {}),
      }
    })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(result))
    return true
  }

  return false
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return null
  }
}
