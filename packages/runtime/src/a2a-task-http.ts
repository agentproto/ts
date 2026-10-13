/**
 * `POST /a2a/apps/:appId` — A2A 1.0 JSON-RPC 2.0 task ingress for one
 * installed app. `SendMessage` starts an `app_run` for an exposed agent
 * skill or a background workflow run for an exposed workflow skill,
 * `GetTask` reports it, `ListTasks` pages the ledger for the app, and
 * `CancelTask` stops it. `SendStreamingMessage` starts
 * a run the same way and answers `Content-Type: text/event-stream`;
 * `SubscribeToTask` attaches to a task that is still running the same way.
 * Both streams are a poll of `readTask` (no event bus): every SSE event is
 * `data: <JSON-RPC response>` whose `result` is exactly one of `{task}`,
 * `{message}`, `{statusUpdate}` or `{artifactUpdate}` — A2A 1.0's oneof — and
 * the stream ends on a terminal state, a client disconnect, or the
 * `streamMaxMs` cap. Everything runs through the
 * daemon's own `app_run` / `app_status` / `app_stop` / `app_artifact_get`
 * and `workflow_run_file` / `workflow_status` / `workflow_cancel` tools via
 * `dispatchTool` (the same in-process dispatcher the REST `tool-call` twin
 * uses), so there is one implementation of a run.
 *
 * The four push-config methods (`CreateTaskPushNotificationConfig`,
 * `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`,
 * `DeleteTaskPushNotificationConfig`) manage per-task webhook registrations
 * in a JSON store beside the ledger; a config on a live task arms one
 * background watcher (a2a-push.ts) that POSTs the same `StreamResponse`
 * events the SSE streams write. `SendMessage` / `SendStreamingMessage` accept
 * a `configuration.taskPushNotificationConfig` (or its `pushNotificationConfig`
 * alias) the same way.
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
import { writeSseHead } from "./sse-headers.js"
import { createA2aPushService, getA2aPushService, type A2aPushDeps } from "./a2a-push.js"
import {
  A2A_SUPPORTED_VERSIONS,
  A2A_TASK_STATE_VALUES,
  JSON_RPC_ERROR,
  RpcFailure,
  buildTask,
  buildWorkflowTask,
  createA2aPushConfigStore,
  createA2aTaskLedger,
  decodePageToken,
  encodePageToken,
  extractLastAssistantText,
  extractSkillRequest,
  mapAppArtifact,
  mapRunState,
  negotiateVersion,
  parseA2aTaskPushNotificationConfig,
  resolveExposedSkill,
  watchTask,
  TERMINAL_TASK_STATES,
  unwrapToolResult,
  A2aPushConfigLimitError,
  type A2aAgentOutput,
  type A2aAppHandleLike,
  type A2aArtifact,
  type A2aPart,
  type A2aPushConfigStore,
  type A2aRunView,
  type A2aTask,
  type A2aTaskLedger,
  type A2aTaskPushNotificationConfig,
  type A2aTaskState,
  type A2aWorkflowRunView,
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
  /** Poll cadence of the SSE task streams (`SendStreamingMessage`,
   *  `SubscribeToTask`). Defaults to 1000 ms. */
  streamPollMs?: number
  /** Hard cap on one SSE stream: it ends with a `statusUpdate` of the state
   *  the task is actually in. Defaults to 30 minutes. */
  streamMaxMs?: number
  /** Push delivery knobs (fetch, poll cadence, retries, clock) — injectable
   *  so tests run fast. See a2a-push.ts. */
  push?: A2aPushDeps
}

export interface A2aTaskHttpDeps extends A2aTaskHttpConfig {
  appRegistry: AppRegistry
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const A2A_APP_PATH_RE = /^\/a2a\/apps\/(.+)$/
const MAX_BODY_BYTES = 1024 * 1024
const A2A_TASK_STATES: ReadonlySet<string> = new Set<string>(A2A_TASK_STATE_VALUES)
/** With a `status` / `statusTimestampAfter` filter, `ListTasks` reads the
 *  newest this many ledger entries and keeps the matches. */
const LIST_TASKS_FILTER_CAP = 500
const LIST_TASKS_DEFAULT_PAGE_SIZE = 50

/** Poll cadence of the SSE task streams when `streamPollMs` is unset. */
const DEFAULT_STREAM_POLL_MS = 1000
/** Hard cap on one SSE stream when `streamMaxMs` is unset (30 minutes). */
const DEFAULT_STREAM_MAX_MS = 30 * 60 * 1000
/** `: keepalive` comment cadence, written only while the stream was silent. */
const STREAM_KEEPALIVE_MS = 15_000

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
    if (!isRecord(p)) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "each message part must be an object")
    if ("text" in p) {
      if (typeof p.text !== "string") throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "part.text must be a string")
      parts.push({ text: p.text })
    } else if ("data" in p) {
      // Kept so a workflow skill can take its input straight off the message.
      parts.push({ data: p.data })
    } else if (!("raw" in p || "url" in p)) {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "each message part needs one of text, raw, url or data")
    }
    // raw/url parts are accepted but carry no prompt text in this wave.
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
  if (!m || req.method !== "POST") return false
  let appId: string
  try {
    appId = decodeURIComponent(m[1]!)
  } catch {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR.invalidRequest, message: "malformed percent-encoding in app id" } })
    return true
  }
  if (appId.includes("/.well-known/")) return false

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

  const requested = negotiateVersion(
    typeof req.headers["a2a-version"] === "string" ? req.headers["a2a-version"] : undefined,
    new URL(req.url ?? "/", "http://localhost").searchParams.get("version"),
  )
  if (!requested.supported) {
    send(res, 200, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSON_RPC_ERROR.versionNotSupported,
        message: `A2A version "${requested.version}" is not supported; supported: ${A2A_SUPPORTED_VERSIONS.join(", ")}`,
        data: { supportedVersions: A2A_SUPPORTED_VERSIONS },
      },
    })
    return true
  }

  const installed = deps.appRegistry.getApp(appId)
  if (!installed) {
    send(res, 404, { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERROR.unsupportedOperation, message: `no installed app "${appId}"` } })
    return true
  }

  const stateDir = deps.stateDir ?? join(homedir(), ".agentproto")
  const ledger: A2aTaskLedger = createA2aTaskLedger(join(stateDir, "a2a-tasks"))
  const configs: A2aPushConfigStore = createA2aPushConfigStore(join(stateDir, "a2a-tasks"))
  // One push watcher per task, in memory for this daemon's lifetime (never
  // resumed across a restart — see a2a-push.ts).
  const push = getA2aPushService(stateDir, onIdle => createA2aPushService(deps.push ?? {}, onIdle))
  const loadHandle = deps.loadHandle ?? (async (dir: string) => (await loadAppHandle(dir)) as unknown as A2aAppHandleLike)

  const call = async (tool: string, args: Record<string, unknown>) => {
    if (!deps.dispatchTool) {
      throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, "A2A task ingress is unavailable: the daemon has no tool dispatcher wired")
    }
    return unwrapToolResult(await deps.dispatchTool(tool, args))
  }

  /** Collect each session's answer for a completed run: the last assistant
   *  reply from `conversation_read`, falling back to the descriptor's
   *  `outcome.summary`. Never throws — a session with no readable answer
   *  simply contributes no output. */
  const collectAgentOutputs = async (run: A2aRunView): Promise<A2aAgentOutput[]> => {
    const outputs: A2aAgentOutput[] = []
    for (const session of run.sessions ?? []) {
      const agentId = typeof session.agentId === "string" ? session.agentId : undefined
      if (!agentId) continue
      let text: string | undefined
      if (typeof session.sessionId === "string" && session.sessionId) {
        try {
          const conv = await call("conversation_read", { idOrName: session.sessionId, format: "json", lastN: 6 })
          if (conv.ok) text = extractLastAssistantText(conv.text)
        } catch {
          // Fall through to the descriptor summary below.
        }
      }
      if (text === undefined) {
        const summary = session.descriptor?.outcome?.summary
        if (typeof summary === "string" && summary.trim() !== "") text = summary
      }
      if (text !== undefined) outputs.push({ agentId, text })
    }
    return outputs
  }

  const readTask = async (taskId: string): Promise<A2aTask> => {
    const entry = await ledger.find(appId, taskId)
    if (!entry) throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `task "${taskId}" not found for app "${appId}"`)
    if (entry.kind === "workflow") {
      const status = await call("workflow_status", { runId: taskId, full: true })
      const data = status.data as { error?: unknown; status?: unknown } | undefined
      // A missing run answers `{error: "run not found"}` — a FAILED run also
      // carries `error`, but with its own `status`, so status is the gate.
      if (!status.ok || !data || data.error === "run not found" || typeof data.status !== "string") {
        throw new RpcFailure(
          JSON_RPC_ERROR.taskNotFound,
          `task "${taskId}" has no backing workflow run: ${status.text}`,
        )
      }
      return buildWorkflowTask({ entry, run: data as A2aWorkflowRunView, newId: randomUUID })
    }
    const status = await call("app_status", { appRunId: taskId, full: true })
    if (!status.ok || !status.data) {
      throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `task "${taskId}" has no backing app run: ${status.text}`)
    }
    const run = status.data as unknown as A2aRunView
    let artifacts: A2aArtifact[] | undefined
    let agentOutputs: A2aAgentOutput[] | undefined
    if (mapRunState(run) === "TASK_STATE_COMPLETED") {
      const outputs = await collectAgentOutputs(run)
      if (outputs.length > 0) agentOutputs = outputs
      if (installed.artifact) {
        const art = await call("app_artifact_get", { appId })
        if (art.ok && art.data) artifacts = mapAppArtifact(art.data)
      }
    }
    return buildTask({
      entry,
      run,
      ...(artifacts ? { artifacts } : {}),
      ...(agentOutputs ? { agentOutputs } : {}),
      newId: randomUUID,
    })
  }

  /**
   * Start the run behind a `SendMessage`-shaped request — same validation,
   * same ledger write — and return its task id (the `app_run` id, or the
   * workflow run id). Shared by `SendMessage`, which answers `{task}` right
   * away, and `SendStreamingMessage`, which streams the same run.
   */
  const startMessageTask = async (params: Record<string, unknown>, method: string): Promise<string> => {
    let handle: A2aAppHandleLike
    try {
      handle = await loadHandle(installed.dir)
    } catch (err) {
      throw new RpcFailure(JSON_RPC_ERROR.internal, `could not read app manifest: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (handle.accepts?.tasks !== true) {
      throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, `method "${method}" is not allowed for app "${appId}": its manifest does not declare accepts.tasks: true`)
    }
    const rawMessage = params.message
    if (!isRecord(rawMessage) || rawMessage.role !== "ROLE_USER") {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, 'params.message must be an object with role "ROLE_USER"')
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
      const ref = handle.workflows?.find(w => w.id === target.id)
      // The registry's refs carry the absolute path too — the manifest
      // handle may not, so fall back to it before declaring the bundle
      // missing.
      const path =
        (typeof ref?.path === "string" && ref.path !== "" ? ref.path : undefined) ??
        installed.workflows?.find(w => w.id === target.id)?.path
      if (typeof path !== "string" || path === "") {
        throw new RpcFailure(
          JSON_RPC_ERROR.unsupportedOperation,
          `app "${appId}" exposes workflow "${target.id}" but does not bundle it`,
        )
      }
      let dataInput: Record<string, unknown> | undefined
      for (const part of parts) {
        const d = (part as { data?: unknown }).data
        if (isRecord(d)) {
          dataInput = d
          break
        }
      }
      const input = dataInput ?? (prompt ? { prompt } : {})
      const started = await call("workflow_run_file", { path, input, appId })
      const reply = (started.data ?? {}) as { runId?: unknown; error?: unknown }
      const runId = typeof reply.runId === "string" && reply.runId !== "" ? reply.runId : undefined
      const errText = typeof reply.error === "string" && reply.error !== "" ? reply.error : undefined
      if (runId === undefined || errText !== undefined) {
        throw new RpcFailure(JSON_RPC_ERROR.internal, errText ?? (started.text || "workflow_run_file failed"))
      }
      await ledger.append({
        taskId: runId,
        appId,
        contextId: typeof rawMessage.contextId === "string" && rawMessage.contextId ? rawMessage.contextId : randomUUID(),
        skill,
        createdAt: new Date().toISOString(),
        kind: "workflow",
      })
      return runId
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
    return started.appRunId
  }

  /**
   * Stream one task as `text/event-stream`: a first `{task}` event (when
   * `initial` asks for one), then the `watchTask` poll — `{artifactUpdate}`
   * (`lastChunk: true`) for every artifact not sent yet and a
   * `{statusUpdate}` whenever the state or its timestamp moved — artifacts
   * first, so the final `{statusUpdate: {final: true}}` of a terminal state
   * is always the stream's last event. A silent stream gets a `: keepalive`
   * comment every 15 s; a `readTask` failure mid-stream answers with one
   * JSON-RPC `error` event; a client disconnect or the `streamMaxMs` cap
   * stop the poll (the cap ends on a `statusUpdate` of the state the task
   * is actually in, claiming `final` only when the state is terminal). The
   * poll loop itself lives in `watchTask` (a2a-tasks.ts), shared with push
   * delivery; keepalive and disconnect handling stay here.
   *
   * Anything that can fail before the head is written — the first `readTask`
   * above all — must be thrown, not written: `handleA2aTaskRequest`'s catch
   * turns it into a plain JSON-RPC error response.
   */
  const streamTask = async (
    taskId: string,
    res: ServerResponse,
    id: JsonRpcId,
    opts: { initial: "task" },
  ): Promise<void> => {
    const pollMs = Math.max(1, deps.streamPollMs ?? DEFAULT_STREAM_POLL_MS)
    const deadline = Date.now() + (deps.streamMaxMs ?? DEFAULT_STREAM_MAX_MS)

    let lastWrite = Date.now()
    let closed = false
    // The disconnect signal for the shared watcher. `req`'s own `close` is
    // documented as "the request has been completed" — on this POST route
    // that is the moment the body has been read, long before the client goes
    // away — so `res`'s `close` (the response's lifetime) is what says the
    // connection dropped mid-stream.
    const signal = {
      get aborted(): boolean {
        return closed || res.writableEnded
      },
    }
    const onClose = (): void => {
      closed = true
    }
    res.on("close", onClose)

    // The first read happens before the head is out, so a failure there is
    // still a plain JSON-RPC error response.
    const watcher = watchTask(taskId, {
      readTask,
      pollMs,
      deadline,
      signal,
      ...(opts.initial === "task" ? { initial: true } : {}),
    })
    const first = await watcher.next()
    if (first.done === true) {
      res.off("close", onClose)
      throw new RpcFailure(JSON_RPC_ERROR.internal, "task watcher ended before the stream opened")
    }
    writeSseHead(res)

    const write = (body: { result?: unknown; error?: { code: number; message: string } }): void => {
      if (closed || res.writableEnded) return
      try {
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n\n`)
      } catch {
        closed = true
        return
      }
      lastWrite = Date.now()
    }
    const keepalive = setInterval(() => {
      if (closed || Date.now() - lastWrite < STREAM_KEEPALIVE_MS) return
      try {
        res.write(`: keepalive\n\n`)
        lastWrite = Date.now()
      } catch {
        closed = true
      }
    }, STREAM_KEEPALIVE_MS)
    const finish = (): void => {
      clearInterval(keepalive)
      res.off("close", onClose)
      if (!res.writableEnded) res.end()
    }

    const start = first.value
    if ("task" in start) write({ result: start })
    for await (const ev of watcher) {
      if (closed || res.writableEnded) break
      if ("error" in ev) {
        write({ error: ev.error })
        break
      }
      write({ result: ev })
    }
    finish()
  }

  /** `listConfigs` for the push service: re-read the store on every delivery
   *  so a deleted config stops receiving at once. */
  const pushConfigsFor = (taskId: string): (() => Promise<A2aTaskPushNotificationConfig[]>) => () => configs.list(appId, taskId)

  /** Store one config, mapping the per-task limit to `invalidParams`. */
  const storePushConfig = async (config: A2aTaskPushNotificationConfig): Promise<void> => {
    try {
      await configs.create(appId, config)
    } catch (err) {
      if (err instanceof A2aPushConfigLimitError) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, err.message)
      throw err
    }
  }

  /** The ledger gate every push-config method shares: the task must exist
   *  for this app. */
  const requireTaskEntry = async (taskId: string): Promise<void> => {
    if (!(await ledger.find(appId, taskId))) {
      throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `task "${taskId}" not found for app "${appId}"`)
    }
  }

  const requireTaskIdParam = (): string => {
    const taskId = params.taskId
    if (typeof taskId !== "string" || taskId === "") {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.taskId (task id) is required")
    }
    return taskId
  }

  const requireConfigIdParam = (): string => {
    const configId = params.id
    if (typeof configId !== "string" || configId === "") {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (push notification config id) is required")
    }
    return configId
  }

  /**
   * A push config now exists for a live task: start its one background
   * watcher (none per config) unless one runs or the task is already
   * terminal — a terminal task gets one final `{statusUpdate: {final: true}}`
   * instead, with no watcher.
   */
  const armPushDelivery = async (taskId: string): Promise<void> => {
    const task = await readTask(taskId)
    if (TERMINAL_TASK_STATES.has(task.status.state)) {
      await push.deliverFinal({ task, listConfigs: pushConfigsFor(taskId) })
      return
    }
    push.ensureWatching({ appId, taskId, readTask, listConfigs: pushConfigsFor(taskId) })
  }

  /**
   * The push config of a `SendMessage` / `SendStreamingMessage`
   * `configuration` — the spec's `taskPushNotificationConfig` plus the
   * `pushNotificationConfig` alias. Validated (shape + URL) before the run
   * starts, so a bad URL starts nothing; `taskId` is stamped once the run
   * exists. Returns undefined when the configuration carries none.
   */
  const takeRequestPushConfig = (params: Record<string, unknown>): A2aTaskPushNotificationConfig | undefined => {
    const configuration = params.configuration
    if (configuration === undefined || configuration === null) return undefined
    if (!isRecord(configuration)) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.configuration must be an object")
    const raw = configuration.taskPushNotificationConfig ?? configuration.pushNotificationConfig
    if (raw === undefined || raw === null) return undefined
    try {
      return parseA2aTaskPushNotificationConfig(raw, { taskId: "" })
    } catch (err) {
      throw new RpcFailure(JSON_RPC_ERROR.invalidParams, err instanceof Error ? err.message : String(err))
    }
  }

  try {
    switch (method) {
      case "SendMessage": {
        const requestPushConfig = takeRequestPushConfig(params)
        const taskId = await startMessageTask(params, "SendMessage")
        if (requestPushConfig) {
          await storePushConfig({ ...requestPushConfig, taskId })
          await armPushDelivery(taskId)
        }
        send(res, 200, { jsonrpc: "2.0", id, result: { task: await readTask(taskId) } })
        return true
      }
      case "SendStreamingMessage": {
        const requestPushConfig = takeRequestPushConfig(params)
        const taskId = await startMessageTask(params, method)
        if (requestPushConfig) {
          await storePushConfig({ ...requestPushConfig, taskId })
          await armPushDelivery(taskId)
        }
        await streamTask(taskId, res, id, { initial: "task" })
        return true
      }
      case "SubscribeToTask": {
        if (typeof params.id !== "string" || !params.id) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (task id) is required")
        const taskId = params.id
        const before = await readTask(taskId)
        // A2A 1.0: attaching to a task that is already final is an error,
        // not a stream that immediately ends — the answer is `GetTask`.
        if (TERMINAL_TASK_STATES.has(before.status.state)) {
          throw new RpcFailure(JSON_RPC_ERROR.unsupportedOperation, `task is already ${before.status.state}`)
        }
        await streamTask(taskId, res, id, { initial: "task" })
        return true
      }
      case "GetTask": {
        if (typeof params.id !== "string" || !params.id) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (task id) is required")
        send(res, 200, { jsonrpc: "2.0", id, result: await readTask(params.id) })
        return true
      }
      case "CancelTask": {
        if (typeof params.id !== "string" || !params.id) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.id (task id) is required")
        const before = await readTask(params.id)
        if (TERMINAL_TASK_STATES.has(before.status.state)) {
          throw new RpcFailure(JSON_RPC_ERROR.taskNotCancelable, `task "${params.id}" is already ${before.status.state}`)
        }
        const entry = await ledger.find(appId, params.id)
        const isWorkflow = entry?.kind === "workflow"
        const stop = isWorkflow
          ? await call("workflow_cancel", { runId: params.id })
          : await call("app_stop", { appRunId: params.id })
        if (!stop.ok) {
          throw new RpcFailure(JSON_RPC_ERROR.internal, stop.text || `${isWorkflow ? "workflow_cancel" : "app_stop"} failed`)
        }
        send(res, 200, { jsonrpc: "2.0", id, result: await readTask(params.id) })
        return true
      }
      case "ListTasks": {
        let pageSize = LIST_TASKS_DEFAULT_PAGE_SIZE
        if (params.pageSize !== undefined) {
          if (typeof params.pageSize !== "number" || !Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 100) {
            throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageSize must be an integer between 1 and 100")
          }
          pageSize = params.pageSize
        }
        let offset = 0
        if (params.pageToken !== undefined) {
          if (typeof params.pageToken !== "string") throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageToken must be a string")
          const decoded = decodePageToken(params.pageToken)
          if (decoded === undefined) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageToken is not a valid page token")
          offset = decoded
        }
        let status: A2aTaskState | undefined
        if (params.status !== undefined) {
          if (typeof params.status !== "string" || !A2A_TASK_STATES.has(params.status)) {
            throw new RpcFailure(JSON_RPC_ERROR.invalidParams, `params.status is not a valid task state: ${JSON.stringify(params.status)}`)
          }
          status = params.status as A2aTaskState
        }
        let statusAfterMs: number | undefined
        if (params.statusTimestampAfter !== undefined) {
          if (typeof params.statusTimestampAfter !== "string") {
            throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.statusTimestampAfter must be a string")
          }
          statusAfterMs = Date.parse(params.statusTimestampAfter)
          if (!Number.isFinite(statusAfterMs)) {
            throw new RpcFailure(JSON_RPC_ERROR.invalidParams, `params.statusTimestampAfter is not a parsable ISO timestamp: ${params.statusTimestampAfter}`)
          }
        }
        const includeArtifacts = params.includeArtifacts === true
        const historyLength =
          typeof params.historyLength === "number" && Number.isInteger(params.historyLength) && params.historyLength >= 0
            ? params.historyLength
            : undefined

        /** A ledger entry whose backing run is gone is skipped, not fatal. */
        const readTaskIfPresent = async (taskId: string): Promise<A2aTask | undefined> => {
          try {
            return await readTask(taskId)
          } catch (err) {
            if (err instanceof RpcFailure && err.code === JSON_RPC_ERROR.taskNotFound) return undefined
            throw err
          }
        }

        let entries = await ledger.list(appId)
        if (typeof params.contextId === "string" && params.contextId !== "") {
          const contextId = params.contextId
          entries = entries.filter(entry => entry.contextId === contextId)
        }
        let totalSize: number
        let pageTasks: A2aTask[]
        if (status === undefined && statusAfterMs === undefined) {
          totalSize = entries.length
          pageTasks = []
          for (const entry of entries.slice(offset, offset + pageSize)) {
            const task = await readTaskIfPresent(entry.taskId)
            if (task) pageTasks.push(task)
          }
        } else {
          // Status / timestamp filters must read each candidate task, so only
          // the LIST_TASKS_FILTER_CAP newest entries are considered.
          const matches: A2aTask[] = []
          for (const entry of entries.slice(0, LIST_TASKS_FILTER_CAP)) {
            const task = await readTaskIfPresent(entry.taskId)
            if (!task) continue
            if (status !== undefined && task.status.state !== status) continue
            if (statusAfterMs !== undefined) {
              const ts = task.status.timestamp === undefined ? NaN : Date.parse(task.status.timestamp)
              if (!Number.isFinite(ts) || ts <= statusAfterMs) continue
            }
            matches.push(task)
          }
          totalSize = matches.length
          pageTasks = matches.slice(offset, offset + pageSize)
        }
        const tasks = pageTasks.map(task => {
          const history =
            historyLength === undefined ? task.history : historyLength === 0 ? undefined : task.history?.slice(-historyLength)
          return {
            id: task.id,
            ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
            status: task.status,
            ...(includeArtifacts && task.artifacts !== undefined ? { artifacts: task.artifacts } : {}),
            ...(history !== undefined && history.length > 0 ? { history } : {}),
            ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
          }
        })
        send(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tasks,
            nextPageToken: offset + pageSize < totalSize ? encodePageToken(offset + pageSize) : "",
            pageSize,
            totalSize,
          },
        })
        return true
      }
      case "CreateTaskPushNotificationConfig": {
        // Params are the `TaskPushNotificationConfig` itself (A2A 1.0
        // §3.1.7): `{ taskId, url, token?, authentication?, id?, tenant? }`.
        const taskId = requireTaskIdParam()
        await requireTaskEntry(taskId)
        let config: A2aTaskPushNotificationConfig
        try {
          config = parseA2aTaskPushNotificationConfig(params, { taskId })
        } catch (err) {
          throw new RpcFailure(JSON_RPC_ERROR.invalidParams, err instanceof Error ? err.message : String(err))
        }
        await storePushConfig(config)
        await armPushDelivery(taskId)
        send(res, 200, { jsonrpc: "2.0", id, result: config })
        return true
      }
      case "GetTaskPushNotificationConfig": {
        const taskId = requireTaskIdParam()
        const configId = requireConfigIdParam()
        await requireTaskEntry(taskId)
        const config = await configs.get(appId, taskId, configId)
        if (!config) {
          throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `push notification config "${configId}" not found for task "${taskId}"`)
        }
        send(res, 200, { jsonrpc: "2.0", id, result: config })
        return true
      }
      case "ListTaskPushNotificationConfigs": {
        const taskId = requireTaskIdParam()
        await requireTaskEntry(taskId)
        let pageSize: number | undefined
        if (params.pageSize !== undefined) {
          if (typeof params.pageSize !== "number" || !Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 100) {
            throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageSize must be an integer between 1 and 100")
          }
          pageSize = params.pageSize
        }
        let offset = 0
        if (params.pageToken !== undefined) {
          if (typeof params.pageToken !== "string") throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageToken must be a string")
          const decoded = decodePageToken(params.pageToken)
          if (decoded === undefined) throw new RpcFailure(JSON_RPC_ERROR.invalidParams, "params.pageToken is not a valid page token")
          offset = decoded
        }
        const all = await configs.list(appId, taskId)
        const page = pageSize === undefined ? all : all.slice(offset, offset + pageSize)
        const nextPageToken =
          pageSize !== undefined && offset + pageSize < all.length ? encodePageToken(offset + pageSize) : ""
        send(res, 200, { jsonrpc: "2.0", id, result: { configs: page, nextPageToken } })
        return true
      }
      case "DeleteTaskPushNotificationConfig": {
        const taskId = requireTaskIdParam()
        const configId = requireConfigIdParam()
        await requireTaskEntry(taskId)
        const removed = await configs.delete(appId, taskId, configId)
        if (!removed) {
          throw new RpcFailure(JSON_RPC_ERROR.taskNotFound, `push notification config "${configId}" not found for task "${taskId}"`)
        }
        send(res, 200, { jsonrpc: "2.0", id, result: {} })
        return true
      }
      case "GetExtendedAgentCard":
        throw new RpcFailure(JSON_RPC_ERROR.extendedAgentCardNotConfigured, "this agent has no extended agent card")
      default:
        throw new RpcFailure(JSON_RPC_ERROR.methodNotFound, `method not found: ${method}`)
    }
  } catch (err) {
    const failure: JsonRpcResponse =
      err instanceof RpcFailure
        ? { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } }
        : { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERROR.internal, message: err instanceof Error ? err.message : String(err) } }
    // A failure after the SSE head is out can no longer be a JSON body — the
    // stream has already claimed the response, so just close it.
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
    } else {
      send(res, 200, failure)
    }
    return true
  }
}
