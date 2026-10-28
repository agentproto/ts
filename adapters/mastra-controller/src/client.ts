/**
 * `AgentCliClient` for a Mastra `AgentController` built from a
 * `mastra.agent-controller/v1` manifest.
 *
 * `connect()` reads the manifest (path from the `manifest` option, carried
 * in env as {@link MANIFEST_ENV_KEY}), builds the controller through
 * {@link createAgentControllerHost}, `init()`s it and opens one session,
 * entering the requested mode (`connect({ mode })`, else the
 * `controller_mode` option, else the manifest's default mode). `send()`
 * starts a turn with `session.sendMessage`; `events()` yields that turn's
 * controller events mapped through `mapMastraEvent`; `cancel()` aborts the
 * running turn (`turn-end` reason `cancelled`); `close()` destroys the
 * controller.
 *
 * Modes: the manifest's modes are this session's `availableModes`;
 * `setSessionMode()` calls `session.mode.switch`. AIP-45 has no mode-change
 * stream event, so a switch the controller makes by itself (a mode's
 * `transitionsTo` after an approved plan) surfaces as a `thought` notice
 * and moves `currentModeId`.
 *
 * Requests: controller suspensions become AIP-45 `agent-prompt` events,
 * answered through `respondPermission(requestId, resolution)`:
 *
 *   - `tool_approval_required`: options `approve` (allow_once),
 *     `always_allow` (allow_always: a session grant for that tool, then
 *     approve) and `decline` (reject_once), answered with
 *     `respondToToolApproval`.
 *   - `tool_suspended` for `ask_user`: one `answer:<i>` option per choice,
 *     or a single `answer` whose text is the resolution's `feedback`, plus
 *     `decline`; answered with `respondToToolSuspension(answer)`. A
 *     resolution names one option, so a `multi_select` question is answered
 *     with a single pick (wrapped in an array, as the tool expects).
 *   - `tool_suspended` for `submit_plan`: `approve` / `reject`, answered
 *     with `respondToToolSuspension({ action })`. The plan path comes from
 *     the model, so its text is read only from a regular file under the
 *     session cwd (symlinks resolved), at most `MAX_PLAN_BYTES`; otherwise
 *     the prompt carries "plan not readable: <reason>" instead.
 *   - `tool_suspended` for any other tool: `approve` / `decline`, answered
 *     with `respondToToolSuspension({ approved })`.
 *
 * The resolution's `feedback` is the free-text answer of an open question,
 * the reason of a denied tool, and the revision note of a rejected plan.
 * An approved plan lets the controller switch to the mode's `transitionsTo`
 * (the notice above); a rejected one stays in the current mode. A run
 * parked on a suspension keeps its turn open until the answer resumes it.
 * The manifest's `permissions` rules are set on the session at connect, so
 * the controller itself allows or denies a matching tool without asking.
 * `ask_user` and `submit_plan` default to `allow` there (their suspension
 * is the prompt), unless the manifest names them.
 *
 * Requests are surfaced only when the host connects with `permissionHold`
 * (the daemon's permission inbox). Without it nobody would answer, so the
 * client answers in place, like the ACP arm's auto-allow default: tools
 * are approved, other suspensions continue, a question gets a "no user"
 * answer and a plan is rejected (never escalated out of its mode).
 */

import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { open, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import type { AgentController, Session } from "@mastra/core/agent-controller"
import {
  createMastraMapperState,
  mapMastraEvent,
  type AgentCliClient,
  type AgentCliConnectOptions,
  type AgentCliHandle,
  type SessionMode,
  type StreamEvent,
} from "@agentproto/harness"
import { createAgentControllerHost, type AgentControllerHost } from "./host.js"
import { parseControllerManifest, type ControllerManifest } from "./manifest.js"

/** Env var carrying the `manifest` option: path to the controller manifest. */
export const MANIFEST_ENV_KEY = "AGENTPROTO_MASTRA_CONTROLLER_MANIFEST"
/** Env var carrying the `controller_mode` option: mode to enter at spawn. */
export const MODE_ENV_KEY = "AGENTPROTO_MASTRA_CONTROLLER_MODE"

/** What the client holds once connected. */
export interface MastraControllerSessionState {
  controller: AgentController
  session: Session
  manifest: ControllerManifest
  /** Mode the session is in, one of the manifest's `modes[].id`. */
  modeId: string
}

export interface MastraControllerClientOptions {
  /** Builds the controller. Default: `createAgentControllerHost()` (no resolvers). */
  host?: AgentControllerHost
  /** Manifest to use instead of reading the `manifest` option's file. */
  manifest?: ControllerManifest | string
}

type ControllerEvent = { type: string } & Record<string, unknown>

type PermissionResolution = Parameters<NonNullable<AgentCliClient["respondPermission"]>>[1]

/** `_meta` keys carried on the `agent-prompt` events this client raises. */
export const META_REQUEST = "mastra-controller/request"
export const META_SUSPEND_PAYLOAD = "mastra-controller/suspendPayload"
export const META_TRANSITIONS_TO = "mastra-controller/transitionsTo"
export const META_PLAN = "mastra-controller/plan"

/** Builtins whose suspension is the question itself, allowed past the approval gate by default. */
const SELF_GATED_TOOLS = ["ask_user", "submit_plan"] as const

/** Largest plan file whose text rides on a plan-approval prompt. */
const MAX_PLAN_BYTES = 256 * 1024

const NO_USER_ANSWER =
  "No user is attached to answer this question. Proceed with your best judgement."
const NO_APPROVER_FEEDBACK =
  "No approver is attached to this session, so the plan was not approved."

/** A controller request surfaced as `agent-prompt`, awaiting `respondPermission`. */
type PendingRequest =
  | { kind: "tool-approval"; toolCallId: string; toolName: string }
  | { kind: "question"; toolCallId: string; choices: string[]; multi: boolean }
  | { kind: "plan-approval"; toolCallId: string }
  | { kind: "suspension"; toolCallId: string }

/** One turn's event buffer: pushed by the session listener, drained by `events()`. */
class TurnQueue {
  private items: StreamEvent[] = []
  private done = false
  private wake: (() => void) | undefined

  push(evt: StreamEvent): void {
    if (this.done) return
    this.items.push(evt)
    this.wake?.()
  }

  end(): void {
    this.done = true
    this.wake?.()
  }

  get ended(): boolean {
    return this.done
  }

  async *drain(): AsyncIterable<StreamEvent> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
        continue
      }
      if (this.done) return
      await new Promise<void>(r => (this.wake = r))
      this.wake = undefined
    }
  }
}

export function createAgentCliClient(
  _definition: AgentCliHandle,
  options: MastraControllerClientOptions = {},
): AgentCliClient {
  const host = options.host ?? createAgentControllerHost()
  let state: MastraControllerSessionState | undefined
  let unsubscribe: (() => void) | undefined
  let onActivity: (() => void) | undefined
  let current: { turnId: string; queue: TurnQueue } | undefined
  let mapperState = createMastraMapperState()
  /** Mode the host asked for, so its own `mode_changed` is not reported as a notice. */
  let hostSwitchTo: string | undefined
  const outOfTurnListeners = new Set<(event: StreamEvent) => void>()
  /** Surface requests as `agent-prompt` (true) or answer them in place (false). */
  let permissionHold = false
  let cwd = process.cwd()
  /** Open requests by the id carried on their `agent-prompt`. */
  const pending = new Map<string, PendingRequest>()
  let requestSeq = 0
  /** The running run raised a suspension, so its `suspended` end is not the turn's end. */
  let suspendedInRun = false
  /** The turn's run ended `suspended`: the turn stays open until an answer resumes it. */
  let parked = false
  /** Resolves once the suspended run has ended, so a resume never races it. */
  let runSettled: { promise: Promise<void>; resolve: () => void } = settledNow()

  const sessionIdOf = (s: Session): string =>
    `${s.identity.getResourceId()}:${s.thread.getId() ?? ""}`

  function emit(evt: StreamEvent): void {
    if (current && !current.queue.ended) current.queue.push(evt)
    else for (const listener of outOfTurnListeners) listener(evt)
  }

  function onControllerEvent(evt: ControllerEvent): void {
    if (!state) return
    onActivity?.()
    const sid = sessionIdOf(state.session)
    if (evt.type === "mode_changed") {
      const modeId = String(evt.modeId)
      state.modeId = modeId
      if (hostSwitchTo === modeId) {
        hostSwitchTo = undefined
        return
      }
      emit({
        kind: "thought",
        sessionId: sid,
        text: `[mastra-controller] mode switched by the controller: ${String(evt.previousModeId)} -> ${modeId}`,
      })
      return
    }
    if (!current || current.queue.ended) return
    switch (evt.type) {
      case "agent_start":
        parked = false
        suspendedInRun = false
        runSettled = deferred()
        return
      case "tool_approval_required":
        onRequest(
          sid,
          { kind: "tool-approval", toolCallId: String(evt.toolCallId), toolName: String(evt.toolName) },
          evt,
        )
        return
      case "tool_suspended":
        suspendedInRun = true
        onSuspended(sid, evt)
        return
      case "tool_suspension_cancelled":
        for (const [id, req] of pending) {
          if (req.toolCallId === evt.toolCallId) pending.delete(id)
        }
        return
      case "agent_end":
        runSettled.resolve()
        if (evt.reason === "suspended" && suspendedInRun) {
          // Not a turn end: the run waits on an answer (maybe already given)
          // that resumes it.
          parked = true
          return
        }
        break
    }
    // Each message carries its full text so far; restart the delta cursor per message.
    if (evt.type === "message_start") mapperState = createMastraMapperState()
    const mapped = mapMastraEvent(evt, sid, [], mapperState)
    if (!mapped) return
    if (mapped.kind === "turn-end") endTurn(mapped)
    else current.queue.push(mapped)
  }

  /** Push the turn's last event and drop whatever it left unanswered. */
  function endTurn(evt: StreamEvent): void {
    if (!current || current.queue.ended) return
    current.queue.push(evt)
    current.queue.end()
    pending.clear()
    parked = false
    suspendedInRun = false
    runSettled.resolve()
  }

  function onSuspended(sid: string, evt: ControllerEvent): void {
    const toolCallId = String(evt.toolCallId)
    const toolName = String(evt.toolName)
    if (toolName === "ask_user") {
      const payload = (evt.suspendPayload ?? evt.args ?? {}) as {
        options?: Array<{ label?: unknown }>
        selectionMode?: unknown
      }
      const choices = (payload.options ?? [])
        .map(o => o?.label)
        .filter((l): l is string => typeof l === "string")
      onRequest(
        sid,
        { kind: "question", toolCallId, choices, multi: payload.selectionMode === "multi_select" },
        evt,
      )
    } else if (toolName === "submit_plan") {
      onRequest(sid, { kind: "plan-approval", toolCallId }, evt)
    } else {
      onRequest(sid, { kind: "suspension", toolCallId }, evt)
    }
  }

  /** Surface `req` as an `agent-prompt` (permission hold) or answer it in place. */
  function onRequest(sid: string, req: PendingRequest, evt: ControllerEvent): void {
    const requestId = `${req.toolCallId}#${++requestSeq}`
    pending.set(requestId, req)
    if (!permissionHold) {
      const auto: PermissionResolution =
        req.kind === "question"
          ? { optionId: "answer", feedback: NO_USER_ANSWER }
          : req.kind === "plan-approval"
            ? { optionId: "reject", feedback: NO_APPROVER_FEEDBACK }
            : { optionId: "approve" }
      if (req.kind !== "tool-approval") {
        current?.queue.push({
          kind: "thought",
          sessionId: sid,
          text: `[mastra-controller] no permission hold: answered ${String(evt.toolName)} with ${auto.optionId}`,
        })
      }
      resolveRequest(requestId, auto)
      return
    }
    void buildPrompt(sid, requestId, req, evt).then(prompt => {
      // Still open: a cancel or a turn end in between drops the request.
      if (pending.get(requestId) === req) current?.queue.push(prompt)
    })
  }

  async function buildPrompt(
    sid: string,
    requestId: string,
    req: PendingRequest,
    evt: ControllerEvent,
  ): Promise<StreamEvent> {
    const toolName = String(evt.toolName)
    const base = {
      kind: "agent-prompt" as const,
      sessionId: sid,
      toolCallId: requestId,
      toolName,
      ...(evt.args !== undefined ? { rawInput: evt.args } : {}),
    }
    const payload = { [META_SUSPEND_PAYLOAD]: evt.suspendPayload }
    switch (req.kind) {
      case "tool-approval":
        return {
          ...base,
          text: `Allow "${toolName}"?`,
          options: [
            { optionId: "approve", name: "Allow", kind: "allow_once" },
            { optionId: "always_allow", name: "Always allow in this session", kind: "allow_always" },
            { optionId: "decline", name: "Deny", kind: "reject_once" },
          ],
          _meta: { [META_REQUEST]: "tool-approval" },
        }
      case "question": {
        const p = (evt.suspendPayload ?? {}) as { question?: unknown }
        return {
          ...base,
          text: typeof p.question === "string" ? p.question : "The agent asks a question.",
          options: [
            ...(req.choices.length
              ? req.choices.map((label, i) => ({ optionId: `answer:${i}`, name: label, kind: "allow_once" }))
              : [{ optionId: "answer", name: "Answer", kind: "allow_once" }]),
            { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
          ],
          _meta: { [META_REQUEST]: "question", ...payload },
        }
      }
      case "plan-approval": {
        const path = (evt.suspendPayload as { path?: unknown } | undefined)?.path
        const target = transitionTarget()
        const plan = typeof path === "string" ? await readPlan(path, cwd) : undefined
        const where = typeof path === "string" ? `the plan in ${path}` : "the plan"
        return {
          ...base,
          text: target
            ? `Approve ${where} and switch to mode '${target}'?`
            : `Approve ${where}?`,
          options: [
            { optionId: "approve", name: "Approve plan", kind: "allow_once" },
            { optionId: "reject", name: "Reject plan", kind: "reject_once" },
          ],
          _meta: {
            [META_REQUEST]: "plan-approval",
            ...payload,
            ...(target ? { [META_TRANSITIONS_TO]: target } : {}),
            ...(plan !== undefined ? { [META_PLAN]: plan } : {}),
          },
        }
      }
      case "suspension":
        return {
          ...base,
          text: `Continue "${toolName}"?`,
          options: [
            { optionId: "approve", name: "Continue", kind: "allow_once" },
            { optionId: "decline", name: "Cancel", kind: "reject_once" },
          ],
          _meta: { [META_REQUEST]: "suspension", ...payload },
        }
    }
  }

  /**
   * Mode an approved plan switches to, the way the controller resolves it:
   * the current mode's `transitionsTo`, else the default mode. Undefined
   * when that is the current mode (no switch).
   */
  function transitionTarget(): string | undefined {
    if (!state) return undefined
    const { manifest, modeId } = state
    const target =
      manifest.modes.find(m => m.id === modeId)?.transitionsTo ??
      (manifest.modes.find(m => m.default) ?? manifest.modes[0])?.id
    return target !== modeId ? target : undefined
  }

  /** Answer an open request. False when `requestId` names no open request. */
  function resolveRequest(requestId: string, resolution: PermissionResolution): boolean {
    const req = pending.get(requestId)
    if (!req || !state) return false
    pending.delete(requestId)
    const { session } = state
    const optionId = "optionId" in resolution ? resolution.optionId : undefined
    const feedback = "feedback" in resolution ? resolution.feedback : undefined

    if (req.kind === "tool-approval") {
      // "Always": a session grant for this tool. The controller's own
      // `always_allow_category` needs a toolCategoryResolver, which a
      // manifest cannot declare, and without one it only approves once.
      if (optionId === "always_allow") session.grantTool(req.toolName)
      session.respondToToolApproval({
        toolCallId: req.toolCallId,
        decision: optionId === "approve" || optionId === "always_allow" ? "approve" : "decline",
        ...(feedback ? { declineContext: { reason: feedback, message: feedback } } : {}),
      })
      return true
    }

    let resumeData: unknown
    if (req.kind === "question") {
      const i = optionId?.startsWith("answer:") ? Number(optionId.slice("answer:".length)) : NaN
      const answer =
        req.choices[i] ??
        (optionId === "answer" ? (feedback ?? "") : "The user declined to answer.")
      resumeData = req.multi && req.choices[i] !== undefined ? [answer] : answer
    } else if (req.kind === "plan-approval") {
      resumeData =
        optionId === "approve"
          ? { action: "approved" }
          : { action: "rejected", ...(feedback ? { feedback } : {}) }
    } else {
      resumeData = { approved: optionId === "approve", ...(feedback ? { feedback } : {}) }
    }
    const turn = current
    const sid = sessionIdOf(session)
    void runSettled.promise
      .then(() => session.respondToToolSuspension({ toolCallId: req.toolCallId, resumeData }))
      .catch((err: unknown) => {
        if (current !== turn) return
        current?.queue.push({
          kind: "error",
          sessionId: sid,
          error: { message: err instanceof Error ? err.message : String(err) },
        })
        endTurn({ kind: "turn-end", sessionId: sid, reason: "error" })
      })
    return true
  }

  async function loadManifest(opts: AgentCliConnectOptions): Promise<ControllerManifest> {
    if (options.manifest !== undefined) {
      return typeof options.manifest === "string"
        ? parseControllerManifest(options.manifest)
        : options.manifest
    }
    const path = opts.env[MANIFEST_ENV_KEY] ?? process.env[MANIFEST_ENV_KEY]
    if (!path) {
      throw new Error(
        "mastra-controller: no manifest. Set the `manifest` option (env " +
          `${MANIFEST_ENV_KEY}) to a mastra.agent-controller/v1 file.`,
      )
    }
    const abs = isAbsolute(path) ? path : resolvePath(opts.cwd, path)
    return parseControllerManifest(await readFile(abs, "utf8"))
  }

  function requireState(op: string): MastraControllerSessionState {
    if (!state) throw new Error(`mastra-controller: ${op}() called before connect()`)
    return state
  }

  return {
    get sessionId(): string | undefined {
      return state ? sessionIdOf(state.session) : undefined
    },

    get availableModes(): SessionMode[] | undefined {
      return state?.manifest.modes.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.description !== undefined ? { description: m.description } : {}),
      }))
    },

    get currentModeId(): string | undefined {
      return state?.modeId
    },

    async connect(opts: AgentCliConnectOptions): Promise<void> {
      const manifest = await loadManifest(opts)
      const requestedMode = opts.mode ?? opts.env[MODE_ENV_KEY]
      if (requestedMode !== undefined && !manifest.modes.some(m => m.id === requestedMode)) {
        throw new Error(
          `mastra-controller: mode '${requestedMode}' is not declared by manifest ` +
            `'${manifest.id}'. Known modes: ${manifest.modes.map(m => m.id).join(", ")}`,
        )
      }

      const controller = await host.createController(manifest, { cwd: opts.cwd, env: opts.env })
      let session: Session
      try {
        let resume: { resourceId: string; threadId: string } | undefined
        if (opts.resumeSessionId) {
          const idx = opts.resumeSessionId.lastIndexOf(":")
          if (idx <= 0 || idx === opts.resumeSessionId.length - 1) {
            throw new Error(
              `mastra-controller: malformed resumeSessionId '${opts.resumeSessionId}', ` +
                'expected "<resourceId>:<threadId>"',
            )
          }
          resume = {
            resourceId: opts.resumeSessionId.slice(0, idx),
            threadId: opts.resumeSessionId.slice(idx + 1),
          }
        }
        session = await controller.createSession({
          resourceId: resume?.resourceId ?? `agentproto-mastra-controller-${randomUUID()}`,
          ...(resume ? { threadId: resume.threadId } : {}),
        })
        // `ask_user` and `submit_plan` suspend for their own answer: a generic
        // "run this tool?" approval in front of it would ask twice. The
        // manifest's own rules, set below, still win.
        for (const toolName of SELF_GATED_TOOLS) {
          await session.permissions.setForTool({ toolName, policy: "allow" })
        }
        for (const [category, policy] of Object.entries(manifest.permissions?.categories ?? {})) {
          await session.permissions.setForCategory({ category: category as never, policy })
        }
        for (const [toolName, policy] of Object.entries(manifest.permissions?.tools ?? {})) {
          await session.permissions.setForTool({ toolName, policy })
        }
        if (requestedMode !== undefined && session.mode.get() !== requestedMode) {
          await session.mode.switch({ modeId: requestedMode })
        }
      } catch (err) {
        await controller.destroy()
        throw err
      }

      state = { controller, session, manifest, modeId: session.mode.get() }
      onActivity = opts.onActivity
      permissionHold = opts.permissionHold === true
      cwd = opts.cwd
      unsubscribe = session.subscribe(evt => onControllerEvent(evt as ControllerEvent))
    },

    async send(turnId: string, message: unknown): Promise<void> {
      const { session } = requireState("send")
      if (current && !current.queue.ended) {
        throw new Error(
          `mastra-controller: turn '${current.turnId}' is still running; cancel it or wait for its turn-end`,
        )
      }
      const queue = new TurnQueue()
      const turn = { turnId, queue }
      current = turn
      mapperState = createMastraMapperState()
      pending.clear()
      parked = false
      suspendedInRun = false
      const sid = sessionIdOf(session)
      session.sendMessage({ content: extractPromptText(message) }).then(
        () => {
          // `agent_end` normally closed the turn already; this covers a run
          // that settled without one. A run parked on a suspension settles
          // here too, but its turn waits for the answer.
          if (current === turn && !parked) {
            endTurn({ kind: "turn-end", sessionId: sid, reason: "completed" })
          }
        },
        (err: unknown) => {
          if (current !== turn) return
          queue.push({
            kind: "error",
            sessionId: sid,
            error: { message: err instanceof Error ? err.message : String(err) },
          })
          endTurn({ kind: "turn-end", sessionId: sid, reason: "error" })
        },
      )
    },

    async *events(): AsyncIterable<StreamEvent> {
      if (!current) return
      yield* current.queue.drain()
    },

    async cancel(turnId: string): Promise<void> {
      if (!state || current?.turnId !== turnId || current.queue.ended) return
      const wasParked = parked
      state.session.abort()
      // A parked run already ended, so the abort brings no `agent_end`:
      // close the turn here.
      if (wasParked) {
        endTurn({ kind: "turn-end", sessionId: sessionIdOf(state.session), reason: "cancelled" })
      }
    },

    respondPermission(requestId: string, resolution: PermissionResolution): boolean {
      return resolveRequest(requestId, resolution)
    },

    async setSessionMode(modeId: string): Promise<{ applied: boolean; reason?: string }> {
      if (!state) return { applied: false, reason: "not-connected" }
      if (!state.manifest.modes.some(m => m.id === modeId)) {
        return {
          applied: false,
          reason: `unknown mode '${modeId}' (known: ${state.manifest.modes.map(m => m.id).join(", ")})`,
        }
      }
      if (state.session.mode.get() === modeId) return { applied: true }
      hostSwitchTo = modeId
      try {
        await state.session.mode.switch({ modeId })
      } catch (err) {
        hostSwitchTo = undefined
        return { applied: false, reason: err instanceof Error ? err.message : String(err) }
      }
      state.modeId = state.session.mode.get()
      return { applied: true }
    },

    onOutOfTurnEvent(listener: (event: StreamEvent) => void): () => void {
      outOfTurnListeners.add(listener)
      return () => outOfTurnListeners.delete(listener)
    },

    async close(): Promise<void> {
      const s = state
      state = undefined
      unsubscribe?.()
      unsubscribe = undefined
      current?.queue.end()
      pending.clear()
      if (s) await s.controller.destroy()
    },
  }
}

/**
 * Text of the plan file at `path`, a model-supplied path: it must name a
 * regular file under `cwd`, both sides compared after symlink resolution,
 * and at most `MAX_PLAN_BYTES` of it are read. Anything else yields
 * "plan not readable: <reason>" so the approval prompt is still raised.
 */
async function readPlan(path: string, cwd: string): Promise<string> {
  const notReadable = (reason: string) => `plan not readable: ${reason}`
  const outside = notReadable("outside the session cwd")
  try {
    const target = resolvePath(cwd, path)
    if (!isWithin(resolvePath(cwd), target)) return outside
    const [realCwd, realTarget] = await Promise.all([realpath(cwd), realpath(target)])
    if (!isWithin(realCwd, realTarget)) return outside
    if (!(await stat(realTarget)).isFile()) return notReadable("not a regular file")
    // Non-blocking, so a file swapped for a fifo after the stat cannot hang the open.
    const handle = await open(
      realTarget,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    )
    try {
      const info = await handle.stat()
      if (!info.isFile()) return notReadable("not a regular file")
      const buf = Buffer.alloc(Math.min(info.size, MAX_PLAN_BYTES))
      let filled = 0
      while (filled < buf.length) {
        const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      // `stream: true` holds back a character cut at the byte cap.
      const text = new TextDecoder().decode(buf.subarray(0, filled), { stream: true })
      return info.size > MAX_PLAN_BYTES
        ? `${text}\n[plan truncated at ${MAX_PLAN_BYTES} bytes]`
        : text
    } finally {
      await handle.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    return notReadable(code ?? (err instanceof Error ? err.message : String(err)))
  }
}

/** Whether absolute `child` is `parent` or lies under it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}

function settledNow(): { promise: Promise<void>; resolve: () => void } {
  return { promise: Promise.resolve(), resolve: () => {} }
}

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    return (message as Array<Record<string, unknown>>)
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text as string)
      .join("\n")
  }
  if (message !== null && typeof message === "object") {
    const m = message as Record<string, unknown>
    if (typeof m.text === "string") return m.text
  }
  return JSON.stringify(message)
}
