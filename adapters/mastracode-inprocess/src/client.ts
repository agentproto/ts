/**
 * `AgentCliClient` implementation wrapping Mastra Code's in-process SDK
 * (`mastracode` / `mastracode/headless`) instead of spawning a subprocess.
 *
 * ## Why a composite sessionId
 *
 * A single Mastra Code `AgentController` instance auto-binds a *fresh*
 * session to whatever thread `session.thread` currently points at, and
 * (empirically verified against mastracode 0.27.0 / @mastra/core 1.48.0)
 * `runMC()` only rebinds that pointer when `thread.id` / `thread.continueLatest`
 * is explicitly passed. Two unrelated conversations that share both a
 * `cwd` and this arm's dedicated storage file would otherwise silently
 * land on the SAME thread — Mastra Code resolves the initial thread by
 * `resourceId`, and every conversation was defaulting to the same one.
 *
 * The fix (also verified live): pass a distinct `resourceId` to `runMC()`
 * per *conversation*, not per process and not globally via
 * `MASTRA_RESOURCE_ID` (a global env var would race across concurrent
 * in-process conversations in the same daemon). A fresh conversation
 * mints a random resourceId; a resumed one must reuse the EXACT
 * resourceId the thread was created under, because `session.thread.list()`
 * — which `runMC`'s thread-by-id resolution calls internally — is scoped
 * to the session's current resourceId by default. So this arm's public
 * `sessionId` is `"<resourceId>:<threadId>"`, and resume splits it back
 * apart. This composite format is this arm's own implementation detail;
 * hosts only ever need to persist and echo back whatever string
 * `sessionId` returns, per the generic AgentCliClient contract.
 *
 * Cross-process resume (kill the process, start a new one, reattach via
 * the same composite sessionId against the same dedicated storage file)
 * has been verified to preserve conversation memory end-to-end.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync } from "node:fs"
import { createMastraCode } from "mastracode"
import { runMC, type MCRun } from "mastracode/headless"
import {
  mapMastraEvent,
  createMastraMapperState,
  toFileBasedMcpServers,
  type AgentCliClient,
  type AgentCliConnectOptions,
  type AgentCliHandle,
  type StreamEvent,
} from "@agentproto/driver-agent-cli"

/** Env var carrying a manifest `modes[].env` patch through to `send()` —
 *  there's no argv for a `proprietary` arm to append `bin_args_append`
 *  to, so mode selection travels the one channel `composeSpawn` already
 *  threads through for every protocol: env. See `../MASTRACODE-INPROCESS.md`. */
const MODE_ENV_KEY = "AGENTPROTO_MASTRACODE_MODE"

const VALID_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh"])
const VALID_RUN_MODES = new Set(["build", "plan", "fast"])

function resolveAgentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

/** Dedicated per-machine storage — NOT the ambient global mastracode
 *  default (which is shared across every mastracode invocation on the
 *  host, subprocess or not). Isolating it here means this arm's threads
 *  never collide with a developer's own interactive `mastracode` usage. */
function resolveStoragePath(): string {
  return join(resolveAgentprotoHome(), "mastracode-inprocess", "storage.db")
}

/** Dedicated, empty home directory so Mastra Code's global config
 *  discovery (`~/.claude/skills`, `~/.mastracode/{hooks,commands,skills}`,
 *  `~/.agents/skills`) does not implicitly inherit the operator's own
 *  personal Claude Code / Mastra Code setup.
 *
 *  KNOWN LIMITATION (verified against 0.27.0, not assumed): passing
 *  `homeDir` at the top level of `MastraCodeConfig` is NOT sufficient —
 *  `createMastraCodeAgentController` resolves `homeDir` for hooks/plugin
 *  wiring but does not copy it into `initialState`, and the workspace's
 *  skill-path builder reads `state.homeDir`, falling back to the real
 *  `os.homedir()` when that's unset. Both `homeDir` AND
 *  `initialState: { homeDir }` must be passed for the override to
 *  actually reach skill discovery. This does not affect a target repo's
 *  own PROJECT-LOCAL `.claude/skills` (relative to `cwd`) — that's the
 *  repo's own content, not the operator's personal config, and is
 *  intentionally left reachable (mirrors the ACP arm reading a target
 *  repo's own `.claude/settings.json`). */
function resolveIsolatedHomeDir(): string {
  return join(resolveAgentprotoHome(), "mastracode-inprocess", "home")
}

function parseSessionId(sessionId: string): { resourceId: string; threadId: string } {
  const idx = sessionId.indexOf(":")
  if (idx <= 0 || idx === sessionId.length - 1) {
    throw new Error(
      `mastracode-inprocess: malformed resumeSessionId '${sessionId}' — expected ` +
        `"<resourceId>:<threadId>", the format this arm's own sessionId getter produces.`,
    )
  }
  return { resourceId: sessionId.slice(0, idx), threadId: sessionId.slice(idx + 1) }
}

/** Narrow shape of `createMastraCode`'s resolved return value this arm
 *  actually uses — kept local (not re-exported from `mastracode`) so this
 *  file only depends on what it reads. */
interface MastraCodeHandle {
  controller: { destroy(): Promise<void> }
  session: {
    thread: { getId(): string | null }
    mode: { get(): string; switch(args: { modeId: string }): Promise<void> }
  }
  /** Present when `bootLocalAgentController` builds an MCP manager (i.e.
   *  MCP servers were configured). `createMastraCode` does NOT initialize
   *  it automatically — verified against mastracode's own headless CLI
   *  entrypoint (`runMCCli` in `dist/chunk-HADE25EX.cjs`), which explicitly
   *  calls `mcpManager.initInBackground()` itself right after boot, before
   *  running any prompt. Skipping this step (as an earlier version of this
   *  arm did) leaves `mcpServers` connected-but-never-initialized: the
   *  config is accepted, but no MCP tools ever reach the agent's toolset. */
  mcpManager?: {
    hasServers(): boolean
    initInBackground(): Promise<unknown>
  }
}

export function createAgentCliClient(definition: AgentCliHandle): AgentCliClient {
  let handle: MastraCodeHandle | undefined
  let resourceId: string | undefined
  let threadId: string | undefined
  let connectEnv: Record<string, string> = {}
  let connectModel: string | undefined
  let connectEffort: string | undefined
  const pendingByTurn = new Map<string, MCRun>()

  return {
    get sessionId(): string | undefined {
      return resourceId && threadId ? `${resourceId}:${threadId}` : undefined
    },

    async connect(opts: AgentCliConnectOptions): Promise<void> {
      const isolatedHome = resolveIsolatedHomeDir()
      const storagePath = resolveStoragePath()
      mkdirSync(isolatedHome, { recursive: true })
      mkdirSync(dirname(storagePath), { recursive: true })

      handle = (await createMastraCode({
        cwd: opts.cwd,
        homeDir: isolatedHome,
        initialState: { homeDir: isolatedHome },
        disablePlugins: true,
        storage: { backend: "libsql", url: `file:${storagePath}`, isRemote: false },
        ...(opts.mcpServers?.length
          ? { mcpServers: toFileBasedMcpServers(opts.mcpServers) }
          : {}),
      })) as unknown as MastraCodeHandle

      // `createMastraCode` builds the MCP manager but does not initialize
      // it — mirror mastracode's own headless CLI (`runMCCli`), which
      // explicitly awaits this before running any prompt. Without it, MCP
      // servers are configured but never connected, so their tools never
      // reach the agent. Best-effort: a failed MCP connection shouldn't
      // fail the whole session (matches the CLI's own warn-and-continue).
      if (handle.mcpManager?.hasServers()) {
        try {
          await handle.mcpManager.initInBackground()
        } catch {
          // Best-effort — the session still starts on its non-MCP tools.
        }
      }

      connectEnv = opts.env
      connectModel = opts.model
      connectEffort = opts.effort

      if (opts.resumeSessionId) {
        ;({ resourceId, threadId } = parseSessionId(opts.resumeSessionId))
      } else {
        resourceId = `agentproto-mastracode-inprocess-${randomUUID()}`
        threadId = undefined
      }
    },

    async send(turnId: string, message: unknown): Promise<void> {
      if (!handle || !resourceId) {
        throw new Error("mastracode-inprocess: send() called before connect()")
      }
      const prompt = extractPromptText(message)

      const requestedMode = connectEnv[MODE_ENV_KEY]
      if (requestedMode && VALID_RUN_MODES.has(requestedMode)) {
        if (handle.session.mode.get() !== requestedMode) {
          await handle.session.mode.switch({ modeId: requestedMode })
        }
      }

      const thinkingLevel =
        connectEffort && VALID_THINKING_LEVELS.has(connectEffort)
          ? (connectEffort as "off" | "low" | "medium" | "high" | "xhigh")
          : undefined

      const run = runMC({
        controller: handle.controller as never,
        session: handle.session as never,
        prompt,
        resourceId,
        thread: threadId ? { id: threadId } : undefined,
        ...(connectModel ? { model: connectModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(definition.session?.max_turns
          ? { maxTurns: definition.session.max_turns }
          : {}),
      })
      pendingByTurn.set(turnId, run)
    },

    async *events(): AsyncIterable<StreamEvent> {
      const run = Array.from(pendingByTurn.values()).at(-1)
      if (!run) return
      const state = createMastraMapperState()
      for await (const evt of run) {
        // Track the thread id live from in-band events, synchronously
        // with the loop that's about to map+yield them — no race against
        // `run.result` resolving on a separate microtask.
        if (evt.type === "thread_created") threadId = evt.thread.id
        else if (evt.type === "thread_changed") threadId = evt.threadId
        const sid = resourceId && threadId ? `${resourceId}:${threadId}` : ""
        const mapped = mapMastraEvent(
          evt as unknown as Record<string, unknown>,
          sid,
          [],
          state,
        )
        if (mapped) yield mapped
      }
      // Fallback for the (unverified) case where a fresh thread's first
      // binding happens inside `sendMessage()` without an in-band
      // `thread_created`/`thread_changed` event — `result.threadId` is
      // always populated once the run settles, so this is authoritative
      // even if the loop above never fired.
      const result = await run.result
      if (result.threadId) threadId = result.threadId
    },

    async cancel(turnId: string): Promise<void> {
      pendingByTurn.get(turnId)?.abort()
    },

    async close(): Promise<void> {
      await handle?.controller.destroy()
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
