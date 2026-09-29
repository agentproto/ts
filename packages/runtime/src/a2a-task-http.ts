/**
 * `POST /a2a/apps/:appId` — A2A JSON-RPC 2.0 task ingress for one installed
 * app. `message/send` starts an `app_run` for an exposed agent skill,
 * `tasks/get` reports it, `tasks/cancel` stops it. Everything runs through the
 * daemon's own `app_run` / `app_status` / `app_stop` / `app_artifact_get`
 * tools via `dispatchTool` (the same in-process dispatcher the REST
 * `tool-call` twin uses), so there is one implementation of a run.
 *
 * Mapping and the task ledger live in a2a-tasks.ts. Auth (bearer + browser
 * origin guard) is applied by the dispatch block in http-server.ts.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { loadAppHandle } from "@agentproto/app-kit"
import type { AppRegistry } from "./app-registry.js"
import {
  JSON_RPC_ERROR,
  buildTask,
  createA2aTaskLedger,
  extractSkillRequest,
  mapAppArtifact,
  mapRunState,
  resolveExposedSkill,
  TERMINAL_TASK_STATES,
  unwrapToolResult,
  type A2aAppHandleLike,
  type A2aArtifact,
  type A2aPart,
  type A2aRunView,
  type A2aTask,
  type A2aTaskLedger,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./a2a-tasks.js"

/** Optional knobs on `RuntimeHttpServerOptions.a2aTasks`. */
export interface A2aTaskHttpConfig {
  /** Daemon state dir; the ledger lives in `<stateDir>/a2a-tasks/`.
   *  Defaults to `~/.agentproto`, next to `apps.json`. */
  stateDir?: string
  /** Reads `accepts` / `exposes` for an installed app dir. Defaults to
   *  app-kit's `loadAppHandle`. */
  loadHandle?: (dir: string) => Promise<A2aAppHandleLike>
}

export interface A2aTaskHttpDeps extends A2aTaskHttpConfig {
  appRegistry: AppRegistry
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const A2A_APP_PATH_RE = /^\/a2a\/apps\/(.+)$/
const MAX_BODY_BYTES = 1024 * 1024

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: JsonRpcResponse): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<{ raw: string } | { tooLarge: true }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > MAX_BODY_BYTES) return { tooLarge: true }
    chunks.push(buf)
  }
  return { raw: Buffer.concat(chunks).toString("utf8") }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function parseParts(raw: unknown): A2aPart[] {
  if (!Array.isArray(raw)) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "message.parts must be an array")
  const parts: A2aPart[] = []
  for (const p of raw) {
    if (!isRecord(p) || typeof p.kind !== "string") {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "each message part needs a string `kind`")
    }
    if (p.kind === "text") {
      if (typeof p.text !== "string") throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "text part needs a string `text`")
      parts.push({ kind: "text", text: p.text })
    }
    // file/data parts are accepted but carry no prompt text in this wave.
  }
  return parts
}

/**
 * Handle one request. Returns false (nothing written) when `path` is not an
 * A2A task route or the method isn't POST, so the caller falls through.
 */
export async function handleA2aTaskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: A2aTaskHttpDeps,
): Promise<boolean> {
  const m = A2A_APP_PATH_RE.exec(path)
  if (!m || req.method !== "POST" || m[1]!.includes("/.well-known/")) return false
  const appId = decodeURIComponent(m[1]!)

  const body = await readBody(req)
  if ("tooLarge" in body) {
    send(res, 413, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR.invalidRequest, message: "request body too large" } })
    return true
  }
  let rpc: unknown
  try {
    rpc = JSON.parse(body.raw)
  } catch {
    send(res, 200, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR.parse, message: "parse error: body is not valid JSON" } })
    return true
  }
  if (!isRecord(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    send(res, 200, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR.invalidRequest, message: 'invalid request: expected a JSON-RPC 2.0 object with a string "method" (batches are not supported)' } })
    return true
  }
  const id: JsonRpcId = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null
  const method = rpc.method
  const params = isRecord(rpc.params) ? rpc.params : {}

  const installed = deps.appRegistry.getApp(appId)
  if (!installed) {
    send(res, 404, { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERROR.unsupportedOperation, message: `no installed app "${appId}"` } })
    return true
  }

  const ledger: A2aTaskLedger = createA2aTaskLedger(join(deps.stateDir ?? join(homedir(), ".agentproto"), "a2a-tasks"))
  const loadHandle = deps.loadHandle ?? (async (dir: string) => (await loadAppHandle(dir)) as unknown as A2aAppHandleLike)

  const call = async (tool: string, args: Record<string, unknown>) => {
    if (!deps.dispatchTool) {
      throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, "A2A task ingress is unavailable: the daemon has no tool dispatcher wired")
    }
    return unwrapToolResult(await deps.dispatchTool(tool, args))
  }

  const readTask = async (taskId: string): Promise<A2aTask> => {
    const entry = await ledger.find(appId, taskId)
    if (!entry) throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `task "${taskId}" not found for app "${appId}"`)
    const status = await call("app_status", { appRunId: taskId })
    if (!status.ok || !status.data) {
      throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `task "${taskId}" has no backing app run: ${status.text}`)
    }
    const run = status.data as unknown as A2aRunView
    let artifacts: A2aArtifact[] | undefined
    if (mapRunState(run) === "completed" && installed.artifact) {
      const art = await call("app_artifact_get", { appId })
      if (art.ok && art.data) artifacts = mapAppArtifact(art.data)
    }
    return buildTask({ entry, run, ...(artifacts ? { artifacts } : {}), newId: randomUUID })
  }

  try {
    switch (method) {
      case "message/send": {
        let handle: A2aAppHandleLike
        try {
          handle = await loadHandle(installed.dir)
        } catch (err) {
          throw new RpcFailure(JSON_RPC_ERROR.internal, `could not read app manifest: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (handle.accepts?.tasks !== true) {
          throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, `method "message/send" is not allowed for app "${appId}": its manifest does not declare accepts.tasks: true`)
        }
        const rawMessage = params.message
        if (!isRecord(rawMessage) || rawMessage.role !== "user") {
          throw new RpcFailure(JSON_RPC_ERROR.invalidParams, 'params.message must be an object with role "user"')
        }
        const parts = parseParts(rawMessage.parts)
        const { skill, prompt } = extractSkillRequest(
          { parts, ...(isRecord(rawMessage.metadata) ? { metadata: rawMessage.metadata } : {}) },
          appId,
          isRecord(params.metadata) ? params.metadata : undefined,
        )
        if (!skill) {
          throw new RpcFailure(JSON_RPC_ERROR.invalidParams, 'no skill requested: set message.metadata.skill or start the first text part with "skill:<id>"')
        }
        const target = resolveExposedSkill(handle, skill)
        if (!target) {
          throw new RpcFailure(JSON_RPC_ERROR.invalidParams, `unknown skill "${skill}": app "${appId}" does not expose it`)
        }
        if (target.kind === "workflow") {
          throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, `skill "${skill}" is a workflow; only agent skills can be run as A2A tasks in this version`)
        }
        const run = await call("app_run", { appId, agents: [target.id], ...(prompt ? { prompt } : {}) })
        const started = run.data as { appRunId?: unknown; sessions?: unknown; errors?: unknown } | undefined
        if (!run.ok || typeof started?.appRunId !== "string") {
          throw new RpcFailure(JSON_RPC_ERROR.internal, run.text || "app_run failed")
        }
        if (!Array.isArray(started.sessions) || started.sessions.length === 0) {
          const detail = Array.isArray(started.errors) ? JSON.stringify(started.errors) : "no session was started"
          throw new RpcFailure(JSON_RPC_ERROR.internal, `agent "${target.id}" did not start: ${detail}`)
        }
        await ledger.append({
          taskId: started.appRunId,
          appId,
          contextId: typeof rawMessage.contextId === "string" && rawMessage.contextId ? rawMessage.contextId : randomUUID(),
          skill,
          createdAt: new Date().toISOString(),
        })
        send(res, 200, { jsonrpc: "2.0", id, result: await readTask(started.appRunId) })
        return true
      }
      case "tasks/get": {
        if (typeof params.id !== "string" || !params.id) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (task id) is required")
        send(res, 200, { jsonrpc: "2.0", id, result: await readTask(params.id) })
        return true
      }
      case "tasks/cancel": {
        if (typeof params.id !== "string" || !params.id) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (task id) is required")
        const before = await readTask(params.id)
        if (TERMINAL_TASK_STATES.has(before.status.state)) {
          throw new RpcFailure(JSON_RPC_ERROR.taskNotCancelable, `task "${params.id}" is already ${before.status.state}`)
        }
        const stop = await call("app_stop", { appRunId: params.id })
        if (!stop.ok) throw new RpcFailure(JSON_RPC_ERROR.internal, stop.text || "app_stop failed")
        send(res, 200, { jsonrpc: "2.0", id, result: await readTask(params.id) })
        return true
      }
      case "message/stream":
      case "tasks/resubscribe":
        throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, `method "${method}" is not supported: this agent does not advertise streaming`)
      default:
        if (method.startsWith("tasks/pushNotificationConfig/")) {
          throw new RpcFailure(JSON_RPC_ERROR.pushNotificationNotSupported, "push notifications are not supported")
        }
        throw new RpcFailure(JSON_RPC_ERROR.methodNotFound, `method not found: ${method}`)
    }
  } catch (err) {
    if (err instanceof RpcFailure) {
      send(res, 200, { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } })
    } else {
      send(res, 200, { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERROR.internal, message: err instanceof Error ? err.message : String(err) } })
    }
    return true
  }
}
