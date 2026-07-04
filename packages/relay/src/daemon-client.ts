/**
 * Thin HTTP(S)/WS client for the ONE thing this relay needs from an
 * agentproto daemon: "is my configured target session alive, and can I
 * push text into it." Talks to the daemon purely over its public
 * REST/WS surface — this package is not an MCP client and does not
 * link against @agentproto/runtime.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"

export interface SessionAliveResult {
  ok: boolean
  /** Canonical session id, resolved from id-or-name by the daemon. */
  id?: string
  status?: string
  /** Present when ok is false — human-readable cause. */
  reason?: string
}

export interface DeliveryResult {
  ok: boolean
  status?: number
  message?: string
}

const DEAD_STATUSES = new Set(["exited", "killed", "error"])

/**
 * GET /sessions/:id — resolves id-or-name to a canonical session, and
 * confirms it's actually alive (not exited/killed/errored, process
 * still running). Read-only route, no daemon auth token needed.
 */
export async function checkSessionAlive(
  daemonUrl: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionAliveResult> {
  let res: Response
  try {
    res = await fetchImpl(`${daemonUrl}/sessions/${encodeURIComponent(target)}`, {
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return {
      ok: false,
      reason: `could not reach daemon at ${daemonUrl}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (res.status === 404) {
    return { ok: false, reason: `no session "${target}" on the daemon` }
  }
  if (!res.ok) {
    return { ok: false, reason: `daemon returned HTTP ${res.status} for GET /sessions/${target}` }
  }
  let desc: { id?: unknown; status?: unknown; processAlive?: unknown }
  try {
    desc = (await res.json()) as { id?: unknown; status?: unknown; processAlive?: unknown }
  } catch {
    return { ok: false, reason: "daemon returned a non-JSON session descriptor" }
  }
  if (typeof desc.id !== "string") {
    return { ok: false, reason: "daemon's session descriptor is missing an id" }
  }
  const status = typeof desc.status === "string" ? desc.status : undefined
  if (status && DEAD_STATUSES.has(status)) {
    return { ok: false, id: desc.id, status, reason: `session "${target}" has status "${status}"` }
  }
  if (desc.processAlive === false) {
    return { ok: false, id: desc.id, status, reason: `session "${target}" process is not alive` }
  }
  return { ok: true, id: desc.id, status }
}

interface RegistryMetaLike {
  pid?: unknown
  token?: unknown
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * A daemon publishes its per-boot bearer token in two places (see
 * @agentproto/runtime's agentproto-dir.ts): a workspace-scoped
 * `<workspace>/.agentproto/runtime.json`, and a workspace-independent
 * `~/.agentproto/daemons/<port>.json`. The central one is keyed purely
 * by port, so we check it first; the workspace one requires an extra
 * round trip to /health to learn the workspace path, and is a
 * best-effort write on the daemon's side (it can be absent even for a
 * live, otherwise-healthy daemon), so it's the fallback.
 */
export async function resolveDaemonToken(
  daemonUrl: string,
  opts: { fetchImpl?: typeof fetch; homeDir?: string } = {},
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const homeDir = opts.homeDir ?? homedir()

  const fromRegistry = await readRegistryToken(daemonUrl, homeDir)
  if (fromRegistry) return fromRegistry
  return readWorkspaceToken(daemonUrl, fetchImpl)
}

async function readRegistryToken(daemonUrl: string, homeDir: string): Promise<string | undefined> {
  let port: string
  try {
    port = new URL(daemonUrl).port
  } catch {
    return undefined
  }
  if (!port) return undefined
  try {
    const raw = await readFile(join(homeDir, ".agentproto", "daemons", `${port}.json`), "utf8")
    const meta = JSON.parse(raw) as RegistryMetaLike
    if (typeof meta.pid === "number" && !isPidAlive(meta.pid)) return undefined
    return typeof meta.token === "string" && meta.token ? meta.token : undefined
  } catch {
    return undefined
  }
}

async function readWorkspaceToken(
  daemonUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${daemonUrl}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return undefined
    const health = (await res.json()) as { workspace?: unknown }
    if (typeof health.workspace !== "string" || !health.workspace) return undefined
    const raw = await readFile(join(health.workspace, ".agentproto", "runtime.json"), "utf8")
    const meta = JSON.parse(raw) as RegistryMetaLike
    return typeof meta.token === "string" && meta.token ? meta.token : undefined
  } catch {
    return undefined
  }
}

/**
 * POST /sessions/:id/prompt?wait=false — the REST equivalent of the
 * `agent_prompt` MCP tool. Fire-and-forget on purpose: an external
 * webhook sender may have a short timeout, and there's no reason to
 * hold its connection open for an entire LLM turn just to relay one
 * message in.
 */
export async function sendAgentPrompt(
  daemonUrl: string,
  sessionId: string,
  text: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  try {
    const res = await fetchImpl(
      `${daemonUrl}/sessions/${encodeURIComponent(sessionId)}/prompt?wait=false`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt: text }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (res.ok) return { ok: true, status: res.status }
    return { ok: false, status: res.status, message: await describeErrorResponse(res) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

async function describeErrorResponse(res: Response): Promise<string> {
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
 * Writes text to a live PTY session's stdin. Unlike `agent_prompt`,
 * there is no plain-HTTP REST route for `terminal_input` on the
 * daemon — the only transport is the WebSocket upgrade at
 * /sessions/:id/pty (JSON frames), so this is the one delivery path
 * that isn't a simple fetch() call.
 */
export async function sendTerminalInput(
  daemonUrl: string,
  sessionId: string,
  text: string,
  token: string | undefined,
  timeoutMs = 10_000,
): Promise<DeliveryResult> {
  const wsUrl = `${daemonUrl.replace(/^http/, "ws")}/sessions/${encodeURIComponent(sessionId)}/pty`
  return new Promise<DeliveryResult>(resolvePromise => {
    let settled = false
    const settle = (result: DeliveryResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }

    const ws = new WebSocket(wsUrl, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    const timer = setTimeout(() => {
      ws.terminate()
      settle({ ok: false, message: "terminal_input: timed out connecting to the daemon" })
    }, timeoutMs)

    ws.once("open", () => {
      ws.send(JSON.stringify({ kind: "input", text }))
      ws.close(1000)
      settle({ ok: true })
    })
    ws.once("unexpected-response", (_req, res) => {
      ws.terminate()
      settle({
        ok: false,
        status: res.statusCode,
        message: `terminal_input: daemon rejected the WebSocket upgrade with HTTP ${res.statusCode}`,
      })
    })
    ws.once("error", err => {
      settle({ ok: false, message: err instanceof Error ? err.message : String(err) })
    })
  })
}
