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
 * Out of scope here (E48 PR 3): `ask_user`, tool approvals and
 * `submit_plan` suspensions. A turn that suspends on one ends with
 * `turn-end` reason `cancelled`, the same mapping `mapMastraEvent` gives
 * every Mastra arm.
 */

import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve as resolvePath } from "node:path"
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
    // Each message carries its full text so far; restart the delta cursor per message.
    if (evt.type === "message_start") mapperState = createMastraMapperState()
    const mapped = mapMastraEvent(evt, sid, [], mapperState)
    if (!mapped) return
    current.queue.push(mapped)
    if (mapped.kind === "turn-end") current.queue.end()
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
      current = { turnId, queue }
      mapperState = createMastraMapperState()
      const sid = sessionIdOf(session)
      session.sendMessage({ content: extractPromptText(message) }).then(
        () => {
          // `agent_end` normally closed the turn already; this covers a run
          // that settled without one.
          if (!queue.ended) {
            queue.push({ kind: "turn-end", sessionId: sid, reason: "completed" })
            queue.end()
          }
        },
        (err: unknown) => {
          queue.push({
            kind: "error",
            sessionId: sid,
            error: { message: err instanceof Error ? err.message : String(err) },
          })
          queue.push({ kind: "turn-end", sessionId: sid, reason: "error" })
          queue.end()
        },
      )
    },

    async *events(): AsyncIterable<StreamEvent> {
      if (!current) return
      yield* current.queue.drain()
    },

    async cancel(turnId: string): Promise<void> {
      if (!state || current?.turnId !== turnId || current.queue.ended) return
      state.session.abort()
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
      if (s) await s.controller.destroy()
    },
  }
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
