/**
 * Zero-dependency HTTP client for the agentproto daemon.
 *
 * The adapter is spawned as an ACP child with `AGENTPROTO_SESSION_ID` /
 * `AGENTPROTO_PARENT_SESSION_ID` in its env, but no daemon URL/token — unlike
 * the CLI (`packages/cli/src/commands/_daemon-helpers.ts`, read as reference),
 * this package cannot import `@agentproto/runtime` or `@agentproto/cli`
 * (would pull the whole daemon runtime into an agent process). So this is a
 * deliberately smaller reimplementation of that discovery order:
 *
 *   1. `AGENTPROTO_DAEMON_URL` env (+ optional `AGENTPROTO_DAEMON_TOKEN`)
 *   2. `<cwd>/.agentproto/runtime.json`
 *   3. `~/.agentproto/runtime.json`
 *   4. central registry `~/.agentproto/daemons/*.json`, newest-mtime-first
 *
 * Unlike the CLI helper, this skips the `workspaces.json` walk (needs
 * `@agentproto/runtime`'s config loader) and the declared-port preference
 * in the central registry (needs `loadConfig()`). Good enough for an agent
 * process discovering the daemon that spawned it or one on the same host.
 *
 * A runtime.json / registry entry whose `pid` is dead (`process.kill(pid, 0)`
 * throwing anything but `EPERM`) is never trusted — same footgun the CLI
 * helper guards against (a crashed daemon's stale token 401ing a fresh one
 * on the same port).
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

export interface DaemonEndpoint {
  url: string
  token?: string
  /** Path of the runtime.json / registry file the endpoint came from.
   *  Undefined when the endpoint came from env vars. */
  sourcePath?: string
}

/** Thrown when no daemon endpoint can be discovered. */
export class DaemonNotFoundError extends Error {
  constructor(message = "no agentproto daemon found — set AGENTPROTO_DAEMON_URL or run inside a daemon-spawned session") {
    super(message)
    this.name = "DaemonNotFoundError"
  }
}

/** Thrown on a non-2xx daemon HTTP response. */
export class DaemonHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = "DaemonHttpError"
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — it just probes for the process' existence.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === "EPERM" // exists, just not ours to signal
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Parse a runtime.json-shaped file into a live endpoint, or undefined when
 *  missing, malformed, or the recorded PID is dead. */
async function endpointFromRuntimeJson(
  path: string,
  isPidAlive: (pid: number) => boolean,
): Promise<DaemonEndpoint | undefined> {
  const parsed = await readJsonFile(path)
  if (!parsed || typeof parsed.port !== "number") return undefined
  if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) return undefined
  return {
    url: `http://${typeof parsed.bind === "string" ? parsed.bind : "127.0.0.1"}:${parsed.port}`,
    sourcePath: path,
    ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
  }
}

export interface DiscoverDaemonOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Override `homedir()` for BOTH `~/.agentproto/runtime.json` and the
   *  central registry dir (unless `registryDir` also overrides the latter
   *  separately) — test hook, so discovery never has to touch a real
   *  developer machine's `~/.agentproto`. */
  homeDir?: string
  /** Override the central registry directory — test hook. Wins over `homeDir`. */
  registryDir?: string
  /** Override the liveness check for a runtime.json / registry entry's
   *  `pid` — test hook. Defaults to a real `process.kill(pid, 0)` probe. */
  isPidAlive?: (pid: number) => boolean
}

/**
 * Resolve the first live daemon endpoint, in the order documented above.
 * Returns undefined when nothing live is found.
 */
export async function discoverDaemonEndpoint(
  opts: DiscoverDaemonOptions = {},
): Promise<DaemonEndpoint | undefined> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive

  if (env.AGENTPROTO_DAEMON_URL) {
    const url = env.AGENTPROTO_DAEMON_URL.replace(/\/+$/, "")
    return { url, ...(env.AGENTPROTO_DAEMON_TOKEN ? { token: env.AGENTPROTO_DAEMON_TOKEN } : {}) }
  }

  const cwdRuntime = await endpointFromRuntimeJson(resolvePath(cwd, ".agentproto", "runtime.json"), isPidAlive)
  if (cwdRuntime) return cwdRuntime

  const homeRuntime = await endpointFromRuntimeJson(resolvePath(homeDir, ".agentproto", "runtime.json"), isPidAlive)
  if (homeRuntime) return homeRuntime

  const registryDir = opts.registryDir ?? resolvePath(homeDir, ".agentproto", "daemons")
  let names: string[]
  try {
    names = await fs.readdir(registryDir)
  } catch {
    return undefined
  }
  const entries: Array<{ path: string; mtimeMs: number }> = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = join(registryDir, name)
    try {
      const st = await fs.stat(path)
      entries.push({ path, mtimeMs: st.mtimeMs })
    } catch {
      // skip unreadable entry
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs) // newest-mtime-first
  for (const entry of entries) {
    const ep = await endpointFromRuntimeJson(entry.path, isPidAlive)
    if (ep) return ep
  }
  return undefined
}

export interface StartAgentInput {
  adapter: string
  cwd?: string
  model?: string
  prompt?: string
  label?: string
}

export interface PromptAgentOptions {
  /** Cancel the in-flight turn and deliver this prompt instead. Default false. */
  interrupt?: boolean
  /** `false` returns as soon as the prompt is queued/validated, without
   *  waiting for the turn to drain. Default true (blocking). */
  wait?: boolean
}

export interface ListSessionsOptions {
  includeArchived?: boolean
  kind?: string
}

export interface ReadOutputOptions {
  format?: "markdown" | "json"
}

export interface PollEventsOptions {
  /** Cursor from a prior call's `nextSeq`. Omit to start from the beginning. */
  since?: number
  /** Client-side filter on each record's `kind` field. Omit → all kinds. */
  types?: string[]
  limit?: number
}

export interface PollEventsResult {
  sessionId: string
  events: Array<Record<string, unknown>>
  nextSeq: number
  complete: boolean
}

export interface DaemonClientOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Injectable fetch — test hook. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Pre-resolved endpoint — skips discovery, mainly a test hook. */
  endpoint?: DaemonEndpoint
  /** Test hooks forwarded to {@link discoverDaemonEndpoint}. */
  homeDir?: string
  registryDir?: string
  isPidAlive?: (pid: number) => boolean
}

/**
 * Thin HTTP client over the daemon's REST surface (`packages/runtime/src/http-server.ts`,
 * read-only reference — this package never imports it). Discovers the daemon
 * endpoint lazily on first call and caches it; a connection failure triggers
 * one re-discovery attempt (covers a daemon restart on the same well-known
 * runtime.json / registry path but a new port/token).
 */
export class DaemonClient {
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch
  private readonly homeDir: string | undefined
  private readonly registryDir: string | undefined
  private readonly isPidAlive: ((pid: number) => boolean) | undefined
  private cachedEndpoint: DaemonEndpoint | undefined

  constructor(opts: DaemonClientOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd()
    this.env = opts.env ?? process.env
    if (!opts.fetchImpl && typeof fetch !== "function") {
      throw new Error("DaemonClient requires a global `fetch` (Node >=18) or an injected `fetchImpl`.")
    }
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.homeDir = opts.homeDir
    this.registryDir = opts.registryDir
    this.isPidAlive = opts.isPidAlive
    this.cachedEndpoint = opts.endpoint
  }

  private async resolveEndpoint(forceRediscover = false): Promise<DaemonEndpoint> {
    if (this.cachedEndpoint && !forceRediscover) return this.cachedEndpoint
    const found = await discoverDaemonEndpoint({
      cwd: this.cwd,
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      ...(this.registryDir ? { registryDir: this.registryDir } : {}),
      ...(this.isPidAlive ? { isPidAlive: this.isPidAlive } : {}),
    })
    if (!found) throw new DaemonNotFoundError()
    this.cachedEndpoint = found
    return found
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const endpoint = await this.resolveEndpoint()
    const doFetch = async (ep: DaemonEndpoint) => {
      const url = new URL(path, ep.url)
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
      const headers: Record<string, string> = {}
      if (ep.token) headers.authorization = `Bearer ${ep.token}`
      if (opts.body !== undefined) headers["content-type"] = "application/json"
      return this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
    }

    let res: Response
    try {
      res = await doFetch(endpoint)
    } catch (err) {
      // Likely connection refused (daemon restarted / moved port) — re-discover
      // once and retry before giving up.
      const rediscovered = await this.resolveEndpoint(true)
      try {
        res = await doFetch(rediscovered)
      } catch (retryErr) {
        throw retryErr instanceof Error ? retryErr : new Error(String(retryErr))
      }
      void err
    }
    const text = await res.text()
    if (!res.ok) {
      throw new DaemonHttpError(
        `daemon HTTP ${res.status} ${method} ${path}: ${text.slice(0, 200)}`,
        res.status,
        text,
      )
    }
    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)
  }

  /**
   * Spawn a child session — `POST /sessions/agent`. `parentSessionId` is
   * derived from `AGENTPROTO_SESSION_ID` (set by the daemon on every
   * ACP-spawned adapter) when present, so session lineage is recorded
   * without the caller having to thread it through.
   */
  async startAgent(input: StartAgentInput): Promise<Record<string, unknown>> {
    const parentSessionId = this.env.AGENTPROTO_SESSION_ID
    return this.request("POST", "/sessions/agent", {
      body: {
        ...input,
        ...(parentSessionId ? { parentSessionId } : {}),
      },
    })
  }

  /** Send a follow-up turn to a live session — `POST /sessions/:id/prompt`. */
  async promptAgent(
    sessionId: string,
    text: string,
    opts: PromptAgentOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      body: { prompt: text, ...(opts.interrupt ? { interrupt: true } : {}) },
      query: opts.wait === false ? { wait: "false" } : {},
    })
  }

  /** List sessions — `GET /sessions`. */
  async listSessions(opts: ListSessionsOptions = {}): Promise<{ sessions: Array<Record<string, unknown>> }> {
    return this.request("GET", "/sessions", {
      query: {
        includeArchived: opts.includeArchived ? "true" : undefined,
        kind: opts.kind,
      },
    })
  }

  /**
   * Read a session's transcript — `GET /sessions/:id/export`. Chosen over
   * `/sessions/:id/conversation` (needs a provider-native store registered
   * for the adapter; not every adapter has one) and `/sessions/:id/preview`
   * (a raw ring-buffer snapshot, not a rendered transcript): `/export`
   * works for ANY agent-cli session, falling back to the daemon's own
   * `events.jsonl` capture when no provider-native reader is registered
   * (`source: "auto"`, see `transcript-export.ts`) — the one built for
   * programmatic reads of "what did this session say".
   */
  async readOutput(sessionId: string, opts: ReadOutputOptions = {}): Promise<Record<string, unknown>> {
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}/export`, {
      query: { format: opts.format ?? "json" },
    })
  }

  /**
   * Cursor-based poll of a session's structured event log —
   * `GET /sessions/:id/events`. NOT the same event source as the MCP
   * `session_events_poll` tool: that tool reads the daemon's in-memory,
   * cross-session `EventRing` (turn-end/awaiting-input/exited/... lifecycle
   * events, `packages/runtime/src/orchestration-tools.ts:528`), which has no
   * plain-HTTP equivalent — it's only reachable over the MCP JSON-RPC
   * transport, which this zero-dependency client doesn't speak. This route
   * is the per-SESSION structured `events.jsonl` transcript instead
   * (`packages/runtime/src/transcript-writer.ts`): cursor-based via
   * `since`/`nextSeq` same as the MCP tool, and its records DO carry many of
   * the same `kind`s (`turn-end`, `error`, `permission-resolved`, ...) — but
   * it has no `exited` / `session:spawned` records (those are registry
   * state changes, not transcript writes) and no cross-session fan-in
   * (`sessionIds` filter). `types` is therefore filtered client-side here
   * against each record's `kind`, not sent as a query param.
   *
   * WP-6 (`AgentprotoSignalProvider`, polling every 5s): this is a
   * non-blocking snapshot read, so it's a direct fit for a poll loop. If
   * WP-6 needs the actual cross-session lifecycle events (`exited`,
   * `session:spawned`, multi-session fan-in), it either needs its own
   * light MCP JSON-RPC client to call `session_events_poll` directly, or
   * per-session `GET /sessions/:id/wait?since=&event=` (a blocking
   * long-poll over the SAME EventRing `session_events_poll` reads, but
   * scoped to one session and one event name at a time — no `types` array).
   */
  async pollEvents(sessionId: string, opts: PollEventsOptions = {}): Promise<PollEventsResult> {
    const result = await this.request<PollEventsResult>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/events`,
      {
        query: {
          since: opts.since !== undefined ? String(opts.since) : undefined,
          limit: opts.limit !== undefined ? String(opts.limit) : undefined,
        },
      },
    )
    if (!opts.types || opts.types.length === 0) return result
    const wanted = new Set(opts.types)
    return {
      ...result,
      events: result.events.filter(e => typeof e.kind === "string" && wanted.has(e.kind as string)),
    }
  }
}
