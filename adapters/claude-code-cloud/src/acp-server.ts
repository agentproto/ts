/**
 * The AIP-44 ACP server for Claude Code cloud sessions (AIP-66). This is
 * the binary the daemon spawns (`bin/claude-code-cloud-acp.mjs` → dist):
 * the vendor owns the machine and the harness, so this server does not run
 * any agent — it relays.
 *
 *   - `session/new` validates the cwd as a pushed, clean git checkout
 *     (AIP-66 §3) BEFORE any vendor side effect.
 *   - first `session/prompt` → `claude --cloud "<prompt>"` (start), later
 *     ones → `claude -p … --cloud <id>` (send-only).
 *   - `session/load` RE-ATTACHES to the vendor session id the host
 *     persisted on `meta.cloud.sessionId` (AIP-66 §5): the adopted id makes
 *     the next prompt a `sendPrompt` — the relay never starts a replacement
 *     vendor session.
 *   - the learned identity (`{ vendor, sessionId, url }`) is reported to
 *     the host through the meta file named by `AGENTPROTO_CLOUD_SESSION_META_FILE`
 *     (meta-file.ts) — never a credential (AIP-66 §8).
 *   - the turn is then observed via the sessions API: events are mapped
 *     with @agentproto/adapter-claude-sdk's stream-json → ACP mappers
 *     (the payloads ARE Claude Code stream-json SDK messages — reused, not
 *     forked), and ONLY the vendor's own `result` event ends the prompt
 *     (AIP-66 §6: never a timer, never silence). Transient read failures
 *     (HTTP 5xx, network) are retried with backoff before the prompt fails.
 *   - `result` carries `total_cost_usd` + `usage` → an ACP `usage_update`
 *     (AIP-66 §7); a result without usage emits none — unmeasured, never
 *     zero.
 *   - `session/cancel` is unsupported: the vendor exposes no interrupt
 *     verb, and AIP-66 §6 says a host without one reports it unsupported.
 */

import { Readable, Writable } from "node:stream"
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk"
import { promptText, sdkMessageToUpdates } from "@agentproto/adapter-claude-sdk"
import {
  defaultCloudCliRunner,
  sendPrompt as defaultSendPrompt,
  startCloudSession as defaultStartCloudSession,
  type StartedCloudSession,
} from "./cli.js"
import {
  SessionsApi,
  keychainCredentialSource,
  toCliSessionId,
  type CloudEventsPage,
  type CredentialSource,
} from "./sessions-api.js"
import { CLOUD_VENDOR_SLUG, writeCloudSessionMeta } from "./meta-file.js"
import { validateRepoSource } from "./repo-source.js"

/**
 * The wire shape the cloud events API serves as `event.payload`: a Claude
 * Code stream-json SDK message. Derived from `sdkMessageToUpdates`'s
 * parameter so this package does not need a direct dependency on
 * `@anthropic-ai/claude-agent-sdk` (which would otherwise be a transitive
 * dep of `adapter-claude-sdk` and could break under strict pnpm or leak
 * into the emitted d.ts).
 */
type SDKMessage = Parameters<typeof sdkMessageToUpdates>[0]

/** Poll cadence: 2s, backing off to 10s while the turn is still running. */
export const POLL_INITIAL_MS = 2_000
export const POLL_MAX_MS = 10_000

/**
 * Budget of consecutive transient `listEvents` failures before the turn's
 * observation fails: the first four are retried with the poll backoff, the
 * fifth consecutive one fails the turn. The bound decides only when READING
 * events becomes impossible — a turn still ENDS solely on a vendor `result`
 * event (AIP-66 §6).
 */
export const MAX_LIST_EVENTS_FAILURES = 5

/** Node/network error codes a transient fetch failure can surface (walked
 *  down the `cause` chain — undici wraps them under "fetch failed"). */
const NETWORK_ERROR_CODES =
  /^(ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR)/

/**
 * Worth retrying: an HTTP 5xx from the vendor API, or a network-level
 * failure. 4xx (auth, not-found, bad request) and payload/parse errors are
 * NOT transient — retrying them would just stall the turn.
 */
export function isTransientListEventsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (/\bHTTP 5\d\d\b/.test(err.message)) return true
  if (/fetch failed|network error|socket hang up/i.test(err.message)) return true
  let cause: unknown = err
  for (let depth = 0; depth < 4 && cause; depth += 1) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === "string" && NETWORK_ERROR_CODES.test(code)) return true
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}

/** Read the ACP prompt's text content blocks. */
export { promptText }

/** The observe surface the turn loop needs — satisfied by {@link SessionsApi}. */
export interface CloudEventsClient {
  listEvents(
    id: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<CloudEventsPage>
}

/** The start/send surface — satisfied by cli.ts's functions. */
export interface CloudCliDeps {
  startCloudSession(
    prompt: string,
    opts: { cwd: string },
  ): Promise<StartedCloudSession>
  sendPrompt(
    sessionId: string,
    text: string,
    opts: { cwd: string },
  ): Promise<{ stdout: string }>
}

export interface ClaudeCloudAcpDeps {
  /** Events client. Default: real {@link SessionsApi} on the keychain login. */
  api?: CloudEventsClient
  /** Vendor CLI. Default: cli.ts's start/send against the real runner. */
  cli?: CloudCliDeps
  /** Repo-source validator (AIP-66 §3). Default: real git invocations. */
  validateRepo?: (cwd: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  pollInitialMs?: number
  pollMaxMs?: number
}

interface CloudSessionState {
  readonly id: string
  readonly cwd: string
  /** Vendor session id (`session_…`), set by the first prompt's start. */
  vendorSessionId: string | null
  vendorUrl: string | null
  /** Events page cursor across polls; null until the API hands one back. */
  pollCursor: string | null
  /** Event ids already projected this turn (and previous turns) — the
   *  newest-first first page overlaps turns, so dedup is mandatory. Bounded:
   *  ids are remembered in projection order (oldest first) and the OLDEST
   *  are evicted past {@link SEEN_EVENT_IDS_LIMIT}, so the set cannot grow
   *  for the life of the session. */
  readonly seenEventIds: Set<string>
  promptInFlight: boolean
}

/**
 * Cap on remembered event ids per session. Dedup spans turns (an old
 * `result` must not end a new turn), but the session may live indefinitely —
 * so the set is bounded, evicting in insertion order: those ids were
 * projected on the earliest polls, behind the pagination cursor the API
 * serves forward from.
 */
export const SEEN_EVENT_IDS_LIMIT = 500

/**
 * Cap on history pages `session/load` pre-marks. A resume must mark every
 * event that already exists, but the vendor is paginated — one page is not
 * enough. The bound keeps a slow or pathological cursor from holding the
 * load open indefinitely; 50 pages is far past any realistic session.
 */
export const SEED_EVENT_PAGES_LIMIT = 50

/** Record a projected event id, evicting the oldest past the cap. */
function rememberSeenEventId(session: CloudSessionState, id: string): void {
  const seen = session.seenEventIds
  seen.add(id)
  while (seen.size > SEEN_EVENT_IDS_LIMIT) {
    const oldest = seen.values().next()
    if (oldest.done) break
    seen.delete(oldest.value)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function defaultDeps(): Required<
  Pick<ClaudeCloudAcpDeps, "api" | "cli" | "validateRepo">
> {
  const runner = defaultCloudCliRunner()
  const credentials: CredentialSource = keychainCredentialSource()
  return {
    api: new SessionsApi({ credentials }),
    cli: {
      startCloudSession: (prompt, opts) =>
        defaultStartCloudSession(prompt, {
          cwd: opts.cwd,
          runner,
          env: process.env,
        }),
      sendPrompt: (id, text, opts) =>
        defaultSendPrompt(id, text, {
          cwd: opts.cwd,
          runner,
          env: process.env,
        }),
    },
    validateRepo: (cwd: string) => validateRepoSource(cwd),
  }
}

/** Map a `result` event's payload to ACP updates. AIP-66 §7: usage is
 *  reported only when the vendor's event carries it; absent usage is
 *  UNMEASURED — never a fabricated zero. The shared mapper handles the
 *  shape; we normalize the two fields it reads defensively (`modelUsage`,
 *  `usage`). */
export function resultEventUpdates(payload: unknown): SessionUpdate[] {
  const p = (payload ?? {}) as {
    usage?: unknown
    total_cost_usd?: unknown
    modelUsage?: unknown
  }
  const hasUsage = p.usage != null || typeof p.total_cost_usd === "number"
  if (!hasUsage) return []
  const normalized = {
    ...p,
    type: "result",
    modelUsage: p.modelUsage ?? {},
    usage: p.usage ?? { input_tokens: 0, output_tokens: 0 },
  }
  return sdkMessageToUpdates(normalized as unknown as SDKMessage).filter(
    u => u.sessionUpdate === "usage_update",
  )
}

/** Stop reason from the `result` payload: an error (or any non-success
 *  subtype) stops as `refusal` — ACP has no dedicated error stop. */
export function resultStopReason(payload: unknown): StopReason {
  const p = (payload ?? {}) as { is_error?: boolean; subtype?: string }
  if (p.is_error === true) return "refusal"
  if (p.subtype !== undefined && p.subtype !== "success") return "refusal"
  return "end_turn"
}

function errorResultText(payload: unknown): string | null {
  const p = (payload ?? {}) as { result?: unknown }
  if (typeof p.result === "string" && p.result.trim()) return p.result
  return null
}

export class ClaudeCloudAcpAgent implements Agent {
  readonly #conn: AgentSideConnection
  readonly #api: CloudEventsClient
  readonly #cli: CloudCliDeps
  readonly #validateRepo: (cwd: string) => Promise<void>
  readonly #sleep: (ms: number) => Promise<void>
  readonly #pollInitialMs: number
  readonly #pollMaxMs: number
  readonly #sessions = new Map<string, CloudSessionState>()

  constructor(conn: AgentSideConnection, deps: ClaudeCloudAcpDeps = {}) {
    // Defaults are lazy: the real SessionsApi/keychain/runner only touch
    // the system when a turn actually runs — safe to construct always.
    const defaults = defaultDeps()
    this.#conn = conn
    this.#api = deps.api ?? defaults.api
    this.#cli = deps.cli ?? defaults.cli
    this.#validateRepo = deps.validateRepo ?? defaults.validateRepo
    this.#sleep = deps.sleep ?? defaultSleep
    this.#pollInitialMs = deps.pollInitialMs ?? POLL_INITIAL_MS
    this.#pollMaxMs = deps.pollMaxMs ?? POLL_MAX_MS
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // Re-attach rides ACP `session/load` with the vendor session id the
        // host persisted on `meta.cloud.sessionId` (AIP-66 §5) — that call
        // ADOPTS the existing cloud session, it never starts a new one.
        loadSession: true,
      },
    }
  }

  async authenticate(): Promise<void> {
    // Auth is the user's claude.ai login, owned by the claude CLI —
    // preflighted per turn (see cli.ts). No ACP handshake.
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // AIP-66 §4: mcpServers has no meaning for a vendor-owned harness —
    // refuse rather than silently drop (the host-level gate refuses the
    // whole spawn field set; this is the relay's own fail-closed backstop).
    if (params.mcpServers && params.mcpServers.length > 0) {
      throw new Error(
        "claude code cloud: mcpServers is not supported for managed cloud " +
          "agents (AIP-66 §4) — the vendor owns the harness",
      )
    }
    // AIP-66 §3 — refuse BEFORE any vendor side effect.
    await this.#validateRepo(params.cwd)
    const id = crypto.randomUUID()
    this.#sessions.set(id, {
      id,
      cwd: params.cwd,
      vendorSessionId: null,
      vendorUrl: null,
      pollCursor: null,
      seenEventIds: new Set(),
      promptInFlight: false,
    })
    return { sessionId: id }
  }

  /**
   * AIP-66 §5 re-attach: ADOPT the vendor session id the host persisted on
   * `meta.cloud.sessionId` as this ACP session's vendor session. No vendor
   * side effect happens here — the next `session/prompt` goes through
   * `sendPrompt` (`claude -p … --cloud <id>`), never `startCloudSession`,
   * so a resumed relay can never replace the vendor's session with a new
   * one. The adopted id is also reported back to the host's meta file so a
   * re-attach against a fresh config dir still carries the §5 mapping.
   *
   * Fails closed on an id the vendor could never own (e.g. the ACP uuid of
   * a spawn whose vendor id was never learned): no session is started in
   * its place.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Same §4 backstop as session/new — resume passes the host's persisted
    // mcpServers (empty for a cloud spawn; a non-empty list still means
    // "silently drop the field", which §4 forbids).
    if (params.mcpServers && params.mcpServers.length > 0) {
      throw new Error(
        "claude code cloud: mcpServers is not supported for managed cloud " +
          "agents (AIP-66 §4) — the vendor owns the harness",
      )
    }
    // Reject a malformed session id BEFORE the repo check: the id is what
    // identifies the session to re-attach, so a bad one is reported first
    // (AIP-66 §5) rather than masked by an unrelated repo-source failure.
    let vendorSessionId: string
    try {
      // Accepts the vendor's own spellings (`session_<id>` / `cse_<id>`)
      // and normalizes to the CLI's; anything else (an unlearned ACP uuid)
      // is rejected here rather than handed to the vendor below.
      vendorSessionId = toCliSessionId(params.sessionId)
    } catch {
      throw new Error(
        `claude code cloud: session/load needs the vendor session id, got ` +
          `${JSON.stringify(params.sessionId)} — expected session_<id> or ` +
          `cse_<id> (AIP-66 §5). That id was never learned onto ` +
          "meta.cloud.sessionId, so there is no vendor session to re-attach " +
          "to — and this relay will not start a replacement.",
      )
    }
    // AIP-66 §3 — refuse BEFORE any vendor side effect: a re-attach runs
    // code from this cwd on the vendor's machine too.
    await this.#validateRepo(params.cwd)
    // Keyed BY THE VENDOR ID: the ACP client registers the loaded session
    // under the id it passed in, so `session/prompt` (and our own
    // `session/update` notifications) address this state by that id.
    const session: CloudSessionState = {
      id: vendorSessionId,
      cwd: params.cwd,
      vendorSessionId,
      vendorUrl: null,
      pollCursor: null,
      seenEventIds: new Set(),
      promptInFlight: false,
    }
    this.#sessions.set(vendorSessionId, session)
    // The vendor's history is already there: pre-mark every existing event
    // id so the first post-attach prompt is ended ONLY by ITS own `result`
    // (AIP-66 §6) — without this, the previous turn's `result`, still in
    // the newest events page, would end the new turn on arrival.
    await this.#seedSeenEvents(session, vendorSessionId)
    // Report the adopted identity (meta-file.ts) — the host re-persists
    // `meta.cloud = { vendor, sessionId, url? }` from it.
    await writeCloudSessionMeta({ vendor: CLOUD_VENDOR_SLUG, sessionId: vendorSessionId })
    // The ACP client keys the loaded session on the id IT sent (the vendor
    // id) — `LoadSessionResponse` carries no id of its own.
    return {}
  }

  /** Mark the vendor's pre-existing events as already projected. Best
   *  effort: a failed seed degrades to (at worst) an early end on an older
   *  `result` — it must never turn a re-attach into a failed load, which
   *  AIP-66 §5 forbids replacing with a fresh start anyway.
   *
   *  Walks the WHOLE history, oldest page first, following `resume_cursor`
   *  until it stops advancing (or a page comes back empty) — one page is
   *  not enough: a later page can hold the previous turn's `result`, which
   *  would otherwise end the first post-attach prompt on arrival. The
   *  events API is newest-first WITHIN a page and pages forward in time, so
   *  `pollCursor` must end at the NEWEST position (the last cursor we
   *  advanced to) — that is exactly where {@link #observeTurn}'s normal
   *  poll loop resumes from, so the first poll returns only events written
   *  after the history just marked. */
  async #seedSeenEvents(session: CloudSessionState, vendorSessionId: string): Promise<void> {
    try {
      let cursor: string | undefined
      for (let page = 0; page < SEED_EVENT_PAGES_LIMIT; page += 1) {
        const res = await this.#api.listEvents(
          vendorSessionId,
          cursor ? { cursor } : {},
        )
        const events = res.data ?? []
        for (const event of events) rememberSeenEventId(session, event.event_id)
        const next = res.resume_cursor
        // Exhausted when the page is empty, there is no cursor, or the
        // cursor did not advance (the API repeats the newest cursor at the
        // end of history).
        if (events.length === 0 || !next || next === cursor) break
        cursor = next
      }
      if (cursor !== undefined) session.pollCursor = cursor
    } catch (err) {
      process.stderr.write(
        `[claude-code-cloud] session/load: could not pre-mark the vendor's ` +
          `existing events (${err instanceof Error ? err.message : String(err)})\n`,
      )
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error(`unknown session ${params.sessionId}`)
    if (session.promptInFlight) {
      // session/cancel is unsupported (no vendor interrupt verb), so a
      // second concurrent turn cannot be honoured honestly.
      throw new Error(
        "claude code cloud: a turn is already in flight — session/cancel is " +
          "unsupported (AIP-66 §6)",
      )
    }
    session.promptInFlight = true
    try {
      const text = promptText(params)
      if (!session.vendorSessionId) {
        const started = await this.#cli.startCloudSession(text, {
          cwd: session.cwd,
        })
        session.vendorSessionId = started.sessionId
        session.vendorUrl = started.url
        // Report the learned §5 identity to the host (meta-file.ts) — the
        // ONLY three fields written are vendor/sessionId/url; the vendor's
        // OAuth credential never enters this file (AIP-66 §8).
        await writeCloudSessionMeta({
          vendor: CLOUD_VENDOR_SLUG,
          sessionId: started.sessionId,
          url: started.url,
        })
        // Surface the session URL (AIP-66 security considerations: the user
        // must be able to inspect what the vendor is running).
        await this.#conn.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `[claude-code-cloud] ${started.title ? `${started.title} — ` : ""}${started.url}`,
            },
          },
        })
      } else {
        await this.#cli.sendPrompt(session.vendorSessionId, text, {
          cwd: session.cwd,
        })
      }
      return await this.#observeTurn(session)
    } finally {
      session.promptInFlight = false
    }
  }

  /** Read events until a NEW `result` event ends the turn (AIP-66 §6). */
  async #observeTurn(session: CloudSessionState): Promise<PromptResponse> {
    const vendorId = session.vendorSessionId
    if (!vendorId) throw new Error("claude code cloud: no vendor session")
    let delay = this.#pollInitialMs
    let failures = 0
    for (;;) {
      let page: CloudEventsPage
      try {
        page = await this.#api.listEvents(
          vendorId,
          session.pollCursor ? { cursor: session.pollCursor } : {},
        )
      } catch (err) {
        // A transient read failure (HTTP 5xx, network) says nothing about the
        // turn — retry with the poll backoff, up to MAX_LIST_EVENTS_FAILURES
        // consecutive failures. Non-transient errors and an exhausted budget
        // fail the prompt; only a vendor `result` ever ENDS the turn.
        if (
          !isTransientListEventsError(err) ||
          failures + 1 >= MAX_LIST_EVENTS_FAILURES
        ) {
          throw err
        }
        failures += 1
        await this.#sleep(delay)
        delay = Math.min(delay * 2, this.#pollMaxMs)
        continue
      }
      failures = 0
      if (page.resume_cursor) session.pollCursor = page.resume_cursor
      const fresh = (page.data ?? [])
        .filter(event => !session.seenEventIds.has(event.event_id))
        .sort((a, b) => {
          if (a.created_at !== b.created_at) {
            return a.created_at < b.created_at ? -1 : 1
          }
          return a.event_id < b.event_id ? -1 : 1
        })
      let stopReason: StopReason | null = null
      for (const event of fresh) {
        rememberSeenEventId(session, event.event_id)
        if (event.event_type === "result") {
          if (resultStopReason(event.payload) === "refusal") {
            const errText = errorResultText(event.payload)
            if (errText) {
              await this.#send(session.id, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: errText },
              })
            }
          }
          for (const update of resultEventUpdates(event.payload)) {
            await this.#send(session.id, update)
          }
          stopReason = resultStopReason(event.payload)
        } else if (event.event_type === "user") {
          // Follow-up turns: the vendor echoes the user's own prompt back as
          // a `user` event — the host already rendered that prompt, so it is
          // NEVER replayed as a chunk. Only `tool_result` blocks project
          // (tool_call_update); every other user payload is dropped here.
          for (const update of sdkMessageToUpdates(
            event.payload as unknown as SDKMessage,
          )) {
            if (update.sessionUpdate === "agent_message_chunk") continue
            await this.#send(session.id, update)
          }
        } else if (event.event_type === "assistant") {
          // Payloads ARE stream-json SDK messages — reuse the claude-sdk
          // adapter's mappers (assistant text → agent_message_chunk,
          // tool_use → tool_call).
          for (const update of sdkMessageToUpdates(
            event.payload as unknown as SDKMessage,
          )) {
            await this.#send(session.id, update)
          }
        }
        // system / env_manager_log / rate_limit_event / … carry no ACP
        // projection; they still consume a seen-id above.
      }
      if (stopReason) return { stopReason }
      await this.#sleep(delay)
      delay = Math.min(delay * 2, this.#pollMaxMs)
    }
  }

  async #send(sessionId: string, update: SessionUpdate): Promise<void> {
    await this.#conn.sessionUpdate({ sessionId, update } as SessionNotification)
  }

  /** Unsupported: the vendor exposes no interrupt verb (AIP-66 §6). Throwing
   *  reports it — the in-flight poll loop is NOT aborted (we cannot stop the
   *  cloud turn; lying "cancelled" would violate §6's end-on-vendor-event
   *  rule). */
  async cancel(_params: CancelNotification): Promise<void> {
    throw new Error(
      "claude code cloud: session/cancel is unsupported — the vendor " +
        "exposes no interrupt verb for cloud sessions (AIP-66 §6)",
    )
  }

  /** No runtime-configurable options (no model menu — the vendor picks the
   *  model). Empty set so a host that tries to set one doesn't error. */
  async setSessionConfigOption(
    _params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return { configOptions: [] }
  }

  /** No agent-specific modes; accept and ignore. */
  async setSessionMode(
    _params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    return {}
  }
}

/** Boot the ACP server over stdio — what bin/claude-code-cloud-acp.mjs runs. */
export function runAcpOverStdio(deps: ClaudeCloudAcpDeps = {}): AgentSideConnection {
  const toClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const fromClient = Readable.toWeb(
    process.stdin,
  ) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(toClient, fromClient)
  return new AgentSideConnection(
    conn => new ClaudeCloudAcpAgent(conn, deps),
    stream,
  )
}

/** Entry point for bin/claude-code-cloud-acp.mjs. */
export function main(): void {
  runAcpOverStdio()
}
