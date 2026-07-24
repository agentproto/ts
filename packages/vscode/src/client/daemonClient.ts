/**
 * Typed HTTP + MCP client for the agentproto daemon. This is the ONLY
 * module that talks to the daemon over the network — everything else in
 * the extension goes through a DaemonClient instance.
 *
 * Auth (recon §Auth): the daemon's per-boot bearer token is auto-resolved
 * from (in order): an explicit config.tokenPath override → the global
 * `~/.agentproto/daemons/<port>.json` keyed by the daemon's listen port →
 * the active workspace's `<cwd>/.agentproto/runtime.json`, and only when
 * that file's own `port` matches the daemon we're dialling. The workspace
 * file is keyed by workspace, not by port, so a second daemon booted on
 * the same root overwrites it with another process's token — hence the
 * port-keyed registry outranks it. Loopback requests without a token are
 * accepted by the daemon in its default "none" auth mode, so a missing
 * token is non-fatal — methods still work, they just don't send the
 * Authorization header.
 *
 * The token is regenerated on every daemon boot, so a cached one goes
 * stale the moment the daemon restarts. Gated requests therefore go
 * through authedFetch(), which re-resolves and replays ONCE on the
 * daemon's `sessions_unauthorized` 401.
 *
 * Every method throws on a non-2xx response. JSON-RPC 2.0 `tools/call`
 * results (POST /mcp) are unwrapped from the MCP content envelope into a
 * parsed JS value.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { DaemonConfig } from "../config.js"
import type {
  AdapterInfo,
  AdapterInstallResult,
  AuthProfileSummary,
  CatalogModelsResponse,
  CatalogProviderModelsResponse,
  CreateAuthProfileRequest,
  CreatedAuthProfileResult,
  DaemonHealth,
  DiscoveredCredential,
  ImportCredentialRequest,
  LlmEndpointDescriptorResult,
  LlmEndpointLinksResult,
  LlmEndpointReloadPacksResult,
  LlmEndpointSetLinkResult,
  LlmEndpointStartOptions,
  LlmEndpointStatusResult,
  LlmEndpointUpstreamTestResult,
  PendingPermission,
  ProviderPresetEntry,
  RouteSpec,
  SessionDescriptor,
  SessionEventsPage,
  SessionEventsPollResult,
  UserPreset,
  WorkspacesConfig,
  WorktreeGcResult,
} from "./types.js"

export interface SessionEventsOptions {
  /** Return only records with seq > since (cursor for incremental polling). */
  since?: number
  /** Cap the page size (daemon clamps to [1, 2000], default 500). */
  limit?: number
}

/** Raised when a session has no structured events.jsonl (terminal/command
 *  sessions, or one that predates the capture) so callers can fall back to
 *  raw output instead of treating it as a hard error. */
export class NoTranscriptError extends Error {
  constructor(public readonly sessionId: string) {
    super(`no structured transcript for session ${sessionId}`)
    this.name = "NoTranscriptError"
  }
}

/** Raised by {@link DaemonClient.addWorkspace} on a 404 — the daemon predates
 *  the isomorphic `POST /workspaces` route, not a bad request. */
export class WorkspacesRouteMissingError extends Error {
  constructor() {
    super("POST /workspaces is not available on this daemon — update your agentproto install.")
    this.name = "WorkspacesRouteMissingError"
  }
}

export interface SpawnAgentOptions {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  resumeSessionId?: string
  mode?: string
  model?: string
  effort?: string
  /** Explicit routing rail (gateway + optional custom baseUrl). Mirrors the
   *  daemon's `route` body field on POST /sessions/agent (parseRouteField);
   *  set it when a model bills a non-default gateway (openrouter/requesty/…)
   *  so the wallet resolves correctly instead of falling back to the
   *  adapter's native provider. */
  route?: RouteSpec
  /** Named auth-profile binding — the wallet this session bills. Mirrors the
   *  daemon's `access` body field (parseAccessField). Without it a spawn
   *  resolves to the daemon's default wallet, which 500s the serviceability
   *  guard for any model that needs an api-key profile. */
  access?: {
    profileRef?: string
  }
  auth?: {
    mode: "subscription" | "api-key"
    token?: string
    apiKey?: string
  }
  prompt?: string
  label?: string
  role?: string
  promptAppend?: string
  orchestrator?: boolean | object
  mcpServers?: unknown[]
  trace?: boolean
  permissionHold?: boolean
  /** Source label recorded on the descriptor (this client stamps "vscode"). */
  origin?: string
  /** ID of a saved user preset from ~/.agentproto/presets.json whose axes are expanded server-side. */
  presetId?: string
}

export interface SpawnTerminalOptions {
  argv: string[]
  cwd?: string
  workspaceSlug?: string
  label?: string
  name?: string
  env?: Record<string, string>
}

export interface PromptOptions {
  interrupt?: boolean
  /** wait=true blocks until the turn ends; wait=false is fire-and-forget. */
  wait?: boolean
}

export interface WaitOptions {
  event?: "turn-end" | "awaiting-input" | "exited" | "any"
  since?: number
  timeoutMs?: number
}

export interface RespondPermissionInput {
  decision: "approve" | "deny"
  optionId?: string
  scope?: "once" | "always"
}

export class DaemonClient {
  private readonly config: DaemonConfig
  private readonly fetchImpl: typeof fetch
  private readonly homeDir: string
  private tokenPromise: Promise<string | undefined> | undefined

  constructor(
    config: DaemonConfig,
    fetchImpl: typeof fetch = fetch,
    homeDir: string = homedir(),
  ) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.homeDir = homeDir
  }

  /** Base daemon URL, trailing slash stripped. */
  get url(): string {
    return this.config.daemonUrl.replace(/\/+$/, "")
  }

  // ── Health & sessions ───────────────────────────────────────────────

  async health(): Promise<DaemonHealth> {
    return this.getJson<DaemonHealth>("/health")
  }

  /**
   * GET /sessions. `includeArchived` opts into rows `session_archive`
   * hides by default — the daemon's own `list()` default (recon
   * §Session archive).
   */
  async listSessions(opts?: { includeArchived?: boolean }): Promise<SessionDescriptor[]> {
    const query = opts?.includeArchived ? "?includeArchived=true" : ""
    const body = await this.getJson<{ sessions: SessionDescriptor[] }>(`/sessions${query}`)
    return body.sessions ?? []
  }

  async getSession(id: string): Promise<SessionDescriptor> {
    return this.getJson<SessionDescriptor>(`/sessions/${encodeURIComponent(id)}`)
  }

  /**
   * `session_archive` is MCP-only (there is no HTTP route) — same shape as
   * `session_restart`. The daemon guards this server-side (refuses a
   * still-alive session), so a failed archive throws with that message.
   */
  async archiveSession(idOrName: string): Promise<SessionDescriptor> {
    return this.mcpCall<SessionDescriptor>("session_archive", { idOrName })
  }

  /** `session_unarchive` — the inverse, no status guard. MCP-only. */
  async unarchiveSession(idOrName: string): Promise<SessionDescriptor> {
    return this.mcpCall<SessionDescriptor>("session_unarchive", { idOrName })
  }

  /**
   * `POST /sessions/gc` — bulk-retire ENDED sessions (the `session_gc` verb).
   * Default (no `forget`) ARCHIVES them: they stay readable and can be
   * unarchived. `forget: true` drops them permanently. `olderThanDays` limits
   * to sessions idle at least that long. Only terminal sessions are eligible —
   * a live one is never touched. Returns what it did.
   */
  async gcSessions(opts?: {
    olderThanDays?: number
    forget?: boolean
  }): Promise<{ mode: "archived" | "forgotten"; ids: string[]; count: number }> {
    return this.postJson("/sessions/gc", {
      ...(opts?.olderThanDays !== undefined ? { olderThanDays: opts.olderThanDays } : {}),
      ...(opts?.forget ? { forget: true } : {}),
    })
  }

  /**
   * `POST /worktrees/gc` — plan (and, with `apply`, execute) a worktree sweep
   * for ONE repo. DEFAULTS TO A DRY RUN: without `apply` it returns the plan
   * (`mode:"plan"`) and mutates nothing. Target the repo by `repoRoot` (the
   * daemon resolves it to the git root) or `workspaceSlug`. Engine safety is
   * server-side: only merged, clean, no-open-PR, no-live-session worktrees are
   * `reclaim`; dirty ones are `salvage` (removed only with `salvageDirty`); an
   * open PR or a live session is `hold` (kept). Throws when the daemon has no
   * gc runner wired (`501 worktree_gc_not_configured`).
   */
  async gcWorktrees(opts: {
    repoRoot?: string
    workspaceSlug?: string
    apply?: boolean
    salvageDirty?: boolean
    includeDetached?: boolean
  }): Promise<WorktreeGcResult> {
    return this.postJson("/worktrees/gc", {
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
      ...(opts.workspaceSlug ? { workspaceSlug: opts.workspaceSlug } : {}),
      apply: opts.apply === true,
      salvageDirty: opts.salvageDirty === true,
      includeDetached: opts.includeDetached === true,
    })
  }

  /**
   * `PATCH /sessions/:id` — set or clear a session's user-facing name (SPEC-3
   * FIX B). Each of `title`/`label`: a string sets it, `null`/`""` clears it,
   * an omitted key leaves it untouched. Returns the updated descriptor. A user
   * rename writes `label` (the winning display field) so the edit always
   * shows; the derived `title` stays the auto fallback (fork-1).
   */
  async renameSession(
    id: string,
    patch: { title?: string | null; label?: string | null },
  ): Promise<SessionDescriptor> {
    return this.request<SessionDescriptor>(
      "PATCH",
      `/sessions/${encodeURIComponent(id)}`,
      patch,
    )
  }

  async spawnAgent(opts: SpawnAgentOptions): Promise<SessionDescriptor> {
    return this.postJson<SessionDescriptor>("/sessions/agent", opts)
  }

  async spawnTerminal(opts: SpawnTerminalOptions): Promise<SessionDescriptor> {
    return this.postJson<SessionDescriptor>("/sessions/terminal", opts)
  }

  async prompt(
    id: string,
    prompt: string,
    opts: PromptOptions = {},
  ): Promise<unknown> {
    const wait = opts.wait ?? true
    const url = `/sessions/${encodeURIComponent(id)}/prompt?wait=${wait ? "true" : "false"}`
    return this.postJson<unknown>(url, {
      prompt,
      ...(opts.interrupt ? { interrupt: true } : {}),
    })
  }

  /**
   * POST /files/upload — copy raw bytes to `{cwd}/.agentproto-attachments/{name}`
   * and return the absolute path the agent's Read tool can pick up. This is the
   * transport half for a pasted screenshot: the webview can't write disk, so the
   * host hands the bytes to the daemon and gets back a path to drop into the
   * prompt.
   *
   * The body is sent RAW (not JSON) — the route reads the request stream
   * verbatim — so this bypasses `request()` and its JSON serialization. `cwd`
   * and `name` ride in the query string; both are re-validated + sanitized by
   * the route, and the route caps the body at 32 MiB (413 past that).
   */
  async uploadFile(
    cwd: string,
    name: string,
    bytes: ArrayBuffer | ArrayBufferView,
    mime: string,
  ): Promise<{ path: string; bytes: number }> {
    const body =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const path = `/files/upload?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`
    const res = await this.authedFetch(path, {
      method: "POST",
      headers: {
        // The route ignores the content-type (it reads the raw stream) but a
        // truthful one keeps proxies/logs honest. Default when the paste has no
        // mime rather than sending an empty header.
        "content-type": mime || "application/octet-stream",
      },
      body,
      // Binary, and up to the route's 32 MiB cap — give it more headroom than
      // the 30s JSON default even though loopback makes it near-instant.
      timeoutMs: 60_000,
    })
    if (!res.ok) {
      throw new Error(`POST /files/upload failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    return (await res.json()) as { path: string; bytes: number }
  }

  /**
   * POST /sessions/:id/terminal/input — write text into a live PTY/terminal
   * session's stdin, mirroring the MCP `terminal_input` verb. `enter` (default
   * true) writes a lone carriage return in a SECOND write after the text so a
   * paste-detecting TUI (Claude Code) submits it as the Enter key. This is the
   * terminal-view reply path: a `kind: "terminal"` session has no agent
   * `prompt` route (that 400s for a PTY), so the composer routes here instead.
   */
  async writeTerminalInput(
    id: string,
    text: string,
    opts: { enter?: boolean } = {},
  ): Promise<{ ok: boolean }> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/terminal/input`, {
      text,
      ...(opts.enter === false ? { enter: false } : {}),
    })
  }

  async kill(id: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/kill`, {})
  }

  /** Cancel the in-flight turn on a live agent session and leave the
   *  session itself alive and idle — unlike `kill()`, which ends it. */
  async interrupt(id: string): Promise<{ ok: boolean; id: string; wasBusy: boolean }> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/interrupt`, {})
  }

  /**
   * Switch the model on a LIVE agent-cli session without restarting it —
   * `POST /sessions/:id/model`. Mirrors the daemon's non-fatal contract:
   * a rejected or unsupported switch resolves `{applied:false, reason}`
   * rather than throwing — only a genuinely bad request (unknown session,
   * missing model) throws. Callers check `applied`, they don't catch for it.
   */
  async setSessionModel(
    id: string,
    model: string,
  ): Promise<{ ok: boolean; id: string; applied: boolean; model?: string; reason?: string }> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/model`, { model })
  }

  async deleteSession(id: string): Promise<{ ok: boolean; id: string }> {
    return this.deleteJson(`/sessions/${encodeURIComponent(id)}`)
  }

  async exportSession(
    id: string,
    format: "markdown" | "json" = "markdown",
  ): Promise<{ content: string; format: string; adapter?: string }> {
    const url = `/sessions/${encodeURIComponent(id)}/export?format=${format}`
    return this.getJson(url)
  }

  async preview(
    id: string,
    lines = 10,
  ): Promise<{ id: string; lines: string[]; bytes: string | null }> {
    const url = `/sessions/${encodeURIComponent(id)}/preview?lines=${lines}`
    return this.getJson(url)
  }

  async wait(id: string, opts: WaitOptions = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (opts.event) params.set("event", opts.event)
    if (typeof opts.since === "number") params.set("since", String(opts.since))
    if (typeof opts.timeoutMs === "number") params.set("timeoutMs", String(opts.timeoutMs))
    const qs = params.toString()
    const url = `/sessions/${encodeURIComponent(id)}/wait${qs ? `?${qs}` : ""}`
    return this.getJson(url)
  }

  /**
   * GET /sessions/:id/events — a page of the daemon's durable, normalized
   * structured events (events.jsonl). This is the semantic source the
   * transcript panel hydrates and live-polls from (NOT the flattened
   * /stream lines, and NOT the global /events runtime stream).
   *
   * Throws {@link NoTranscriptError} on a 404 no_transcript so terminal-only
   * sessions can fall back to raw output; any other non-2xx throws normally.
   */
  async getSessionEvents(
    id: string,
    opts: SessionEventsOptions = {},
  ): Promise<SessionEventsPage> {
    const params = new URLSearchParams()
    if (typeof opts.since === "number") params.set("since", String(opts.since))
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
    const qs = params.toString()
    const path = `/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`
    const res = await this.authedFetch(path, {
      method: "GET",
      headers: { "content-type": "application/json" },
      timeoutMs: 30_000,
    })
    if (res.status === 404) {
      // Distinguish "no structured transcript" from other 404s so callers
      // can degrade to raw output rather than surfacing an error.
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (body.error === "no_transcript") throw new NoTranscriptError(id)
    }
    if (!res.ok) {
      throw new Error(`GET ${path} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    return (await res.json()) as SessionEventsPage
  }

  // ── Permissions ────────────────────────────────────────────────────

  async listPermissions(
    sessionId?: string,
  ): Promise<PendingPermission[]> {
    const url = sessionId
      ? `/permissions?sessionId=${encodeURIComponent(sessionId)}`
      : "/permissions"
    const body = await this.getJson<{ permissions: PendingPermission[] }>(url)
    return body.permissions ?? []
  }

  async respondPermission(
    id: string,
    input: RespondPermissionInput,
  ): Promise<{ ok: true; id: string; sessionId: string; decision: string; optionId?: string }> {
    return this.postJson(`/permissions/${encodeURIComponent(id)}`, input)
  }

  // ── Tunnels ────────────────────────────────────────────────────────

  async listTunnels(): Promise<unknown[]> {
    const body = await this.getJson<{ tunnels: unknown[] }>("/tunnels")
    return body.tunnels ?? []
  }

  // ── MCP surface (/mcp JSON-RPC 2.0) ────────────────────────────────

  /**
   * Invoke an MCP tool over the stateless /mcp endpoint (JSON-RPC 2.0
   * `tools/call`). Returns the parsed tool result — the MCP content
   * envelope is unwrapped, and a JSON text payload is JSON-parsed. Used
   * for MCP-only surfaces like adapter_list and session_events_poll.
   */
  async mcpCall<T = unknown>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
    const token = await this.resolveToken()
    const res = await this.fetchImpl(`${this.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable-HTTP MCP servers 406 unless the client accepts BOTH.
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`MCP ${toolName} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    const envelope = await parseMcpBody(res)
    if (envelope.error) {
      throw new Error(`MCP ${toolName} error: ${JSON.stringify(envelope.error)}`)
    }
    return unwrapMcpResult<T>(envelope.result)
  }

  /**
   * adapter_list is an MCP-only tool — fetch the daemon's installed
   * adapter registry via mcpCall("adapter_list").
   */
  async listAdapters(): Promise<AdapterInfo[]> {
    const result = await this.mcpCall<{ adapters?: AdapterInfo[] } | AdapterInfo[]>(
      "adapter_list",
    )
    if (Array.isArray(result)) return result
    return result.adapters ?? []
  }

  /**
   * Install an adapter (harness) by slug via the `adapter_install` MCP tool.
   * Returns the daemon's structured outcome — `ok` reflects the install
   * command's success, `status` the adapter's re-read readiness. An ordinary
   * install failure comes back as `{ ok:false }` (not a thrown error); only a
   * transport/protocol fault throws.
   */
  async installAdapter(slug: string): Promise<AdapterInstallResult> {
    return this.mcpCall<AdapterInstallResult>("adapter_install", { slug })
  }

  /**
   * `catalog_models` is an MCP-only tool — fetch the daemon's read-only
   * vendor/product/route model catalog.
   */
  async catalogModels(): Promise<CatalogModelsResponse> {
    const result = await this.mcpCall<CatalogModelsResponse>("catalog_models")
    return result ?? { vendors: [] }
  }

  /**
   * `catalog_provider_models` is an MCP-only tool — fetch the EXHAUSTIVE
   * model list a single provider can serve (the full surface the launch-menu
   * "+" picker browses, separate from the lean spawn `catalog_models`). An
   * unknown/empty provider comes back as `{ provider, models: [] }`, never an
   * error; large providers (openrouter) return whole, so paginate client-side.
   */
  async getCatalogProviderModels(
    provider: string,
  ): Promise<CatalogProviderModelsResponse> {
    const result = await this.mcpCall<CatalogProviderModelsResponse>(
      "catalog_provider_models",
      provider ? { endpoint: provider } : {},
    )
    return result ?? { provider, models: [] }
  }

  /**
   * `llm_endpoint_status` — the daemon-supervised `@agentproto/llm-endpoint`
   * proxy sidecar's lifecycle state {running, pid, port, baseUrl, healthy,
   * startedAt, status}. `healthy` reflects a live `GET /v1/models` probe. An
   * endpoint never started this boot resolves `status: "never-started"`.
   */
  async llmEndpointStatus(): Promise<LlmEndpointStatusResult> {
    return this.mcpCall<LlmEndpointStatusResult>("llm_endpoint_status")
  }

  /**
   * `llm_endpoint_start` — spawn (or reuse) the proxy child, injecting the
   * stored provider keys + port into its env. Idempotent: an already
   * running+healthy endpoint returns its existing descriptor (with
   * `wasAlreadyRunning: true`) rather than spawning a second process.
   */
  async llmEndpointStart(
    opts: LlmEndpointStartOptions = {},
  ): Promise<LlmEndpointDescriptorResult> {
    return this.mcpCall<LlmEndpointDescriptorResult>("llm_endpoint_start", {
      ...(opts.port != null ? { port: opts.port } : {}),
      ...(opts.accessTokens != null ? { accessTokens: opts.accessTokens } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.binPath ? { binPath: opts.binPath } : {}),
    })
  }

  /**
   * `llm_endpoint_stop` — SIGTERM the proxy child and mark it stopped.
   * Idempotent on an already-stopped (or never-started) endpoint.
   */
  async llmEndpointStop(): Promise<{ ok: boolean }> {
    return this.mcpCall<{ ok: boolean }>("llm_endpoint_stop")
  }

  /**
   * Hot-reload the proxy's local packs via its `POST /v1/packs/reload` route.
   * The proxy's HTTP surface is NOT exposed through the daemon MCP verbs, so —
   * exactly like the panel's `/v1/models` discovery — this reaches the child
   * DIRECTLY over loopback using the baseUrl the daemon reports in
   * `llm_endpoint_status` (not `mcpCall`). Throws when the router isn't running
   * (no base URL) or the reload is rejected (a 400 with the validation errors
   * from an invalid packs.local.json). Returns the reloaded pack ids + count.
   */
  async llmEndpointReloadPacks(): Promise<LlmEndpointReloadPacksResult> {
    const status = await this.llmEndpointStatus()
    const baseUrl =
      status.baseUrl ?? (status.port != null ? `http://localhost:${status.port}` : null)
    if (!baseUrl) {
      throw new Error("Local Router is not running — start it before reloading packs.")
    }
    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/packs/reload`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      // The proxy returns `{ error: { message, errors } }` on a 400; surface the
      // field-scoped errors so a bad packs.local.json edit is legible.
      const detail = await reloadErrorDetail(res)
      throw new Error(`Pack reload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`)
    }
    return (await res.json()) as LlmEndpointReloadPacksResult
  }

  /**
   * Run the proxy's per-upstream live test via its `POST
   * /v1/upstreams/:provider/test` route. Reaches the child DIRECTLY over
   * loopback using the baseUrl from `llm_endpoint_status` (the HTTP surface
   * isn't exposed through the daemon MCP verbs) — exactly the transport
   * `llmEndpointReloadPacks` uses. Throws when the router isn't running.
   * Returns the {ok, status, detail} verdict (or {ok:null, reason:"no-probe"}),
   * never a secret.
   */
  async llmEndpointTestUpstream(provider: string): Promise<LlmEndpointUpstreamTestResult> {
    const status = await this.llmEndpointStatus()
    const baseUrl =
      status.baseUrl ?? (status.port != null ? `http://localhost:${status.port}` : null)
    if (!baseUrl) {
      throw new Error("Local Router is not running — start it before testing an upstream.")
    }
    const res = await this.fetchImpl(
      `${baseUrl.replace(/\/+$/, "")}/v1/upstreams/${encodeURIComponent(provider)}/test`,
      { method: "POST", signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) {
      const detail = await reloadErrorDetail(res)
      throw new Error(`Upstream test failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`)
    }
    return (await res.json()) as LlmEndpointUpstreamTestResult
  }

  /**
   * `llm_endpoint_list_links` — the persisted upstream→auth-profile link map
   * plus, per upstream, the profiles ELIGIBLE to be linked (matching endpoint,
   * compatible method, not disabled). MCP verb (not loopback) — the links live
   * under `~/.agentproto`, read by the daemon. Never carries a secret.
   */
  async llmEndpointListLinks(): Promise<LlmEndpointLinksResult> {
    return this.mcpCall<LlmEndpointLinksResult>("llm_endpoint_list_links")
  }

  /**
   * `llm_endpoint_set_upstream_link` — persist (or clear, with `profileId:
   * null`) the link from an upstream to a named auth-profile. The daemon injects
   * it at the proxy's next spawn; a RUNNING proxy must be restarted to apply it
   * (`restartRequired` in the result). Never restarts the proxy itself.
   */
  async llmEndpointSetUpstreamLink(
    provider: string,
    profileId: string | null,
  ): Promise<LlmEndpointSetLinkResult> {
    return this.mcpCall<LlmEndpointSetLinkResult>("llm_endpoint_set_upstream_link", {
      provider,
      profileId,
    })
  }

  /**
   * `list_provider_presets` is an MCP-only tool — fetch the daemon's gateway
   * provider presets and their key-env availability status.
   */
  async listProviderPresets(): Promise<ProviderPresetEntry[]> {
    const result = await this.mcpCall<{ presets?: ProviderPresetEntry[] } | ProviderPresetEntry[]>(
      "list_provider_presets",
    )
    if (Array.isArray(result)) return result
    return result.presets ?? []
  }

  /**
   * `auth_profile_list` — the named auth profiles configured on this host
   * (non-secret metadata only; never the credential). Optionally filtered to
   * one billing endpoint.
   */
  async listAuthProfiles(endpoint?: string): Promise<AuthProfileSummary[]> {
    const result = await this.mcpCall<{ profiles?: AuthProfileSummary[] } | AuthProfileSummary[]>(
      "auth_profile_list",
      endpoint ? { endpoint } : {},
    )
    if (Array.isArray(result)) return result
    return result.profiles ?? []
  }

  /**
   * `auth_profile_create` — provision a named auth profile. The daemon writes
   * `req.credential` to the OS keychain and records the metadata; the
   * credential is INPUT-only and never returned. Response is non-secret
   * metadata plus a one-way fingerprint of the stored credential.
   */
  async createAuthProfile(
    req: CreateAuthProfileRequest,
  ): Promise<CreatedAuthProfileResult> {
    const result = await this.mcpCall<{ profile?: CreatedAuthProfileResult }>(
      "auth_profile_create",
      { ...req },
    )
    const profile = result.profile
    if (!profile) throw new Error("auth_profile_create returned no profile")
    return profile
  }

  /**
   * `auth_profile_delete` — remove a named profile and its keychain
   * credential. Idempotent: a missing id resolves `{ deleted: false }`.
   */
  async deleteAuthProfile(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.mcpCall<{ deleted: boolean; id: string }>("auth_profile_delete", { id })
  }

  /**
   * `auth_profile_set_enabled` (WS2) — enable/disable a whole profile. A
   * disabled profile is skipped by the eligibility predicate, so its models
   * drop to non-runnable. Metadata-only (the keychain credential is
   * untouched). Returns the updated non-secret profile.
   */
  async setAuthProfileEnabled(id: string, enabled: boolean): Promise<AuthProfileSummary> {
    const result = await this.mcpCall<{ profile?: AuthProfileSummary }>(
      "auth_profile_set_enabled",
      { id, enabled },
    )
    const profile = result.profile
    if (!profile) throw new Error("auth_profile_set_enabled returned no profile")
    return profile
  }

  /**
   * `auth_profile_set_models` (WS3) — set a profile's per-model curation
   * allowlist. `mode: "all"` services every eligible model (and clears any
   * stored allowlist); `mode: "allow"` narrows the profile to `ids` (each a
   * catalog `vendor/product` or route-qualified `ref`). Metadata-only.
   * Returns the updated non-secret profile.
   */
  async setAuthProfileModels(
    id: string,
    mode: "all" | "allow",
    ids: string[] = [],
  ): Promise<AuthProfileSummary> {
    const result = await this.mcpCall<{ profile?: AuthProfileSummary }>(
      "auth_profile_set_models",
      { id, mode, ids },
    )
    const profile = result.profile
    if (!profile) throw new Error("auth_profile_set_models returned no profile")
    return profile
  }

  /**
   * `auth_discover_credentials` — read-only scan of the known local credential
   * locations (Claude Code Keychain/OAuth file, Codex/Gemini logins,
   * `~/.hermes/config.yaml`, provider env keys). Returns found-but-not-imported
   * credentials with provenance and a non-secret `hint` locator only — NEVER a
   * credential value.
   */
  async discoverCredentials(): Promise<DiscoveredCredential[]> {
    const result = await this.mcpCall<
      { credentials?: DiscoveredCredential[] } | DiscoveredCredential[]
    >("auth_discover_credentials")
    if (Array.isArray(result)) return result
    return result.credentials ?? []
  }

  /**
   * `auth_profile_import` — materialize a credential DISCOVERED by
   * `discoverCredentials()` into a named auth profile (WS6). Source-backed
   * where possible, else the daemon COPIES the located api-key into the
   * keychain. No secret crosses the wire — the daemon reads it locally. The
   * result is non-secret metadata + a one-way fingerprint + the stamped
   * `origin`, never the credential.
   */
  async importCredential(req: ImportCredentialRequest): Promise<CreatedAuthProfileResult> {
    const result = await this.mcpCall<{ profile?: CreatedAuthProfileResult }>(
      "auth_profile_import",
      { ...req },
    )
    const profile = result.profile
    if (!profile) throw new Error("auth_profile_import returned no profile")
    return profile
  }

  /**
   * GET /workspaces — the daemon's registered workspace list
   * (~/.agentproto/workspaces.json). Read-only; see addWorkspace /
   * removeWorkspace / setActiveWorkspace below for mutation (also
   * available via the CLI's `agentproto workspace add/remove/use`).
   *
   * A session descriptor only carries `workspaceSlug`, so this is the join
   * table for rendering a human workspace name and for resolving a cwd back
   * to the workspace it belongs to. See services/workspaces.logic.ts.
   */
  async listWorkspaces(): Promise<WorkspacesConfig> {
    const body = await this.getJson<WorkspacesConfig>("/workspaces")
    return { ...body, version: 1, workspaces: body.workspaces ?? [] }
  }

  /**
   * GET /user-presets — the user's saved spawn presets
   * (~/.agentproto/presets.json on the daemon host). Plain REST, not MCP
   * (unlike listProviderPresets) — see http-server.ts:1930. Throws on a
   * daemon without the route, same as listWorkspaces; callers that want to
   * degrade gracefully wrap the call in try/catch (see spawn.ts's existing
   * catalogModels()/listWorkspaces() try/catch blocks) — do NOT swallow the
   * error inside this method itself.
   */
  async listUserPresets(): Promise<UserPreset[]> {
    const body = await this.getJson<{ presets?: UserPreset[] }>("/user-presets")
    return body.presets ?? []
  }

  /**
   * POST /user-presets — create or update a saved favorite (upsert by id),
   * the isomorphic counterpart to the CLI's `agentproto preset save`. Backs
   * the sessions tree's "Save as favorite…" action. Throws on a daemon
   * without the write route (a 404 there means "old daemon", surfaced as the
   * generic HTTP error) or on an invalid body (400 with the daemon's Zod
   * parse message). Returns the saved preset the daemon echoes back.
   */
  async saveUserPreset(preset: UserPreset): Promise<UserPreset> {
    const body = await this.postJson<{ preset?: UserPreset }>("/user-presets", preset)
    return body.preset ?? preset
  }

  /**
   * DELETE /user-presets/:id — remove a saved favorite. Resolves `false`
   * when the id was already absent (the daemon's 404), `true` on a delete.
   */
  async deleteUserPreset(id: string): Promise<boolean> {
    const res = await this.authedFetch(`/user-presets/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      timeoutMs: 30_000,
    })
    if (res.status === 404) return false
    if (!res.ok) {
      throw new Error(`DELETE /user-presets failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    const body = (await res.json()) as { deleted?: boolean }
    return body.deleted ?? true
  }

  /**
   * POST /workspaces — register a folder as an agentproto workspace, the
   * isomorphic counterpart to the CLI's `agentproto workspace add` (body
   * `{ path, slug?, label? }`, response is the updated WorkspacesConfig).
   * Backs the sessions tree's "Create workspace here" CTA.
   *
   * The route ships in the daemon as of #463, but a user's *running* daemon
   * may predate it — a 404 there means "old daemon", not "bad request", so
   * it's raised as {@link WorkspacesRouteMissingError} rather than a generic
   * failure, and the caller can degrade to a clear "update your daemon"
   * message instead of an opaque HTTP error.
   */
  async addWorkspace(
    path: string,
    opts: { slug?: string; label?: string } = {},
  ): Promise<WorkspacesConfig> {
    const res = await this.authedFetch("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, ...opts }),
      timeoutMs: 30_000,
    })
    if (res.status === 404) throw new WorkspacesRouteMissingError()
    if (!res.ok) {
      throw new Error(`POST /workspaces failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    const body = (await res.json()) as WorkspacesConfig
    return { ...body, version: 1, workspaces: body.workspaces ?? [] }
  }

  /**
   * DELETE /workspaces/:slug — drop a registered workspace. If it was
   * active, the daemon reassigns active to whatever's first (or clears it
   * when none remain) — see `removeWorkspace` in workspaces-config.ts.
   */
  async removeWorkspace(slug: string): Promise<WorkspacesConfig> {
    return this.deleteJson<WorkspacesConfig>(`/workspaces/${encodeURIComponent(slug)}`)
  }

  /**
   * PUT /workspaces/active — set the daemon's active workspace. 404s
   * (surfaced as a thrown Error) when `slug` isn't registered.
   */
  async setActiveWorkspace(slug: string): Promise<WorkspacesConfig> {
    return this.putJson<WorkspacesConfig>("/workspaces/active", { slug })
  }

  /**
   * session_events_poll — the daemon's cursor-based session lifecycle
   * stream. See SessionStore for the resilient poll loop that drives this.
   */
  async sessionEventsPoll(
    since = 0,
    types?: string[],
  ): Promise<SessionEventsPollResult> {
    return this.mcpCall<SessionEventsPollResult>("session_events_poll", {
      since,
      ...(types ? { types } : {}),
    })
  }

  // ── Token resolution (recon §Auth) ─────────────────────────────────

  /**
   * Resolve the daemon bearer token. Cached per-instance until
   * invalidateToken(). Resolution order: config.tokenPath override →
   * ~/.agentproto/daemons/<port>.json → workspace runtime.json (only if
   * it names our port). Returns undefined when no token can be found
   * (loopback daemons accept that).
   */
  resolveToken(): Promise<string | undefined> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.doResolveToken().catch(() => undefined)
    }
    return this.tokenPromise
  }

  /** Force re-resolution on the next call (after a config change, or a
   *  401 that says the daemon rebooted behind our cached token). */
  invalidateToken(): void {
    this.tokenPromise = undefined
  }

  private async doResolveToken(): Promise<string | undefined> {
    const { tokenPath } = this.config
    if (tokenPath) {
      const t = await readTokenFile(tokenPath)
      if (t) return t
    }
    const port = daemonPort(this.url)
    // The per-port registry is the only file attributable to the daemon we
    // are actually dialling, so it outranks the workspace file.
    const fromRegistry = await readPortRegistryToken(port, this.homeDir)
    if (fromRegistry) return fromRegistry
    return this.readWorkspaceToken(port)
  }

  private async readWorkspaceToken(port: string | undefined): Promise<string | undefined> {
    if (!port) return undefined
    try {
      // /health is a public liveness probe (no auth), so fetch it DIRECTLY
      // rather than through this.health() → request() → resolveToken(), which
      // would cycle.
      const res = await this.fetchImpl(`${this.url}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return undefined
      const health = (await res.json()) as { workspace?: unknown }
      if (typeof health.workspace !== "string" || !health.workspace) return undefined
      const meta = await readTokenMeta(join(health.workspace, ".agentproto", "runtime.json"))
      // This file is keyed by workspace, not port: a different daemon on the
      // same root may have written it. Only trust it when it names our port.
      if (metaPort(meta) !== Number(port)) return undefined
      return metaToken(meta)
    } catch {
      return undefined
    }
  }

  // ── HTTP primitives ─────────────────────────────────────────────────

  private async getJson<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  private async deleteJson<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path)
  }

  private async putJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body)
  }

  /**
   * Send a request with the resolved bearer, replaying it ONCE against a
   * freshly re-resolved token when the daemon answers `sessions_unauthorized`
   * — that 401 means it rebooted and minted a new token behind our cached
   * one. A second 401 is returned as-is for the caller to surface; never
   * loops. `body` is required to be already materialized so the replay can
   * re-send the same bytes without double-consuming a stream.
   */
  private async authedFetch(
    path: string,
    init: {
      method: string
      headers: Record<string, string>
      body?: string | Uint8Array
      timeoutMs: number
    },
  ): Promise<Response> {
    const send = async (token: string | undefined): Promise<Response> =>
      this.fetchImpl(`${this.url}${path}`, {
        method: init.method,
        headers: {
          ...init.headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      })
    const res = await send(await this.resolveToken())
    if (!(await isStaleTokenResponse(res))) return res
    this.invalidateToken()
    return send(await this.resolveToken())
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.authedFetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 30_000,
    })
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    if (res.status === 204) return undefined as unknown as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as unknown as T
  }
}

// ── Token file helpers (no @agentproto/relay dep — hand-rolled, ~30 lines) ──

/** The fields this client reads out of @agentproto/runtime's RuntimeMeta —
 *  the one shape behind BOTH `<workspace>/.agentproto/runtime.json` and
 *  `~/.agentproto/daemons/<port>.json`. */
interface TokenFileMeta {
  token?: unknown
  pid?: unknown
  port?: unknown
}

async function readTokenMeta(path: string): Promise<TokenFileMeta | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    const meta = JSON.parse(raw) as TokenFileMeta | null
    return meta ?? undefined
  } catch {
    return undefined
  }
}

function metaToken(meta: TokenFileMeta | undefined): string | undefined {
  if (!meta) return undefined
  return typeof meta.token === "string" && meta.token ? meta.token : undefined
}

function metaPort(meta: TokenFileMeta | undefined): number | undefined {
  if (!meta) return undefined
  return typeof meta.port === "number" ? meta.port : undefined
}

async function readTokenFile(path: string): Promise<string | undefined> {
  return metaToken(await readTokenMeta(path))
}

function daemonPort(daemonUrl: string): string | undefined {
  try {
    return new URL(daemonUrl).port || undefined
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = the pid exists but is owned by another user — still alive.
    return err instanceof Error && "code" in err && err.code === "EPERM"
  }
}

async function readPortRegistryToken(
  port: string | undefined,
  homeDir: string,
): Promise<string | undefined> {
  if (!port) return undefined
  const meta = await readTokenMeta(join(homeDir, ".agentproto", "daemons", `${port}.json`))
  // A registry entry outlives a daemon that died without cleaning up; a dead
  // pid means its token is stale. A meta with no pid stays trusted.
  if (typeof meta?.pid === "number" && !isPidAlive(meta.pid)) return undefined
  return metaToken(meta)
}

/**
 * True only for the daemon's stale/missing-bearer 401 — the one a token
 * re-resolve can fix. Read through a clone so the caller's describeError()
 * can still consume the original body.
 */
async function isStaleTokenResponse(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  try {
    const body = (await res.clone().json()) as { error?: unknown }
    return body.error === "sessions_unauthorized"
  } catch {
    return false
  }
}

// ── MCP response unwrapping ──────────────────────────────────────────

interface McpContentItem {
  type: string
  text?: string
}

interface McpResult {
  content?: McpContentItem[]
  isError?: boolean
}

interface McpResponse {
  jsonrpc: "2.0"
  id: number
  result?: McpResult
  error?: { code: number; message: string; data?: unknown }
}

/**
 * A streamable-HTTP MCP server may answer either plain JSON or an SSE body
 * (content-type text/event-stream) even for a single request/response —
 * in the SSE case the JSON-RPC envelope is the first `data:` frame.
 */
async function parseMcpBody(res: Response): Promise<McpResponse> {
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    return (await res.json()) as McpResponse
  }
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    const parsed = JSON.parse(payload) as McpResponse
    if (parsed.result !== undefined || parsed.error !== undefined) return parsed
  }
  throw new Error("MCP SSE response contained no JSON-RPC envelope")
}

function unwrapMcpResult<T>(result: McpResult | undefined): T {
  if (!result) return undefined as unknown as T
  if (result.isError) {
    const text = result.content?.[0]?.text ?? "MCP tool returned an error"
    throw new Error(text)
  }
  const text = result.content?.[0]?.text
  if (typeof text !== "string") return undefined as unknown as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown }
    if (typeof body.message === "string") return body.message
    if (typeof body.error === "string") return body.error
    return JSON.stringify(body)
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Extract a human-readable detail from the proxy's `POST /v1/packs/reload`
 * error body — shape `{ error: { message, errors: string[] } }`. Joins the
 * field-scoped validation errors when present so a bad packs.local.json edit
 * reads legibly in the toast; falls back to the message, then the status.
 */
async function reloadErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown; errors?: unknown } }
    const err = body.error
    if (err && Array.isArray(err.errors) && err.errors.length > 0) {
      return err.errors.filter((e): e is string => typeof e === "string").join("; ")
    }
    if (err && typeof err.message === "string") return err.message
    return ""
  } catch {
    return ""
  }
}

/**
 * Convenience constructor used by extension.ts — builds a DaemonClient
 * from the current workspace configuration.
 */
export function createDaemonClient(config: DaemonConfig): DaemonClient {
  return new DaemonClient(config)
}
