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
 *   - the turn is then observed via the sessions API: events are mapped
 *     with @agentproto/adapter-claude-sdk's stream-json → ACP mappers
 *     (the payloads ARE Claude Code stream-json SDK messages — reused, not
 *     forked), and ONLY the vendor's own `result` event ends the prompt
 *     (AIP-66 §6: never a timer, never silence).
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
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  defaultCloudCliRunner,
  preflightAuth,
  sendPrompt as defaultSendPrompt,
  startCloudSession as defaultStartCloudSession,
  cloudChildEnv,
  type StartedCloudSession,
} from "./cli.js"
import {
  SessionsApi,
  keychainCredentialSource,
  type CloudEventsPage,
  type CredentialSource,
} from "./sessions-api.js"
import { validateRepoSource, type GitRunner } from "./repo-source.js"

/** Poll cadence: 2s, backing off to 10s while the turn is still running. */
export const POLL_INITIAL_MS = 2_000
export const POLL_MAX_MS = 10_000

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
   *  newest-first first page overlaps turns, so dedup is mandatory. */
  readonly seenEventIds: Set<string>
  promptInFlight: boolean
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
        // Sessions live in the vendor's cloud; re-attach is via the vendor
        // id, not an ACP session/load replay (AIP-66 §5).
        loadSession: false,
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
    for (;;) {
      const page = await this.#api.listEvents(
        vendorId,
        session.pollCursor ? { cursor: session.pollCursor } : {},
      )
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
        session.seenEventIds.add(event.event_id)
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
        } else if (
          event.event_type === "user" ||
          event.event_type === "assistant"
        ) {
          // Payloads ARE stream-json SDK messages — reuse the claude-sdk
          // adapter's mappers (assistant text → agent_message_chunk,
          // tool_use → tool_call, tool_result → tool_call_update).
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
