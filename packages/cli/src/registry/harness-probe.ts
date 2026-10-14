/**
 * ACP smoke probe — "does this harness still speak ACP with agentproto?"
 *
 * Spawns the harness the way the driver does (`bin` + `bin_args`, the
 * manifest's static env, a fresh temp cwd), runs the two-call handshake over
 * stdio newline-delimited JSON-RPC (the ACP wire — the same framing
 * `@agentclientprotocol/sdk`'s `ndJsonStream` speaks), then tears the whole
 * process tree down:
 *
 *   initialize  → protocolVersion agentproto accepts + agentCapabilities
 *   session/new → a real sessionId for that cwd, with NO MCP servers
 *
 * Deliberately NO `session/prompt`: `session/new` proves the protocol and a
 * usable session without spending a single token, which is what makes this
 * safe to run after every upgrade (and cheap enough to run by hand).
 *
 * Non-ACP adapters (`protocol: "proprietary"` / `"print"`) never get here —
 * the caller skips them with "not ACP" rather than pretending a proprietary
 * one-shot can answer an ACP handshake.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { terminateChildTree } from "@agentproto/driver-agent-cli"

/** Protocol version the probe requests — the same one `@agentproto/acp`'s
 *  client sends (`PROTOCOL_VERSION_DEFAULT`). An agent answering anything
 *  outside `1..this` is speaking a protocol agentproto can't drive. */
export const ACP_SMOKE_PROTOCOL_VERSION = 1

/** Whole-probe deadline. A harness that never answers must not hang the
 *  verb — `harness check` and the post-upgrade gate both bound on this. */
export const SMOKE_PROBE_TIMEOUT_MS = 30_000

/** What the probe spawns — the manifest's spawn fields, nothing else. */
export interface SmokeProbeTarget {
  bin: string
  bin_args?: readonly string[]
  env?: Record<string, string>
}

export interface SmokeProbeResult {
  /** True only when initialize negotiated a protocolVersion agentproto
   *  accepts AND session/new returned a sessionId. */
  ok: boolean
  protocolVersion?: number
  /** Whether the agent advertised `loadSession` at initialize — surfaced so
   *  `harness check` can note resume support; never part of the verdict. */
  loadSession?: boolean
  error?: string
}

export interface SmokeProbeOptions {
  /** Working directory handed to session/new. A fresh temp dir is created
   *  (and removed) when omitted. */
  cwd?: string
  /** Whole-probe timeout. Default {@link SMOKE_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number
}

interface RpcResponse {
  id?: unknown
  result?: Record<string, unknown>
  error?: { code?: unknown; message?: unknown }
}

/**
 * Run the smoke probe against one harness. Never throws: a spawn failure, a
 * hostile/absent answer, and a timeout all resolve to `{ ok: false, error }`.
 */
export async function acpSmokeProbe(
  target: SmokeProbeTarget,
  opts: SmokeProbeOptions = {},
): Promise<SmokeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? SMOKE_PROBE_TIMEOUT_MS
  const ownsCwd = opts.cwd === undefined
  let cwd = opts.cwd
  if (!cwd) {
    try {
      cwd = await mkdtemp(join(tmpdir(), "agentproto-harness-probe-"))
    } catch (err) {
      return { ok: false, error: `could not create temp cwd: ${message(err)}` }
    }
  }

  let child: ChildProcess
  try {
    child = spawn(target.bin, [...(target.bin_args ?? [])], {
      cwd,
      env: { ...process.env, ...(target.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err) {
    if (ownsCwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: `could not spawn '${target.bin}': ${message(err)}` }
  }

  try {
    return await awaitHandshake(child, cwd, timeoutMs)
  } finally {
    await terminateChildTree(child)
    if (ownsCwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/** The state machine: initialize → session/new → done, bounded by one
 *  deadline. Split out so `acpSmokeProbe` owns spawn/teardown only. */
function awaitHandshake(
  child: ChildProcess,
  cwd: string,
  timeoutMs: number,
): Promise<SmokeProbeResult> {
  return new Promise<SmokeProbeResult>((resolve) => {
    let settled = false
    let stage: "initialize" | "session/new" = "initialize"
    let initProtocolVersion: number | undefined
    let loadSession = false
    let buffer = ""
    // Last few stderr lines — the only context when a harness dies before
    // answering (missing auth, broken install, …).
    const stderrTail: string[] = []

    const finish = (result: SmokeProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const fail = (error: string): void => {
      const tail = stderrTail.join("\n")
      finish({ ok: false, error: tail ? `${error}\n  stderr: ${tail}` : error })
    }

    const timer = setTimeout(() => {
      fail(`timed out after ${timeoutMs}ms waiting for ${stage} response`)
    }, timeoutMs)

    const send = (payload: Record<string, unknown>): boolean => {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`)
        return true
      } catch {
        return false
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let msg: RpcResponse
        try {
          msg = JSON.parse(trimmed) as RpcResponse
        } catch {
          continue /* non-JSON chatter on stdout — ignore, ACP is line-JSON */
        }
        if (msg.id === 1) {
          if (msg.error) {
            fail(`initialize rejected: ${rpcErrorMessage(msg)}`)
            return
          }
          const version = msg.result?.["protocolVersion"]
          if (
            typeof version !== "number" ||
            !Number.isInteger(version) ||
            version < 1 ||
            version > ACP_SMOKE_PROTOCOL_VERSION
          ) {
            fail(
              `initialize answered protocolVersion ${JSON.stringify(version)} — ` +
                `agentproto speaks ${ACP_SMOKE_PROTOCOL_VERSION}`,
            )
            return
          }
          initProtocolVersion = version
          const caps = msg.result?.["agentCapabilities"]
          loadSession =
            typeof caps === "object" &&
            caps !== null &&
            "loadSession" in caps &&
            caps.loadSession === true
          stage = "session/new"
          if (
            !send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } })
          ) {
            fail("harness stdin closed before session/new")
          }
        } else if (msg.id === 2) {
          if (msg.error) {
            fail(`session/new rejected: ${rpcErrorMessage(msg)}`)
            return
          }
          const sessionId = msg.result?.["sessionId"]
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            fail(`session/new returned no sessionId (${JSON.stringify(sessionId)})`)
            return
          }
          finish({ ok: true, protocolVersion: initProtocolVersion, ...(loadSession ? { loadSession } : {}) })
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      for (const rawLine of chunk.toString("utf8").split("\n")) {
        const line = rawLine.trim()
        if (!line) continue
        stderrTail.push(line)
        if (stderrTail.length > 4) stderrTail.shift()
      }
    })

    child.once("error", (err) => {
      fail(`harness spawn failed: ${message(err)}`)
    })

    child.once("exit", (code, signal) => {
      fail(
        `harness exited before ${stage} answered ` +
          `(code ${code ?? "null"}, signal ${signal ?? "null"})`,
      )
    })

    if (!send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: ACP_SMOKE_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: "agentproto-harness-probe",
          title: "agentproto-harness-probe",
          version: "0.0.0",
        },
      },
    })) {
      fail("harness stdin closed before initialize")
    }
  })
}

function rpcErrorMessage(msg: RpcResponse): string {
  const err = msg.error
  if (!err) return "unknown error"
  const text = typeof err.message === "string" ? err.message : "unknown error"
  return typeof err.code === "number" ? `${text} (code ${err.code})` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
