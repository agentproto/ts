/**
 * WP2 — the agent side of AIP-44 ACP, backed by a Mastra `AgentController`.
 *
 * Implements the `@agentclientprotocol/sdk` `Agent` interface: handles the
 * session lifecycle and, on `session/prompt`, drives a controller `Session`'s
 * `sendMessage()` — relaying its subscription events as ACP `session/update`s
 * (text deltas as `agent_message_chunk`, tool activity as `tool_call` /
 * `tool_call_update`), exactly as an IDE/host expects from codex or
 * claude-code.
 *
 * Beyond the prompt loop, this file bridges the rest of the session surface:
 *   - `session/load` — reconnect to the Mastra thread keyed by the ACP session
 *     id and replay its text history as user/agent message chunks
 *   - `tool_approval_required` / `tool_suspended` — parked controller runs
 *     surface as `session/request_permission` round-trips
 *   - `session/set_config_option` (model) and `session/set_mode` — applied via
 *     `session.model.switch` / `session.mode.switch`, with `model_changed` /
 *     `mode_changed` relayed back as config/mode session updates
 *   - image / audio / embedded-resource prompt blocks — passed to
 *     `sendMessage` as file attachments
 *
 * No Mastra-specific protocol knowledge leaks past this file; everything above
 * is the standard ACP wire, so the daemon spawns this like any other arm.
 */

import type {
  AgentSideConnection,
  Agent as AcpAgent,
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { AgentControllerEvent } from "@mastra/core/agent-controller"
import {
  createEventMapper,
  messageText,
  toolCallTitle,
  toolKindFor,
} from "./tool-call-map.js"

/** A prompt attachment in the shape `Session.sendMessage` accepts: text
 *  attachments carry raw text, binary ones base64 (Mastra inlines `text/*` /
 *  JSON as fenced code and forwards the rest as model file parts). */
export interface PromptFile {
  data: string
  mediaType: string
  filename?: string
}

/** The slice of a thread message that history replay reads (text parts). */
export interface ThreadMessageLike {
  role: string
  content?: { parts?: unknown[] }
}

/** The slice of a controller `Session` this host drives. Typed structurally so
 *  tests can script one and we don't couple to a specific @mastra/core
 *  version's `Session` generics. */
export interface ControllerSessionLike {
  subscribe(
    listener: (event: AgentControllerEvent) => void | Promise<void>,
  ): () => void
  sendMessage(input: { content: string; files?: PromptFile[] }): Promise<void>
  /** Abort the active run and send in one step — the interrupt semantics a
   *  mid-turn prompt maps to. */
  steer(input: { content: string }): Promise<void>
  abort(): void
  respondToToolApproval(input: {
    decision: "approve" | "decline" | "always_allow_category"
    toolCallId?: string
    declineContext?: { reason?: string; message?: string }
  }): void
  respondToToolSuspension(input: {
    resumeData: unknown
    toolCallId?: string
  }): Promise<void>
  model: {
    /** The currently-selected model id ('' when none selected yet). */
    get(): string
    switch(input: { modelId: string }): Promise<void>
  }
  mode: {
    switch(input: { modeId: string }): Promise<void>
  }
  thread: {
    listMessages(input: {
      threadId: string
      limit?: number
    }): Promise<ThreadMessageLike[]>
  }
}

/** The slice of an `AgentController` this host drives (structural, as above).
 *  `createSession` keys on (resourceId, scope) — one ACP session maps to one
 *  controller session via a unique scope, with the thread pinned to the ACP
 *  session id so memory recall is scoped exactly as before. */
export interface ControllerLike {
  init(): Promise<void>
  createSession(opts: {
    resourceId?: string
    scope?: string
    threadId?: string
  }): Promise<ControllerSessionLike>
}

/** Lazily builds the controller (so model/key/AGENT.md errors surface on the
 *  first prompt with a clear message, not at process spawn or session/new). */
export type ControllerFactory = () => Promise<{ controller: ControllerLike }>

/** The model catalog reported through the `model` session config option.
 *  Mirrors `models.allowed` in the manifest (index.ts) — keep in sync. Any
 *  Mastra-routable id is still accepted as a value; this is just what the
 *  client's selector lists. */
export const DEFAULT_MODEL_CATALOG: ReadonlyArray<{ id: string; name?: string }> = [
  { id: "openrouter/z-ai/glm-5.2" },
  { id: "openrouter/deepseek/deepseek-v4-pro" },
  { id: "openai/gpt-5" },
]

const APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "approve", name: "Approve", kind: "allow_once" },
  {
    optionId: "always_allow_category",
    name: "Always allow this category",
    kind: "allow_always",
  },
  { optionId: "decline", name: "Decline", kind: "reject_once" },
]

const SUSPENSION_OPTIONS: PermissionOption[] = [
  { optionId: "approve", name: "Continue", kind: "allow_once" },
  { optionId: "decline", name: "Cancel", kind: "reject_once" },
]

/** `_meta` keys used to carry Mastra suspension payloads over the ACP
 *  permission round-trip (ACP has no first-class tool-suspension surface). */
const META_SUSPEND_PAYLOAD = "mastra-agent/suspendPayload"
const META_RESUME_SCHEMA = "mastra-agent/resumeSchema"
const META_RESUME_DATA = "mastra-agent/resumeData"

interface SessionState {
  /** The controller session, created lazily on the first prompt. */
  session: ControllerSessionLike | null
  /** The in-flight prompt turn, if any. Turn-scoped (not session-scoped) so a
   *  superseding prompt cancelling this one can't clobber its own state. */
  turn: { cancelled: boolean } | null
  /** Model/mode chosen via ACP before the controller session exists (the
   *  daemon applies config right after session/new); applied on creation. */
  pendingModelId: string | null
  pendingModeId: string | null
  /** Suspended tool calls with an ACP permission request in flight, so a
   *  `tool_suspension_cancelled` can void the eventual client answer. */
  suspensions: Map<string, { cancelled: boolean }>
}

function emptySessionState(): SessionState {
  return {
    session: null,
    turn: null,
    pendingModelId: null,
    pendingModeId: null,
    suspensions: new Map(),
  }
}

/** Pull the user's text out of an ACP prompt (its `text` content blocks). */
export function promptText(params: PromptRequest): string {
  return promptContent(params).text
}

/** File name hint from a resource URI: its last path segment, if any. */
function filenameOf(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri) return undefined
  return uri.split("/").pop() || undefined
}

/** Coerce an embedded *text* resource's mime type to one Mastra inlines as
 *  fenced text (`text/*` or JSON) — its data is raw text, so letting e.g.
 *  `application/x-typescript` through would ship raw text as a base64 file
 *  part. */
function textMediaType(mimeType: string | null | undefined): string {
  if (mimeType && (mimeType.startsWith("text/") || mimeType === "application/json")) {
    return mimeType
  }
  return "text/plain"
}

/**
 * Split an ACP prompt into the user's text (its `text` blocks, exactly as
 * {@link promptText} always did) and file attachments: `image`/`audio` blocks
 * (base64 + mime type) and embedded `resource` blocks (text or blob contents).
 * `resource_link` blocks carry no contents to attach — hosts inline referenced
 * context as `resource` blocks when `embeddedContext` is on — so they are
 * skipped, as before.
 */
export function promptContent(params: PromptRequest): {
  text: string
  files: PromptFile[]
} {
  const blocks = Array.isArray(params.prompt) ? params.prompt : []
  let text = ""
  const files: PromptFile[] = []
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") text += block.text
        break
      case "image": {
        const filename = filenameOf(block.uri)
        files.push({
          data: block.data,
          mediaType: block.mimeType,
          ...(filename ? { filename } : {}),
        })
        break
      }
      case "audio":
        files.push({ data: block.data, mediaType: block.mimeType })
        break
      case "resource": {
        const resource = block.resource
        if (!resource || typeof resource !== "object") break
        const filename = filenameOf(resource.uri)
        if ("text" in resource && typeof resource.text === "string") {
          files.push({
            data: resource.text,
            mediaType: textMediaType(resource.mimeType),
            ...(filename ? { filename } : {}),
          })
        } else if ("blob" in resource && typeof resource.blob === "string") {
          files.push({
            data: resource.blob,
            mediaType: resource.mimeType || "application/octet-stream",
            ...(filename ? { filename } : {}),
          })
        }
        break
      }
      default:
        break
    }
  }
  return { text: text.trim(), files }
}

export class MastraAcpAgent implements AcpAgent {
  readonly #conn: AgentSideConnection
  readonly #buildController: ControllerFactory
  readonly #resource: string
  readonly #models: ReadonlyArray<{ id: string; name?: string }>
  readonly #sessions = new Map<string, SessionState>()
  #controller: ControllerLike | null = null

  constructor(
    conn: AgentSideConnection,
    buildController: ControllerFactory,
    resource = "mastra-agent",
    models: ReadonlyArray<{ id: string; name?: string }> = DEFAULT_MODEL_CATALOG,
  ) {
    this.#conn = conn
    this.#buildController = buildController
    // `resource` groups a user's threads in Mastra memory; one per agent here.
    this.#resource = resource
    this.#models = models
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // session/load reconnects the Mastra thread and replays its history.
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
      },
    }
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<Record<string, never>> {
    // The provider key is read from the spawn env by the model gateway — no
    // ACP-level auth handshake needed.
    return {}
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomId()
    this.#sessions.set(sessionId, emptySessionState())
    return { sessionId }
  }

  /**
   * Resume an existing session: reconnect the controller session (scope +
   * thread keyed by the ACP session id — `createSession` resumes an existing
   * Mastra thread with full history) and replay the conversation to the
   * client, as the `session/load` contract requires, via `user_message_chunk`
   * / `agent_message_chunk` updates.
   *
   * Unlike `prompt`, this NEEDS the controller now (replay reads the thread),
   * so build errors surface as this request's JSON-RPC error rather than a
   * first-prompt error chunk.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const sessionId = params.sessionId
    let state = this.#sessions.get(sessionId)
    if (!state) {
      state = emptySessionState()
      this.#sessions.set(sessionId, state)
    }
    const session = await this.#ensureSession(sessionId, state)
    const messages = await session.thread.listMessages({ threadId: sessionId })
    for (const message of messages) {
      // Only conversation text replays; tool traffic and system reminders have
      // no faithful ACP replay surface (chunks are the history wire).
      if (message.role !== "user" && message.role !== "assistant") continue
      const text = messageText(message)
      if (!text) continue
      await this.#conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate:
            message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text },
        },
      })
    }
    return { configOptions: this.#modelConfigOptions(this.#currentModelId(state)) }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) throw new Error(`unknown session ${params.sessionId}`)

    // ACP carries no queue-vs-interrupt signal on session/prompt: a prompt
    // landing mid-turn IS the interrupt path. Mark the active turn cancelled
    // here; the actual abort happens via `steer` (abort + send in one step).
    const interrupted = state.turn
    if (interrupted) interrupted.cancelled = true
    const turn = { cancelled: false }
    state.turn = turn

    const { text, files } = promptContent(params)
    try {
      const session = await this.#ensureSession(params.sessionId, state)

      // One mapper per turn: it holds the per-message "text already relayed"
      // state that turns Mastra's full-message updates into ACP deltas.
      const map = createEventMapper()
      let endReason: string | undefined
      let lastError: Error | null = null
      // Updates must hit the wire in event order; the listener is synchronous
      // while sessionUpdate is not, so sends are chained.
      let relay: Promise<void> = Promise.resolve()

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "error") {
          lastError = event.error
          return
        }
        if (event.type === "agent_end") {
          endReason = event.reason ?? "complete"
          return
        }
        if (event.type === "tool_approval_required") {
          // Sequence the permission request behind already-queued updates (so
          // the client has seen everything up to the gate), but don't block
          // later updates on the user's answer — the run itself is parked
          // until we respond, and `cancel` resolves it via abort().
          const tail = relay
          void tail
            .catch(() => {})
            .then(() => this.#bridgeApproval(params.sessionId, session, event))
            .catch(() => {})
          return
        }
        if (event.type === "tool_suspended") {
          const pending = { cancelled: false }
          state.suspensions.set(event.toolCallId, pending)
          const tail = relay
          void tail
            .catch(() => {})
            .then(() =>
              this.#bridgeSuspension(params.sessionId, session, state, event, pending),
            )
            .catch(() => {})
          return
        }
        if (event.type === "tool_suspension_cancelled") {
          // The SDK has no way to retract an in-flight outgoing request, so
          // the ACP permission request stays up; voiding the pending entry
          // makes its eventual answer a no-op instead.
          const pending = state.suspensions.get(event.toolCallId)
          if (pending) pending.cancelled = true
          state.suspensions.delete(event.toolCallId)
          return
        }
        const update = map(event)
        if (!update) return
        relay = relay.then(() =>
          this.#conn.sessionUpdate({ sessionId: params.sessionId, update }),
        )
      })
      try {
        // Awaits the whole run; events stream via the subscription above.
        if (interrupted) {
          if (files.length) {
            // `steer` can't carry attachments — unroll its abort+send.
            session.abort()
            await session.sendMessage({ content: text, files })
          } else {
            await session.steer({ content: text })
          }
        } else if (files.length) {
          await session.sendMessage({ content: text, files })
        } else {
          await session.sendMessage({ content: text })
        }
      } finally {
        unsubscribe()
        // Flush queued updates; a dead connection shouldn't mask the turn's
        // real outcome (and there is nowhere left to report it anyway).
        await relay.catch(() => {})
      }

      if (turn.cancelled || endReason === "aborted") {
        return { stopReason: "cancelled" }
      }
      if (endReason === "error") {
        // `sendMessage` resolves even when the run dies (the engine reports
        // via `error` events + agent_end reason) — re-throw into the shared
        // error path so the failure surfaces exactly as before.
        throw lastError ?? new Error("the agent run ended with an error")
      }
      return { stopReason: "end_turn" }
    } catch (err) {
      if (turn.cancelled) return { stopReason: "cancelled" }
      // Surface the failure to the client as a message chunk, then end the
      // turn — better UX than a bare JSON-RPC error the host may swallow.
      await this.#conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n[mastra-agent error] ${(err as Error).message}\n`,
          },
        },
      })
      return { stopReason: "refusal" }
    } finally {
      if (state.turn === turn) state.turn = null
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) return
    if (state.turn) state.turn.cancelled = true
    // abort() also declines a parked approval gate and drops parked
    // suspensions, so a run waiting on a permission answer still finalizes.
    state.session?.abort()
  }

  /**
   * The host applies the operator's `model` as a `--model` spawn arg via the
   * manifest `bin_args_template`, then ALSO calls this ACP config hook (the
   * daemon's default "config" apply path). Runtime switches go through
   * `session.model.switch`; a choice made before the controller session
   * exists is remembered and applied on creation, preserving the invariant
   * that controller build errors surface on the first prompt.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) throw new Error(`unknown session ${params.sessionId}`)
    if (params.configId === "model") {
      const modelId = String((params as { value?: unknown }).value ?? "")
      if (modelId) {
        if (state.session) await state.session.model.switch({ modelId })
        else state.pendingModelId = modelId
      }
    }
    // Unknown option ids are accepted and ignored; the full set reports back.
    return {
      configOptions: this.#modelConfigOptions(this.#currentModelId(state)),
    }
  }

  /** Switch the controller session's mode (the catalog itself is controller
   *  config — WP-3). Mode-change confirmations reach the client via the
   *  session-lifetime `mode_changed` → `current_mode_update` relay. */
  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<Record<string, never>> {
    const state = this.#sessions.get(params.sessionId)
    if (!state) throw new Error(`unknown session ${params.sessionId}`)
    if (state.session) await state.session.mode.switch({ modeId: params.modeId })
    else state.pendingModeId = params.modeId
    return {}
  }

  /** The ACP `model` config option (a select), reflecting `currentValue`.
   *  A free-form current id not in the catalog is appended so the reported
   *  state stays coherent. */
  #modelConfigOptions(currentValue: string): SessionConfigOption[] {
    const options = this.#models.map((m) => ({ value: m.id, name: m.name ?? m.id }))
    if (currentValue && !options.some((o) => o.value === currentValue)) {
      options.push({ value: currentValue, name: currentValue })
    }
    return [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        description: "Model id routed via Mastra's model gateway",
        currentValue,
        options,
      },
    ]
  }

  #currentModelId(state: SessionState): string {
    const selected = state.session?.model.get() ?? ""
    return selected || state.pendingModelId || this.#models[0]?.id || ""
  }

  /** Relay a parked `tool_approval_required` gate as an ACP permission
   *  request and feed the user's decision back to the controller session. */
  async #bridgeApproval(
    sessionId: string,
    session: ControllerSessionLike,
    event: Extract<AgentControllerEvent, { type: "tool_approval_required" }>,
  ): Promise<void> {
    const toolName = event.toolName || "tool"
    let decision: "approve" | "decline" | "always_allow_category" = "decline"
    try {
      const { outcome } = await this.#conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: event.toolCallId,
          title: toolCallTitle(toolName, event.args),
          kind: toolKindFor(toolName),
          status: "pending",
          rawInput: event.args,
        },
        options: APPROVAL_OPTIONS,
      })
      if (outcome.outcome === "selected") {
        if (
          outcome.optionId === "approve" ||
          outcome.optionId === "always_allow_category"
        ) {
          decision = outcome.optionId
        }
      }
      // "cancelled": session.abort() (the cancel path) already declined the
      // parked gate; the decline below is then a no-op.
    } catch {
      // The client errored/refused the request — decline so the parked run
      // can finalize instead of hanging.
    }
    session.respondToToolApproval({ decision, toolCallId: event.toolCallId })
  }

  /**
   * Relay a `tool_suspended` run as an ACP permission request. ACP's answer is
   * an option pick, not free-form data, so the suspend payload and resume
   * schema ride out on the request's `_meta` and the resume data rides back on
   * the outcome's `_meta` (`mastra-agent/resumeData`) when the client supplies
   * it — else Continue/Cancel resume with `{ approved: true | false }` (the
   * shape the built-in `submit_plan` approval path consumes).
   */
  async #bridgeSuspension(
    sessionId: string,
    session: ControllerSessionLike,
    state: SessionState,
    event: Extract<AgentControllerEvent, { type: "tool_suspended" }>,
    pending: { cancelled: boolean },
  ): Promise<void> {
    const toolName = event.toolName || "tool"
    try {
      const { outcome } = await this.#conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: event.toolCallId,
          title: toolCallTitle(toolName, event.args),
          kind: toolKindFor(toolName),
          status: "in_progress",
          rawInput: event.args,
          _meta: {
            [META_SUSPEND_PAYLOAD]: event.suspendPayload,
            ...(event.resumeSchema !== undefined
              ? { [META_RESUME_SCHEMA]: event.resumeSchema }
              : {}),
          },
        },
        options: SUSPENSION_OPTIONS,
      })
      if (pending.cancelled) return
      // "cancelled": abort() already dropped the parked suspension.
      if (outcome.outcome !== "selected") return
      const meta = outcome._meta as Record<string, unknown> | null | undefined
      const resumeData =
        meta && META_RESUME_DATA in meta
          ? meta[META_RESUME_DATA]
          : { approved: outcome.optionId === "approve" }
      await session.respondToToolSuspension({
        resumeData,
        toolCallId: event.toolCallId,
      })
    } catch {
      // Request failed at the client — resume as not-approved so the parked
      // run can finalize (unless the suspension was already cancelled).
      if (!pending.cancelled) {
        await session
          .respondToToolSuspension({
            resumeData: { approved: false },
            toolCallId: event.toolCallId,
          })
          .catch(() => {})
      }
    } finally {
      if (state.suspensions.get(event.toolCallId) === pending) {
        state.suspensions.delete(event.toolCallId)
      }
    }
  }

  /** Resolve this ACP session's controller session, creating it on first use.
   *  Deferred to the first prompt (not session/new) on purpose: controller
   *  construction parses the AGENT.md and resolves the model, and those
   *  errors must keep surfacing as a first-prompt error chunk + "refusal",
   *  never as a session/new JSON-RPC failure. (`session/load` opts into the
   *  eager path — replay can't happen without the controller.) */
  async #ensureSession(
    acpSessionId: string,
    state: SessionState,
  ): Promise<ControllerSessionLike> {
    if (state.session) return state.session
    const controller = await this.#ensureController()
    // Thread = ACP session id, resource = the shared agent resource — the same
    // memory layout the raw-stream host used, so recall stays scoped to this
    // session's history. `scope` keeps concurrent ACP sessions on distinct
    // controller sessions despite the shared resourceId.
    const session = await controller.createSession({
      resourceId: this.#resource,
      scope: acpSessionId,
      threadId: acpSessionId,
    })
    // Mode/model changes can fire outside a prompt turn (idle switches, mode
    // transitions), so they relay on this session-lifetime subscription — the
    // per-turn mapper deliberately ignores them.
    session.subscribe((event) => {
      if (event.type === "mode_changed") {
        void this.#conn
          .sessionUpdate({
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: event.modeId,
            },
          })
          .catch(() => {})
      } else if (event.type === "model_changed") {
        void this.#conn
          .sessionUpdate({
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "config_option_update",
              // Read the session's own selection: a `model_changed` scoped to
              // a non-active mode doesn't move the effective model.
              configOptions: this.#modelConfigOptions(
                session.model.get() || event.modelId,
              ),
            },
          })
          .catch(() => {})
      }
    })
    state.session = session
    // A mode/model chosen over ACP before the controller session existed
    // applies now — mode first, so an explicit model choice overrides the
    // incoming mode's per-mode model.
    if (state.pendingModeId) {
      const modeId = state.pendingModeId
      state.pendingModeId = null
      await session.mode.switch({ modeId })
    }
    if (state.pendingModelId) {
      const modelId = state.pendingModelId
      state.pendingModelId = null
      await session.model.switch({ modelId })
    }
    return session
  }

  async #ensureController(): Promise<ControllerLike> {
    // Memoize only on success so a transient failure retries on the next
    // prompt instead of pinning every future turn to the first error.
    if (this.#controller) return this.#controller
    const { controller } = await this.#buildController()
    await controller.init()
    this.#controller = controller
    return controller
  }
}

/** 16 random bytes as hex — matches the SDK example's session id shape. */
function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
