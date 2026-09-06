/**
 * `AgentCliClient` for pi (`@earendil-works/pi-coding-agent`), driven over
 * its persistent JSON-over-stdio RPC mode.
 *
 * Unlike `@agentproto/adapter-mastracode-inprocess` (the other
 * `protocol: "proprietary"` arm, which runs in-process), this arm spawns a
 * real child: `pi --mode rpc`. It writes RPC commands (LF-delimited JSON) to
 * the child's stdin and reads pi's response + `AgentSessionEvent` stream from
 * stdout, translating the events into agentproto `StreamEvent`s.
 *
 * ## MCP support — bridged via a generated pi extension
 *
 * Pi ships neither ACP nor MCP. The proprietary arm's `connect()` receives
 * `mcpServers` (the host may inject the daemon's own orchestration gateway or
 * any scoped toolset). Pi cannot mount MCP natively, so this arm bridges them:
 * it enumerates each server's tools up-front, writes a per-session config JSON,
 * and spawns pi with `-e <mcp-bridge-extension.mjs>` + `PI_MCP_BRIDGE_CONFIG`.
 * The extension registers one pi tool per MCP tool and proxies calls over
 * `@modelcontextprotocol/sdk`. See ../MCP-BRIDGE.md. When no MCP servers are
 * injected, behavior is unchanged (pi runs only its own file/shell tools).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import type {
  AgentCliClient,
  AgentCliConnectOptions,
  AgentCliHandle,
  StreamEvent,
} from "@agentproto/driver-agent-cli"
import { resolveContextWindow } from "@agentproto/model-catalog/llm"
import { enumerateMcpTools } from "./mcp-bridge/enumerate.js"
import {
  classifyPiLine,
  createPiMapperState,
  mapPiEvent,
  resetPiMapperState,
  type PiMapperState,
  type PiResponse,
  type PiSessionEvent,
} from "./pi-events.js"

/** Env var the bridge extension reads to find its per-session config JSON. */
const BRIDGE_CONFIG_ENV = "PI_MCP_BRIDGE_CONFIG"

/** Resolve the built bridge extension next to this module (dist/…). */
function bridgeExtensionPath(): string {
  return fileURLToPath(new URL("./mcp-bridge-extension.mjs", import.meta.url))
}

/** Env override for the pi binary path — lets a smoke test point at an
 *  `npx`/local install without a global `pi` on PATH. Falls back to the
 *  manifest `bin` (`pi`). */
const PI_BIN_ENV = "AGENTPROTO_PI_BIN"

/** Pi thinking levels (packages/coding-agent/src/cli/args.ts). Mirrors the
 *  `effort` option enum; anything else is ignored rather than passed on. */
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

/** How long `connect()` waits for pi's first `get_state` response before
 *  treating the child as unhealthy. */
const CONNECT_TIMEOUT_MS = 30_000

const STDERR_TAIL_LINES = 40

/**
 * Minimal async queue backing one turn's `events()` stream. `push` buffers
 * (or hands off to a waiting consumer); `end` closes the stream. Iterating a
 * closed-and-drained queue completes.
 */
class TurnChannel {
  private readonly items: StreamEvent[] = []
  private readonly waiters: Array<(r: IteratorResult<StreamEvent, undefined>) => void> = []
  private closed = false

  push(event: StreamEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: event, done: false })
    } else {
      this.items.push(event)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  async *iterate(): AsyncIterable<StreamEvent> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<StreamEvent, undefined>>(resolve => {
        this.waiters.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}

interface PendingCommand {
  resolve: (response: PiResponse) => void
  reject: (error: Error) => void
}

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    return message
      .map(block => {
        if (typeof block === "string") return block
        if (block !== null && typeof block === "object" && "text" in block) {
          const text = block.text
          return typeof text === "string" ? text : ""
        }
        return ""
      })
      .filter(text => text.length > 0)
      .join("\n")
  }
  if (message !== null && typeof message === "object" && "content" in message) {
    const content = message.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) return extractPromptText(content)
  }
  if (message !== null && typeof message === "object" && "text" in message) {
    const text = message.text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

/** Resolve a model id to its real context-window size via
 *  `@agentproto/model-catalog`. `undefined` for an absent/uncataloged model
 *  id — never a fabricated number (see `usageUpdate` in pi-events.ts, which
 *  treats `undefined` as "unknown window", not "zero tokens"). */
export function resolvePiContextWindow(modelId: string | undefined): number | undefined {
  return modelId ? resolveContextWindow(modelId)?.contextWindow : undefined
}

export function createAgentCliClient(definition: AgentCliHandle): AgentCliClient {
  let child: ChildProcessWithoutNullStreams | undefined
  let piSessionId: string | undefined
  let connectEffort: string | undefined
  /** Model's real context-window size, resolved once at `connect()` time from
   *  `@agentproto/model-catalog` by model id. `undefined` when the model
   *  isn't in the catalog — pi's own usage payload carries no window figure
   *  (see pi-events.ts `usageUpdate`), so an unresolved model means an
   *  unknown window, not a fabricated one. */
  let contextWindow: number | undefined
  let onActivity: (() => void) | undefined
  /** Session temp dir holding the bridge config JSON; removed on close(). */
  let bridgeTempDir: string | undefined

  const pending = new Map<string, PendingCommand>()
  const stderrLines: string[] = []
  const mapperState: PiMapperState = createPiMapperState()
  let currentTurn: TurnChannel | undefined

  /** Resolve the pi binary: an `AGENTPROTO_PI_BIN` override (from the composed
   *  spawn env, or the ambient process env) beats the manifest `bin`. Lets a
   *  smoke test point at a local install without a global `pi` on PATH. */
  function resolveBin(env: Record<string, string>): string {
    return env[PI_BIN_ENV] ?? process.env[PI_BIN_ENV] ?? definition.bin ?? "pi"
  }

  function write(command: Record<string, unknown>): void {
    const proc = child
    if (!proc) throw new Error("pi: process not started")
    proc.stdin.write(`${JSON.stringify(command)}\n`)
    onActivity?.()
  }

  function request(type: string, extra: Record<string, unknown> = {}): Promise<PiResponse> {
    const id = randomUUID()
    return new Promise<PiResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        write({ id, type, ...extra })
      } catch (err) {
        pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  function failCurrentTurn(message: string): void {
    const turn = currentTurn
    if (!turn) return
    turn.push({ kind: "error", sessionId: piSessionId ?? "", error: { message } })
    turn.push({
      kind: "turn-end",
      sessionId: piSessionId ?? "",
      reason: "error",
    })
    turn.close()
  }

  function handleResponse(response: PiResponse): void {
    onActivity?.()
    // `prompt` is fire-and-forget: its success ack only confirms preflight and
    // the real work streams as events. A failure ack, though, means no events
    // will follow — surface it on the active turn so `events()` terminates.
    if (response.command === "prompt") {
      if (!response.success) {
        failCurrentTurn(response.error ?? "pi rejected the prompt")
      }
      return
    }
    if (response.id !== undefined) {
      const waiter = pending.get(response.id)
      if (waiter) {
        pending.delete(response.id)
        if (response.success) waiter.resolve(response)
        else waiter.reject(new Error(response.error ?? `pi command '${response.command}' failed`))
      }
    }
  }

  function handleEvent(event: PiSessionEvent): void {
    onActivity?.()
    const turn = currentTurn
    if (!turn) return
    for (const mapped of mapPiEvent(event, piSessionId ?? "", mapperState, contextWindow)) {
      turn.push(mapped)
      if (mapped.kind === "turn-end") turn.close()
    }
  }

  function attachReaders(proc: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    proc.stdout.on("data", chunk => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) break
        const rawLine = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
        if (line.length === 0) continue
        const classified = classifyPiLine(line)
        if (classified.kind === "response") handleResponse(classified.response)
        else if (classified.kind === "event") handleEvent(classified.event)
      }
    })

    const stderrDecoder = new StringDecoder("utf8")
    proc.stderr.on("data", chunk => {
      const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk)
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue
        stderrLines.push(line)
        if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift()
      }
    })

    proc.on("exit", code => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`pi exited (code ${code ?? "null"})`))
      }
      pending.clear()
      if (currentTurn) failCurrentTurn(`pi exited before turn completed (code ${code ?? "null"})`)
    })
  }

  const client: AgentCliClient = {
    get sessionId(): string | undefined {
      return piSessionId
    },

    _stderrTail(): string {
      return stderrLines.join("\n")
    },

    async connect(opts: AgentCliConnectOptions): Promise<void> {
      onActivity = opts.onActivity
      connectEffort = opts.effort
      contextWindow = resolvePiContextWindow(opts.model)

      const args = ["--mode", "rpc"]
      if (opts.model) args.push("--model", opts.model)
      if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId)

      // Bridge any injected MCP servers into pi via a generated extension:
      // enumerate their tools now, write a per-session config, and spawn pi with
      // `-e <extension>` + PI_MCP_BRIDGE_CONFIG so the extension registers one
      // pi tool per MCP tool. See ./mcp-bridge/ and ../MCP-BRIDGE.md.
      const childEnv: Record<string, string> = { ...opts.env }
      if (opts.mcpServers?.length) {
        const { config, errors } = await enumerateMcpTools(opts.mcpServers)
        for (const e of errors) {
          console.warn(`[adapter-pi] mcp-bridge: server "${e.server}" unavailable — ${e.message}`)
        }
        if (config.tools.length > 0) {
          const dir = mkdtempSync(join(tmpdir(), "pi-mcp-bridge-"))
          const configPath = join(dir, "config.json")
          writeFileSync(configPath, JSON.stringify(config), "utf8")
          bridgeTempDir = dir
          childEnv[BRIDGE_CONFIG_ENV] = configPath
          args.push("-e", bridgeExtensionPath())
          console.info(
            `[adapter-pi] mcp-bridge: bridged ${config.tools.length} tool(s) across ` +
              `${config.servers.length} MCP server(s) into pi.`,
          )
        } else {
          console.warn(
            `[adapter-pi] mcp-bridge: ${opts.mcpServers.length} MCP server(s) injected but no ` +
              `tools enumerated — pi runs only its own built-in tools.`,
          )
        }
      }

      const proc = spawn(resolveBin(opts.env), args, {
        cwd: opts.cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      })
      child = proc
      attachReaders(proc)

      proc.on("error", err => {
        for (const waiter of pending.values()) waiter.reject(err)
        pending.clear()
      })

      // Probe readiness and capture pi's session id in one round-trip.
      const state = await Promise.race([
        request("get_state"),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `pi did not respond to get_state within ${CONNECT_TIMEOUT_MS}ms. ` +
                  `stderr tail:\n${client._stderrTail?.() ?? ""}`,
              ),
            )
          }, CONNECT_TIMEOUT_MS)
          if (typeof timer.unref === "function") timer.unref()
        }),
      ])

      const data = state.data
      if (data !== null && typeof data === "object" && "sessionId" in data) {
        const sid = data.sessionId
        if (typeof sid === "string") piSessionId = sid
      }

      if (connectEffort && VALID_THINKING_LEVELS.has(connectEffort)) {
        await request("set_thinking_level", { level: connectEffort })
      }

      opts.abortSignal.addEventListener(
        "abort",
        () => {
          void this.close()
        },
        { once: true },
      )
    },

    async send(_turnId: string, message: unknown): Promise<void> {
      if (!child) throw new Error("pi: send() called before connect()")
      resetPiMapperState(mapperState)
      currentTurn = new TurnChannel()
      write({ id: randomUUID(), type: "prompt", message: extractPromptText(message) })
    },

    async *events(): AsyncIterable<StreamEvent> {
      const turn = currentTurn
      if (!turn) return
      const stderrTail = client._stderrTail
      for await (const event of turn.iterate()) {
        if (event.kind === "error" && typeof stderrTail === "function") {
          const tail = stderrTail()
          if (tail) {
            const existing =
              event.error.data !== null &&
              typeof event.error.data === "object" &&
              !Array.isArray(event.error.data)
                ? event.error.data
                : {}
            event.error.data = { ...existing, stderr: tail }
          }
        }
        yield event
      }
    },

    async cancel(_turnId: string): Promise<void> {
      if (!child) return
      try {
        await request("abort")
      } catch {
        // A missing abort ack shouldn't throw out of cancel — the turn still
        // settles (or the process has already gone), which closes the stream.
      }
    },

    async close(): Promise<void> {
      const dir = bridgeTempDir
      if (dir) {
        bridgeTempDir = undefined
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Best effort — the OS reaps the temp dir eventually. The MCP clients
          // live inside pi and die with the child.
        }
      }
      const proc = child
      if (!proc) return
      child = undefined
      try {
        proc.stdin.end()
      } catch {
        // Best effort — the pipe may already be gone.
      }
      if (!proc.killed) proc.kill("SIGTERM")
    },
  }

  return client
}
