/**
 * A2A task ingress — `POST /a2a/apps/:appId` (a2a-task-http.ts). Drives the
 * real REST layer via `startHttpServer` over the A2A 1.0 wire shapes
 * (PascalCase methods, flat parts, enum-prefixed states); `app_run` / `app_status` /
 * `app_stop` / `app_artifact_get` and `workflow_run_file` / `workflow_status` /
 * `workflow_cancel` are faked behind `dispatchTool`, and the
 * manifest's `accepts` / `exposes` / bundled workflows come from an injected `loadHandle`.
 * `SendStreamingMessage` / `SubscribeToTask` stream the same run over SSE
 * (`text/event-stream`, one JSON-RPC response per event), polled at
 * `streamPollMs` so the fakes can move a run between two events.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { A2aPushDeps } from "../a2a-push.js"
import {
  createA2aTaskLedger,
  decodePageToken,
  encodePageToken,
  extractLastAssistantText,
  extractSkillRequest,
  mapRunState,
  mapWorkflowState,
  sessionTurnDone,
  sessionTurnFailed,
  type A2aAppHandleLike,
  type A2aTask,
  type A2aTaskPushNotificationConfig,
} from "../a2a-tasks.js"

const APP_ID = "@test/a2a-app"
const OTHER_APP_ID = "@test/closed-app"
const WF_PATH = "/apps/a2a-app/.agentproto/workflows/do-it/WORKFLOW.md"

const envelope = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
})

describe("A2A task ingress", () => {
  let dir: string
  let stateDir: string
  let appRegistry: AppRegistry
  let runs: Map<string, { status: string; sessions: unknown[]; error?: string }>
  let workflowRuns: Map<string, { status: string; output?: unknown; error?: string; endedAt?: string }>
  let dispatched: Array<{ name: string; args: Record<string, unknown> }>
  let handles: Record<string, A2aAppHandleLike>
  let conversations: Map<string, { role: string; text: string }[]>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a2a-task-app-"))
    stateDir = await mkdtemp(join(tmpdir(), "a2a-task-state-"))
    runs = new Map()
    workflowRuns = new Map()
    dispatched = []
    conversations = new Map()
    handles = {
      [APP_ID]: {
        accepts: { tasks: true },
        exposes: { agents: ["solo"], workflows: ["do-it"] },
        workflows: [{ id: "do-it", path: WF_PATH }],
      },
      [OTHER_APP_ID]: { exposes: { agents: ["solo"] } },
    }
    appRegistry = createAppRegistry()
    for (const appId of [APP_ID, OTHER_APP_ID]) {
      appRegistry.upsertApp({
        appId,
        dir: join(dir, appId === APP_ID ? "a" : "b"),
        agents: [{ id: "solo", path: join(dir, "AGENT.md") }],
        workflows: [],
        unvalidatedAgentTools: [],
        ...(appId === APP_ID
          ? { artifact: { path: join(dir, "artifact.html"), title: "Report", description: "the report" } }
          : {}),
      })
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  })

  const dispatchTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    dispatched.push({ name, args })
    if (name === "app_run") {
      if (args.agents && (args.agents as string[])[0] === "broken") return envelope({ appRunId: "run-x", sessions: [], errors: [{ agentId: "broken", error: "boom" }] })
      const appRunId = `run-${runs.size + 1}`
      runs.set(appRunId, { status: "running", sessions: [{ agentId: "solo", sessionId: `s-${appRunId}` }] })
      return envelope({ appRunId, sessions: [{ agentId: "solo", sessionId: `s-${appRunId}` }] })
    }
    if (name === "app_status") {
      const run = runs.get(args.appRunId as string)
      if (!run) return envelope(`app_status: no app run "${String(args.appRunId)}".`, true)
      const sessions =
        args.full === true
          ? run.sessions
          : run.sessions.map(s => {
              const sess = s as { agentId?: string; sessionId?: string }
              return { agentId: sess.agentId, sessionId: sess.sessionId, status: run.status }
            })
      return envelope({ appRunId: args.appRunId, appId: APP_ID, status: run.status, sessions, ...(run.error ? { error: run.error } : {}) })
    }
    if (name === "conversation_read") {
      const id = args.idOrName as string
      const messages = conversations.get(id)
      if (!messages) return envelope(`conversation_read: no conversation "${id}".`, true)
      return {
        content: [
          {
            type: "text",
            text: `${JSON.stringify({ meta: {}, messages })}\n\n---\n[window: messages 1–${messages.length} of ${messages.length}]`,
          },
        ],
      }
    }
    if (name === "app_stop") {
      runs.get(args.appRunId as string)!.status = "cancelled"
      return envelope({ appRunId: args.appRunId, killed: [], status: "cancelled" })
    }
    if (name === "app_artifact_get") {
      return envelope({ appId: APP_ID, title: "Report", description: "the report", html: "<h1>done</h1>" })
    }
    if (name === "workflow_run_file") {
      const runId = `wf-${workflowRuns.size + 1}`
      workflowRuns.set(runId, { status: "running" })
      return envelope({ runId, status: "running" })
    }
    if (name === "workflow_status") {
      const run = workflowRuns.get(args.runId as string)
      if (!run) return envelope({ error: "run not found", runId: args.runId })
      return envelope({
        runId: args.runId,
        workflowId: "do-it",
        status: run.status,
        startedAt: "2026-10-13T11:00:00.000Z",
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
      })
    }
    if (name === "workflow_cancel") {
      const run = workflowRuns.get(args.runId as string)
      if (run) run.status = "cancelled"
      return envelope({ runId: args.runId, status: run?.status ?? "not_found" })
    }
    throw new Error(`unexpected tool ${name}`)
  }

  async function withServer(
    fn: (
      rpc: (appId: string, body: unknown, raw?: boolean, opts?: { version?: string | null; query?: string }) => Promise<{
        status: number
        json: any
        headers: Headers
      }>,
      ctx: { port: number },
    ) => Promise<void>,
    streamConfig: { streamMaxMs?: number; push?: A2aPushDeps } = {},
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
      appToolCallDeps: { dispatchTool },
      a2aTasks: {
        stateDir,
        streamPollMs: 5,
        ...streamConfig,
        loadHandle: async d => handles[d.endsWith("/a") ? APP_ID : OTHER_APP_ID]!,
      },
    })
    const rpc = async (appId: string, body: unknown, raw = false, opts: { version?: string | null; query?: string } = {}) => {
      const version = opts.version === undefined ? "1.0" : opts.version
      const res = await fetch(`http://127.0.0.1:${port}/a2a/apps/${appId}${opts.query ?? ""}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(version ? { "a2a-version": version } : {}) },
        body: raw ? (body as string) : JSON.stringify(body),
      })
      return { status: res.status, json: await res.json(), headers: res.headers }
    }
    try {
      await fn(rpc, { port })
    } finally {
      await http.stop()
    }
  }

  const sendReq = (skill: string, text = "hello", id: number | string = 1) => ({
    jsonrpc: "2.0",
    id,
    method: "SendMessage",
    params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text }], metadata: { skill } } },
  })

  const streamReq = (skill: string, text = "hello", id: number | string = 1) => ({
    jsonrpc: "2.0",
    id,
    method: "SendStreamingMessage",
    params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text }], metadata: { skill } } },
  })

  it("SendMessage starts an app_run; GetTask walks working → completed with an artifact", async () => {
    await withServer(async rpc => {
      const sent = await rpc(APP_ID, sendReq("solo", "summarise this"))
      expect(sent.status).toBe(200)
      expect(Object.keys(sent.json.result)).toEqual(["task"])
      const task = sent.json.result.task as A2aTask
      expect(task).not.toHaveProperty("kind")
      expect(task.id).toBe("run-1")
      expect(task.status.state).toBe("TASK_STATE_WORKING")
      expect(task.contextId).toBeTruthy()
      expect(task.artifacts).toBeUndefined()
      expect(dispatched.find(d => d.name === "app_run")!.args).toEqual({ appId: APP_ID, agents: ["solo"], prompt: "summarise this" })

      runs.get("run-1")!.status = "succeeded"
      conversations.set("s-run-1", [
        { role: "user", text: "summarise this" },
        { role: "assistant", text: "All done." },
      ])
      const done = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const doneTask = done.json.result as A2aTask
      expect(doneTask.status.state).toBe("TASK_STATE_COMPLETED")
      expect(doneTask.contextId).toBe(task.contextId)
      // The agent's answer leads; the app's static HTML artifact follows it.
      expect(doneTask.artifacts).toHaveLength(2)
      expect(doneTask.artifacts![0]).toMatchObject({ artifactId: "agent-output-solo", name: "solo", parts: [{ text: "All done." }] })
      expect(doneTask.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "All done." }], taskId: "run-1" })
      expect(doneTask.status.message!.contextId).toBe(task.contextId)
      expect(doneTask.status.message).not.toHaveProperty("kind")
      const part = doneTask.artifacts![1]!.parts[0]!
      expect(part).toMatchObject({ mediaType: "text/html", filename: "Report.html" })
      expect(part).not.toHaveProperty("kind")
      expect(Buffer.from((part as { raw: string }).raw, "base64").toString()).toBe("<h1>done</h1>")

      runs.set("run-1", { status: "failed", sessions: [{}], error: "agent crashed" })
      const failed = (await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: "run-1" } })).json.result as A2aTask
      expect(failed.status.state).toBe("TASK_STATE_FAILED")
      expect(failed.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "agent crashed" }] })
      expect(failed.status.message).not.toHaveProperty("kind")
    })
  })

  it("GetTask completes when the session's turn ended (run still running) and returns the agent's answer", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "what is the answer"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1, lastTurnReason: "completed", outcome: { summary: "the summary" } },
          },
        ],
      })
      conversations.set("s-run-1", [
        { role: "user", text: "what is the answer" },
        { role: "assistant", text: "   " },
        { role: "assistant", text: "The answer is 42." },
      ])
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(task.artifacts![0]).toMatchObject({ artifactId: "agent-output-solo", name: "solo", parts: [{ text: "The answer is 42." }] })
      expect(task.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "The answer is 42." }], taskId: "run-1" })
    })
  })

  it("GetTask fails a still-running run whose session's turn ended in error, with the error message and no artifacts", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "do the thing"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: {
              status: "running",
              busy: false,
              awaitingInput: false,
              turnsCompleted: 1,
              lastTurnErroredAt: "2026-10-13T10:00:00.000Z",
              lastTurnErrorMessage: "boom",
            },
          },
        ],
      })
      // Even a readable conversation must not be fetched for a FAILED task.
      conversations.set("s-run-1", [{ role: "assistant", text: "partial" }])
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_FAILED")
      expect(task.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: expect.stringContaining("boom") }], taskId: "run-1" })
      expect(task.artifacts).toBeUndefined()
      expect(dispatched.some(d => d.name === "conversation_read")).toBe(false)
    })
  })

  it("GetTask completes a still-running run whose session ended with reason aborted", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "do the thing"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1, lastTurnReason: "aborted" },
          },
        ],
      })
      conversations.set("s-run-1", [{ role: "assistant", text: "stopped early" }])
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    })
  })

  it("GetTask stamps a turn-ended task with the latest session lastActivityAt", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "do the thing"))
      const later = "2030-01-02T03:04:05.000Z"
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1, lastActivityAt: later },
          },
        ],
      })
      conversations.set("s-run-1", [{ role: "assistant", text: "done" }])
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(task.status.timestamp).toBe(later)
    })
  })

  it("GetTask fails a still-running run when any session's turn ended in error", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "do the thing"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1, lastTurnReason: "completed" },
          },
          {
            agentId: "other",
            sessionId: "s-run-1b",
            descriptor: { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1, lastTurnErroredAt: "2026-10-13T10:00:00.000Z", lastTurnErrorMessage: "kaboom" },
          },
        ],
      })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_FAILED")
      expect(task.status.message!.parts[0]).toMatchObject({ text: expect.stringContaining("kaboom") })
      expect(task.artifacts).toBeUndefined()
    })
  })

  it("GetTask stays working while the session is busy, with no artifacts", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "keep going"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "running", busy: true, awaitingInput: false, turnsCompleted: 1 },
          },
        ],
      })
      conversations.set("s-run-1", [{ role: "assistant", text: "partial" }])
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_WORKING")
      expect(task.artifacts).toBeUndefined()
      expect(task.status.message).toBeUndefined()
    })
  })

  it("GetTask falls back to the descriptor outcome summary when conversation_read fails", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "summarise"))
      runs.set("run-1", {
        status: "running",
        sessions: [
          {
            agentId: "solo",
            sessionId: "s-run-1",
            descriptor: { status: "exited", turnsCompleted: 1, outcome: { summary: "the agent finished the job" } },
          },
        ],
      })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(task.artifacts![0]).toMatchObject({ artifactId: "agent-output-solo", parts: [{ text: "the agent finished the job" }] })
      expect(task.status.message).toMatchObject({ parts: [{ text: "the agent finished the job" }] })
      expect(dispatched.some(d => d.name === "conversation_read" && d.args.idOrName === "s-run-1")).toBe(true)
    })
  })

  it("accepts a `skill:` text prefix and the Agent Card `<appId>/<skill>` form", async () => {
    await withServer(async rpc => {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: `skill:${APP_ID}/solo do the thing` }] } },
      }
      const res = await rpc(APP_ID, body)
      expect(res.json.result.task.id).toBe("run-1")
      expect(dispatched.find(d => d.name === "app_run")!.args.prompt).toBe("do the thing")
    })
  })

  it("routes both the literal-slash and the URL-encoded appId spelling to the same app", async () => {
    await withServer(async rpc => {
      const literal = await rpc(APP_ID, sendReq("solo"))
      expect(literal.json.result.task.id).toBe("run-1")
      const encoded = await rpc(encodeURIComponent(APP_ID), sendReq("solo"))
      expect(encoded.json.result.task.id).toBe("run-2")
      expect(encoded.json.result.task.metadata.appId).toBe(APP_ID)
      // A task created under one spelling is readable through the other.
      const viaEncoded = await rpc(encodeURIComponent(APP_ID), { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: "run-1" } })
      expect(viaEncoded.json.result.id).toBe("run-1")
      const viaLiteral = await rpc(APP_ID, { jsonrpc: "2.0", id: 4, method: "GetTask", params: { id: "run-2" } })
      expect(viaLiteral.json.result.id).toBe("run-2")
      // Lowercase percent-hex decodes the same way.
      const lower = await rpc("%40test%2fa2a-app", sendReq("solo"))
      expect(lower.json.result).toBeDefined()
      const bad = await rpc("%E0%A4%A", sendReq("solo"))
      expect(bad.status).toBe(400)
    })
  })

  it("persists the task ledger so GetTask survives a restart", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo"))
    })
    const ledger = await readFile(join(stateDir, "a2a-tasks", `${encodeURIComponent(APP_ID)}.jsonl`), "utf8")
    expect(JSON.parse(ledger.trim())).toMatchObject({ taskId: "run-1", appId: APP_ID, skill: "solo" })
    await withServer(async rpc => {
      runs.set("run-1", { status: "succeeded", sessions: [{}] })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "run-1" } })
      expect(res.json.result.status.state).toBe("TASK_STATE_COMPLETED")
    })
  })

  it("refuses SendMessage when the app does not declare accepts.tasks", async () => {
    await withServer(async rpc => {
      const res = await rpc(OTHER_APP_ID, sendReq("solo"))
      expect(res.json.error.code).toBe(-32004)
      expect(res.json.error.message).toContain("accepts.tasks")
      handles[OTHER_APP_ID] = {}
      expect((await rpc(OTHER_APP_ID, sendReq("solo"))).json.error.code).toBe(-32004)
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)
    })
  })

  it("rejects a missing or unknown skill", async () => {
    await withServer(async rpc => {
      const none = await rpc(APP_ID, { ...sendReq("solo"), params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } } })
      expect(none.json.error.code).toBe(-32602)
      const unknown = await rpc(APP_ID, sendReq("ghost"))
      expect(unknown.json.error.code).toBe(-32602)
      expect(unknown.json.error.message).toContain("ghost")
      const legacyRole = await rpc(APP_ID, { ...sendReq("solo"), params: { message: { role: "user", parts: [{ text: "hi" }], metadata: { skill: "solo" } } } })
      expect(legacyRole.json.error.code).toBe(-32602)
      const legacyPart = await rpc(APP_ID, { ...sendReq("solo"), params: { message: { role: "ROLE_USER", parts: [{ kind: "text", body: "hi" }], metadata: { skill: "solo" } } } })
      expect(legacyPart.json.error.code).toBe(-32602)
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)
    })
  })

  it("surfaces an agent that failed to start without creating a task", async () => {
    handles[APP_ID] = { accepts: { tasks: true }, exposes: { agents: ["broken"] } }
    await withServer(async rpc => {
      const res = await rpc(APP_ID, sendReq("broken"))
      expect(res.json.error.code).toBe(-32603)
      expect(res.json.error.message).toContain("boom")
    })
  })

  it("GetTask on an unknown id, or an id from another app, is TaskNotFound", async () => {
    await withServer(async rpc => {
      const unknown = await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "nope" } })
      expect(unknown.json.error.code).toBe(-32001)
      await rpc(APP_ID, sendReq("solo"))
      const crossApp = await rpc(OTHER_APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "run-1" } })
      expect(crossApp.json.error.code).toBe(-32001)
    })
  })

  it("CancelTask stops the run; a finished task is not cancelable", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo"))
      const cancel = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "run-1" } })
      expect(cancel.json.result.status.state).toBe("TASK_STATE_CANCELED")
      expect(cancel.json.result).not.toHaveProperty("task")
      expect(dispatched.find(d => d.name === "app_stop")!.args).toEqual({ appRunId: "run-1" })
      const again = await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "CancelTask", params: { id: "run-1" } })
      expect(again.json.error.code).toBe(-32002)
      const missing = await rpc(APP_ID, { jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: "nope" } })
      expect(missing.json.error.code).toBe(-32001)
    })
  })

  const listReq = (params: Record<string, unknown> = {}, id: number | string = 1) => ({
    jsonrpc: "2.0",
    id,
    method: "ListTasks",
    params,
  })

  const sendWithContext = (contextId: string, id: number | string = 1) => ({
    jsonrpc: "2.0",
    id,
    method: "SendMessage",
    params: {
      message: {
        messageId: `m-${id}`,
        role: "ROLE_USER",
        contextId,
        parts: [{ text: "hello" }],
        metadata: { skill: "solo" },
      },
    },
  })

  it("ListTasks returns every task newest first with empty nextPageToken", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "one"))
      await rpc(APP_ID, sendReq("solo", "two"))
      await rpc(APP_ID, sendReq("solo", "three"))
      const res = await rpc(APP_ID, listReq())
      expect(res.json.error).toBeUndefined()
      expect(res.json.result.totalSize).toBe(3)
      expect(res.json.result.pageSize).toBe(50)
      expect(res.json.result.nextPageToken).toBe("")
      const tasks = res.json.result.tasks as A2aTask[]
      expect(tasks.map(t => t.id)).toEqual(["run-3", "run-2", "run-1"])
      expect(tasks.every(t => t.status.state === "TASK_STATE_WORKING")).toBe(true)
    })
  })

  it("ListTasks pages with pageSize and the returned pageToken", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "one"))
      await rpc(APP_ID, sendReq("solo", "two"))
      await rpc(APP_ID, sendReq("solo", "three"))
      const first = await rpc(APP_ID, listReq({ pageSize: 2 }))
      expect((first.json.result.tasks as A2aTask[]).map(t => t.id)).toEqual(["run-3", "run-2"])
      expect(first.json.result.totalSize).toBe(3)
      expect(first.json.result.pageSize).toBe(2)
      expect(first.json.result.nextPageToken).toBeTruthy()
      const second = await rpc(APP_ID, listReq({ pageSize: 2, pageToken: first.json.result.nextPageToken }))
      expect((second.json.result.tasks as A2aTask[]).map(t => t.id)).toEqual(["run-1"])
      expect(second.json.result.nextPageToken).toBe("")
    })
  })

  it("ListTasks filters by contextId", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendWithContext("ctx-a", 1))
      await rpc(APP_ID, sendWithContext("ctx-a", 2))
      await rpc(APP_ID, sendWithContext("ctx-b", 3))
      const res = await rpc(APP_ID, listReq({ contextId: "ctx-a" }))
      expect(res.json.result.totalSize).toBe(2)
      expect((res.json.result.tasks as A2aTask[]).map(t => t.id).sort()).toEqual(["run-1", "run-2"])
      expect((res.json.result.tasks as A2aTask[]).every(t => t.contextId === "ctx-a")).toBe(true)
    })
  })

  it("ListTasks filters by status, reading each candidate task", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "done one"))
      await rpc(APP_ID, sendReq("solo", "still going"))
      runs.set("run-1", { status: "succeeded", sessions: [{ agentId: "solo", sessionId: "s-run-1" }] })
      conversations.set("s-run-1", [{ role: "assistant", text: "All done." }])
      const completed = await rpc(APP_ID, listReq({ status: "TASK_STATE_COMPLETED" }))
      expect(completed.json.result.totalSize).toBe(1)
      expect((completed.json.result.tasks as A2aTask[]).map(t => t.id)).toEqual(["run-1"])
      expect(completed.json.result.tasks[0].status.state).toBe("TASK_STATE_COMPLETED")
      const working = await rpc(APP_ID, listReq({ status: "TASK_STATE_WORKING" }))
      expect(working.json.result.totalSize).toBe(1)
      expect((working.json.result.tasks as A2aTask[]).map(t => t.id)).toEqual(["run-2"])
    })
  })

  it("ListTasks drops artifacts by default and keeps them with includeArtifacts", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "make a report"))
      runs.set("run-1", { status: "succeeded", sessions: [{ agentId: "solo", sessionId: "s-run-1" }] })
      conversations.set("s-run-1", [{ role: "assistant", text: "Report ready." }])
      const slim = await rpc(APP_ID, listReq())
      expect(slim.json.result.tasks[0].artifacts).toBeUndefined()
      const full = await rpc(APP_ID, listReq({ includeArtifacts: true }))
      expect(full.json.result.tasks[0].artifacts).toHaveLength(2)
      expect(full.json.result.tasks[0].artifacts[0]).toMatchObject({ artifactId: "agent-output-solo" })
    })
  })

  it("ListTasks skips a task whose backing run is gone", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo", "one"))
      await rpc(APP_ID, sendReq("solo", "two"))
      await rpc(APP_ID, sendReq("solo", "three"))
      runs.delete("run-2")
      const res = await rpc(APP_ID, listReq())
      expect(res.json.error).toBeUndefined()
      expect((res.json.result.tasks as A2aTask[]).map(t => t.id)).toEqual(["run-3", "run-1"])
      expect(res.json.result.totalSize).toBe(3)
    })
  })

  it("ListTasks rejects an out-of-range pageSize or a garbage pageToken", async () => {
    await withServer(async rpc => {
      for (const params of [{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { pageToken: "!!not-a-token!!" }]) {
        const res = await rpc(APP_ID, listReq(params))
        expect(res.json.error.code).toBe(-32602)
      }
      expect(dispatched).toHaveLength(0)
    })
  })

  it("SendMessage starts an exposed workflow skill through workflow_run_file", async () => {
    await withServer(async rpc => {
      const sent = await rpc(APP_ID, sendReq("do-it", "compile the report"))
      expect(sent.status).toBe(200)
      const task = sent.json.result.task as A2aTask
      expect(task.id).toBe("wf-1")
      expect(task.status.state).toBe("TASK_STATE_WORKING")
      expect(task.metadata).toMatchObject({ appId: APP_ID, skill: "do-it" })
      expect(task.contextId).toBeTruthy()
      expect(task.artifacts).toBeUndefined()
      const start = dispatched.find(d => d.name === "workflow_run_file")!
      expect(start.args).toEqual({ path: WF_PATH, input: { prompt: "compile the report" }, appId: APP_ID })
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)
      const ledger = await readFile(join(stateDir, "a2a-tasks", `${encodeURIComponent(APP_ID)}.jsonl`), "utf8")
      expect(JSON.parse(ledger.trim())).toMatchObject({ taskId: "wf-1", appId: APP_ID, skill: "do-it", kind: "workflow" })
      // The task is the workflow run, readable through GetTask.
      const polled = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "wf-1" } })
      expect(polled.json.result.id).toBe("wf-1")
      expect(polled.json.result.status.state).toBe("TASK_STATE_WORKING")
    })
  })

  it("passes the message's data part through as the workflow input, as is", async () => {
    await withServer(async rpc => {
      const payload = { report: "october", filters: { region: "emea" } }
      const res = await rpc(APP_ID, {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: "m1",
            role: "ROLE_USER",
            parts: [{ data: payload }, { text: "text rides along but never becomes the input" }],
            metadata: { skill: "do-it" },
          },
        },
      })
      expect(res.json.result.task.id).toBe("wf-1")
      const start = dispatched.find(d => d.name === "workflow_run_file")!
      expect(start.args.input).toEqual(payload)
      expect(start.args.path).toBe(WF_PATH)
    })
  })

  it("GetTask on a done workflow run is Completed with the output artifact", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("do-it", "go"))
      workflowRuns.set("wf-1", { status: "done", output: { total: 42 }, endedAt: "2026-10-13T12:00:00.000Z" })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "wf-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(task.status.timestamp).toBe("2026-10-13T12:00:00.000Z")
      expect(task.artifacts).toHaveLength(1)
      expect(task.artifacts![0]).toMatchObject({ artifactId: "output", name: "output", parts: [{ data: { total: 42 } }] })
      expect(task.artifacts![0]!.parts[0]).not.toHaveProperty("kind")
      expect(task.artifacts![0]!.parts[0]).not.toHaveProperty("text")
      expect(dispatched.some(d => d.name === "app_status" || d.name === "conversation_read")).toBe(false)
    })
  })

  it("GetTask on a failed workflow run is Failed with the error and no artifacts", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("do-it", "go"))
      workflowRuns.set("wf-1", { status: "failed", error: "step 2 exploded", endedAt: "2026-10-13T12:05:00.000Z" })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "wf-1" } })
      const task = res.json.result as A2aTask
      expect(task.status.state).toBe("TASK_STATE_FAILED")
      expect(task.status.message).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "step 2 exploded" }], taskId: "wf-1" })
      expect(task.status.timestamp).toBe("2026-10-13T12:05:00.000Z")
      expect(task.artifacts).toBeUndefined()
    })
  })

  it("CancelTask cancels a running workflow task through workflow_cancel, not app_stop", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("do-it", "go"))
      const cancel = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "wf-1" } })
      expect(cancel.json.result.status.state).toBe("TASK_STATE_CANCELED")
      expect(dispatched.find(d => d.name === "workflow_cancel")!.args).toEqual({ runId: "wf-1" })
      expect(dispatched.some(d => d.name === "app_stop")).toBe(false)
      const again = await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "CancelTask", params: { id: "wf-1" } })
      expect(again.json.error.code).toBe(-32002)
    })
  })

  it("rejects an exposed workflow the app does not bundle", async () => {
    handles[APP_ID] = { accepts: { tasks: true }, exposes: { agents: ["solo"], workflows: ["do-it"] } }
    await withServer(async rpc => {
      const res = await rpc(APP_ID, sendReq("do-it"))
      expect(res.json.error.code).toBe(-32004)
      expect(res.json.error.message).toContain("do-it")
      expect(res.json.error.message).toContain("does not bundle it")
      expect(dispatched).toHaveLength(0)
    })
  })

  it("answers protocol errors: parse, invalid request, unknown/0.3 methods, bare streaming params, push, unknown app", async () => {
    await withServer(async rpc => {
      expect((await rpc(APP_ID, "{not json", true)).json.error.code).toBe(-32700)
      expect((await rpc(APP_ID, [sendReq("solo")])).json.error.code).toBe(-32600)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "Nope" })).json.error.code).toBe(-32601)
      // The 0.3 method names are gone.
      for (const legacy of ["message/send", "tasks/get", "tasks/cancel"]) {
        expect((await rpc(APP_ID, { ...sendReq("solo"), method: legacy })).json.error.code).toBe(-32601)
      }
      // The streaming methods and ListTasks are live — a bare streaming call
      // (no message, no id) is invalid params, not "unsupported".
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "SendStreamingMessage" })).json.error.code).toBe(-32602)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "SubscribeToTask" })).json.error.code).toBe(-32602)
      // The push-config methods are live: a bare call is invalid params
      // (no taskId), not "unsupported".
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "CreateTaskPushNotificationConfig" })).json.error.code).toBe(-32602)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "GetExtendedAgentCard" })).json.error.code).toBe(-32007)
      expect(dispatched).toHaveLength(0)
      const ghost = await rpc("@test/ghost", sendReq("solo"))
      expect(ghost.status).toBe(404)
      expect(ghost.json.error.message).toContain("no installed app")
    })
  })

  it("serves 1.0 from the A2A-Version header or ?version=, header first, and by default when neither is sent", async () => {
    await withServer(async rpc => {
      expect((await rpc(APP_ID, sendReq("solo"), false, { version: "1.0" })).json.result.task.id).toBe("run-1")
      expect((await rpc(APP_ID, sendReq("solo"), false, { version: null, query: "?version=1.0" })).json.result.task.id).toBe("run-2")
      expect((await rpc(APP_ID, sendReq("solo"), false, { version: "1.0", query: "?version=0.3" })).json.result.task.id).toBe("run-3")
      expect((await rpc(APP_ID, sendReq("solo"), false, { version: null })).json.result.task.id).toBe("run-4")
    })
  })

  it("answers VersionNotSupported (-32009) for an explicit 0.3 or unknown version", async () => {
    await withServer(async rpc => {
      for (const opts of [{ version: "0.3" }, { version: "2.0" }, { version: null, query: "?version=0.3" }]) {
        const res = await rpc(APP_ID, sendReq("solo"), false, opts)
        expect(res.json.error.code).toBe(-32009)
        expect(res.json.error.data).toEqual({ supportedVersions: ["1.0"] })
      }
      expect(dispatched).toHaveLength(0)
    })
  })

  it("SendStreamingMessage streams an agent skill: {task} first, artifactUpdates, then a final statusUpdate", async () => {
    await withServer(async (_rpc, { port }) => {
      const res = await openStream(port, APP_ID, streamReq("solo", "summarise this"))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(res.headers.get("cache-control")).toContain("no-cache")
      expect(res.headers.get("connection")).toBe("keep-alive")
      const events = sseEvents(res)
      const first = await events.next()
      expect(first.done).toBe(false)
      expect(first.value!.result.task).toMatchObject({ id: "run-1", status: { state: "TASK_STATE_WORKING" } })
      expect(first.value!.result.task.contextId).toBeTruthy()
      expect(dispatched.find(d => d.name === "app_run")!.args).toEqual({ appId: APP_ID, agents: ["solo"], prompt: "summarise this" })

      // The run finishes between two polls.
      runs.get("run-1")!.status = "succeeded"
      conversations.set("s-run-1", [
        { role: "user", text: "summarise this" },
        { role: "assistant", text: "All done." },
      ])
      const rest: SseEvent[] = []
      for await (const ev of events) rest.push(ev)

      const finalIdx = rest.findIndex(ev => ev.result?.statusUpdate?.final === true)
      expect(finalIdx).toBeGreaterThanOrEqual(0)
      // The final statusUpdate is the stream's last event.
      expect(rest).toHaveLength(finalIdx + 1)
      expect(rest.slice(0, finalIdx).every(ev => ev.result?.artifactUpdate)).toBe(true)
      expect(rest.slice(0, finalIdx).map(ev => ev.result.artifactUpdate.artifact.artifactId)).toEqual([
        "agent-output-solo",
        "app-artifact",
      ])
      for (const ev of rest.slice(0, finalIdx)) expect(ev.result.artifactUpdate.lastChunk).toBe(true)
      expect(rest[finalIdx]!.result.statusUpdate).toMatchObject({
        taskId: "run-1",
        status: { state: "TASK_STATE_COMPLETED" },
        final: true,
      })
      expect(rest[finalIdx]!.result.statusUpdate.status.message).toMatchObject({
        role: "ROLE_AGENT",
        parts: [{ text: "All done." }],
      })
      for (const ev of [first.value!, ...rest]) {
        expect(ev.jsonrpc).toBe("2.0")
        expect(ev.id).toBe(1)
      }
    })
  })

  it("SendStreamingMessage streams a workflow skill to its output artifact", async () => {
    await withServer(async (_rpc, { port }) => {
      const res = await openStream(port, APP_ID, streamReq("do-it", "compile the report"))
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = sseEvents(res)
      const first = await events.next()
      expect(first.value!.result.task).toMatchObject({ id: "wf-1", status: { state: "TASK_STATE_WORKING" } })
      expect(dispatched.some(d => d.name === "workflow_run_file")).toBe(true)
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)

      workflowRuns.set("wf-1", { status: "done", output: { total: 42 }, endedAt: "2026-10-13T12:00:00.000Z" })
      const rest: SseEvent[] = []
      for await (const ev of events) rest.push(ev)

      expect(rest).toHaveLength(2)
      expect(rest[0]!.result.artifactUpdate).toMatchObject({
        taskId: "wf-1",
        lastChunk: true,
        artifact: { artifactId: "output", name: "output", parts: [{ data: { total: 42 } }] },
      })
      expect(rest[0]!.result.artifactUpdate.artifact.parts[0]).not.toHaveProperty("kind")
      expect(rest[1]!.result.statusUpdate).toMatchObject({
        taskId: "wf-1",
        status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-10-13T12:00:00.000Z" },
        final: true,
      })
    })
  })

  it("SubscribeToTask streams a running task until it reaches a terminal state", async () => {
    await withServer(async (rpc, { port }) => {
      const sent = await rpc(APP_ID, sendReq("solo", "keep going"))
      const taskId = sent.json.result.task.id as string
      const res = await openStream(port, APP_ID, { jsonrpc: "2.0", id: 7, method: "SubscribeToTask", params: { id: taskId } })
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = sseEvents(res)
      const first = await events.next()
      expect(first.value!.result.task).toMatchObject({ id: taskId, status: { state: "TASK_STATE_WORKING" } })

      runs.get(taskId)!.status = "failed"
      runs.get(taskId)!.error = "agent crashed"
      const rest: SseEvent[] = []
      for await (const ev of events) rest.push(ev)

      expect(rest).toHaveLength(1)
      expect(rest[0]!.id).toBe(7)
      expect(rest[0]!.result.statusUpdate).toMatchObject({
        taskId,
        status: { state: "TASK_STATE_FAILED" },
        final: true,
      })
      expect(rest[0]!.result.statusUpdate.status.message).toMatchObject({ parts: [{ text: "agent crashed" }] })
      // One run only: the subscribe never started a second one.
      expect(dispatched.filter(d => d.name === "app_run")).toHaveLength(1)
    })
  })

  it("SubscribeToTask on a finished task answers a JSON-RPC error, not a stream", async () => {
    await withServer(async (rpc, { port }) => {
      await rpc(APP_ID, sendReq("solo"))
      runs.get("run-1")!.status = "succeeded"
      conversations.set("s-run-1", [{ role: "assistant", text: "already done" }])
      const res = await openStream(port, APP_ID, { jsonrpc: "2.0", id: 2, method: "SubscribeToTask", params: { id: "run-1" } })
      expect(res.headers.get("content-type")).toContain("application/json")
      const json = (await res.json()) as { error: { code: number; message: string } }
      expect(json.error).toEqual({ code: -32004, message: "task is already TASK_STATE_COMPLETED" })
    })
  })

  it("SubscribeToTask on an unknown id is TaskNotFound, as JSON", async () => {
    await withServer(async (_rpc, { port }) => {
      const res = await openStream(port, APP_ID, { jsonrpc: "2.0", id: 3, method: "SubscribeToTask", params: { id: "nope" } })
      expect(res.headers.get("content-type")).toContain("application/json")
      const json = (await res.json()) as { error: { code: number; message: string } }
      expect(json.error.code).toBe(-32001)
      expect(json.error.message).toContain("nope")
      expect(dispatched).toHaveLength(0)
    })
  })

  it("stops polling the task once the client disconnects", async () => {
    await withServer(async (_rpc, { port }) => {
      const controller = new AbortController()
      const res = await openStream(port, APP_ID, streamReq("solo", "long job"), { signal: controller.signal })
      const events = sseEvents(res)
      const first = await events.next()
      expect(first.value!.result.task.status.state).toBe("TASK_STATE_WORKING")
      const polls = () => dispatched.filter(d => d.name === "app_status").length
      await sleep(40) // several polls at streamPollMs: 5
      expect(polls()).toBeGreaterThan(1)
      controller.abort()
      await events.return(undefined)
      await sleep(80)
      const stopped = polls()
      await sleep(60)
      expect(polls()).toBe(stopped)
      expect(runs.get("run-1")!.status).toBe("running")
    })
  })

  it("SendStreamingMessage validation failures answer JSON, not a stream", async () => {
    await withServer(async (_rpc, { port }) => {
      const noSkill = await openStream(port, APP_ID, {
        jsonrpc: "2.0",
        id: 1,
        method: "SendStreamingMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
      })
      expect(noSkill.headers.get("content-type")).toContain("application/json")
      expect((await noSkill.json() as { error: { code: number } }).error.code).toBe(-32602)

      const noAccepts = await openStream(port, OTHER_APP_ID, streamReq("solo"))
      expect(noAccepts.headers.get("content-type")).toContain("application/json")
      const json = (await noAccepts.json()) as { error: { code: number; message: string } }
      expect(json.error.code).toBe(-32004)
      expect(json.error.message).toContain("accepts.tasks")
      expect(dispatched).toHaveLength(0)
    })
  })

  it("ends the stream at streamMaxMs with the state the task is actually in", async () => {
    await withServer(
      async (_rpc, { port }) => {
        const res = await openStream(port, APP_ID, streamReq("solo", "slow job"))
        const events = sseEvents(res)
        const first = await events.next()
        expect(first.value!.result.task.status.state).toBe("TASK_STATE_WORKING")
        const rest: SseEvent[] = []
        for await (const ev of events) rest.push(ev)
        expect(rest).toHaveLength(1)
        expect(rest[0]!.result.statusUpdate).toMatchObject({
          taskId: "run-1",
          status: { state: "TASK_STATE_WORKING" },
        })
        // The cap is not a terminal state: no `final` claim.
        expect(rest[0]!.result.statusUpdate).not.toHaveProperty("final")
      },
      { streamMaxMs: 30 },
    )
  })

  const pushCreateReq = (taskId: string, url: string, id: number | string = 1, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id,
    method: "CreateTaskPushNotificationConfig",
    params: { taskId, url, ...extra },
  })

  it("push config methods round trip: create → get → list → delete, and get after delete is TaskNotFound", async () => {
    const seen: string[] = []
    await withServer(
      async rpc => {
        await rpc(APP_ID, sendReq("solo"))
      const created = await rpc(APP_ID, pushCreateReq("run-1", "https://example.com/hook", 1, { token: "tok-1" }))
      expect(created.json.error).toBeUndefined()
      const config = created.json.result as A2aTaskPushNotificationConfig
      expect(config).toMatchObject({ taskId: "run-1", url: "https://example.com/hook", token: "tok-1" })
      expect(typeof config.id).toBe("string")
      expect(config.id).not.toBe("")

      const got = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTaskPushNotificationConfig", params: { taskId: "run-1", id: config.id } })
      expect(got.json.result).toEqual(config)

      const listed = await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "ListTaskPushNotificationConfigs", params: { taskId: "run-1" } })
      expect(listed.json.result.configs).toEqual([config])
      expect(listed.json.result.nextPageToken).toBe("")

      const deleted = await rpc(APP_ID, { jsonrpc: "2.0", id: 4, method: "DeleteTaskPushNotificationConfig", params: { taskId: "run-1", id: config.id } })
      expect(deleted.json.result).toEqual({})
      const gone = await rpc(APP_ID, { jsonrpc: "2.0", id: 5, method: "GetTaskPushNotificationConfig", params: { taskId: "run-1", id: config.id } })
      expect(gone.json.error.code).toBe(-32001)

      // The store is on disk beside the ledger, one JSON file per app.
      const onDisk = JSON.parse(await readFile(join(stateDir, "a2a-tasks", `${encodeURIComponent(APP_ID)}.push.json`), "utf8"))
      expect(onDisk).toEqual({})
      // Let the watcher this test armed (the create was on a live task) end.
      runs.get("run-1")!.status = "succeeded"
      conversations.set("s-run-1", [{ role: "assistant", text: "done" }])
      await sleep(40)
      },
      { push: { fetchImpl: (async (input: Parameters<typeof fetch>[0]) => { seen.push(String(input)); return new Response(null, { status: 200 }) }) as typeof fetch, pollMs: 2, retryDelaysMs: [0, 0] } },
    )
  })

  it("push config methods reject unknown tasks, bad urls, and an 11th config", async () => {
    const seen: string[] = []
    await withServer(
      async rpc => {
        await rpc(APP_ID, sendReq("solo"))
        const unknown = await rpc(APP_ID, pushCreateReq("nope", "https://example.com/hook"))
        expect(unknown.json.error.code).toBe(-32001)
        const unknownGet = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "GetTaskPushNotificationConfig", params: { taskId: "nope", id: "x" } })
        expect(unknownGet.json.error.code).toBe(-32001)
        for (const [i, url] of ["ftp://example.com/hook", "http://example.com/hook", "https://user:pass@example.com/hook", "not-a-url"].entries()) {
          const res = await rpc(APP_ID, pushCreateReq("run-1", url, 10 + i))
          expect(res.json.error.code).toBe(-32602)
          expect(res.json.error.message).toContain("url")
        }
        for (let i = 0; i < 10; i++) {
          const res = await rpc(APP_ID, pushCreateReq("run-1", `https://example.com/hook/${i}`, 100 + i))
          expect(res.json.error).toBeUndefined()
        }
        const eleventh = await rpc(APP_ID, pushCreateReq("run-1", "https://example.com/hook/11", 200))
        expect(eleventh.json.error.code).toBe(-32602)
        expect(eleventh.json.error.message).toContain("10")
        const listed = await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "ListTaskPushNotificationConfigs", params: { taskId: "run-1" } })
        expect(listed.json.result.configs).toHaveLength(10)
        // The failed creates stored nothing beyond the ten.
        expect(listed.json.result.configs.map((c: A2aTaskPushNotificationConfig) => c.url)).toEqual(
          Array.from({ length: 10 }, (_, i) => `https://example.com/hook/${i}`),
        )
        expect(seen).toEqual([])
        // End the watcher the ten creates armed.
        runs.get("run-1")!.status = "failed"
        runs.get("run-1")!.error = "stop"
        await sleep(40)
      },
      { push: { fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { seen.push(String(input)); return new Response(null, { status: 200 }) }) as typeof fetch } },
    )
  })

  it("SendMessage with configuration.pushNotificationConfig stores the config and delivers updates in order", async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      posts.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? "{}")),
      })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    await withServer(
      async rpc => {
        const sent = await rpc(APP_ID, {
          ...sendReq("solo", "long job"),
          params: {
            message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "long job" }], metadata: { skill: "solo" } },
            configuration: {
              pushNotificationConfig: {
                url: "https://example.com/hook",
                token: "tok-1",
                authentication: { scheme: "Bearer", credentials: "cred-1" },
              },
            },
          },
        })
        expect(sent.json.result.task.id).toBe("run-1")
        const listed = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "ListTaskPushNotificationConfigs", params: { taskId: "run-1" } })
        expect(listed.json.result.configs).toHaveLength(1)
        expect(listed.json.result.configs[0]).toMatchObject({ taskId: "run-1", url: "https://example.com/hook", token: "tok-1" })

        runs.get("run-1")!.status = "succeeded"
        conversations.set("s-run-1", [{ role: "assistant", text: "All done." }])
        await waitFor(() => posts.some(p => p.body?.statusUpdate?.final === true), "final push delivery")
        const kinds = posts.map(p => (p.body.artifactUpdate ? "artifactUpdate" : p.body.statusUpdate?.final === true ? "final" : "other"))
        expect(kinds).toEqual(["artifactUpdate", "artifactUpdate", "final"])
        expect(posts[0]!.body.artifactUpdate.artifact.artifactId).toBe("agent-output-solo")
        expect(posts[1]!.body.artifactUpdate.artifact.artifactId).toBe("app-artifact")
        expect(posts[2]!.body.statusUpdate).toMatchObject({
          taskId: "run-1",
          status: { state: "TASK_STATE_COMPLETED" },
          final: true,
        })
        for (const post of posts) {
          expect(post.url).toBe("https://example.com/hook")
          expect(post.headers["content-type"]).toBe("application/json")
          expect(post.headers["x-a2a-notification-token"]).toBe("tok-1")
          expect(post.headers.authorization).toBe("Bearer cred-1")
        }
      },
      { push: { fetchImpl, pollMs: 2, retryDelaysMs: [0, 0] } },
    )
  })

  it("SendMessage with the spec's configuration.taskPushNotificationConfig spelling works too", async () => {
    await withServer(
      async rpc => {
        const sent = await rpc(APP_ID, {
          ...sendReq("solo"),
          params: {
            message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], metadata: { skill: "solo" } },
            configuration: { taskPushNotificationConfig: { url: "https://example.com/spec-hook" } },
          },
        })
        expect(sent.json.result.task.id).toBe("run-1")
        const listed = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "ListTaskPushNotificationConfigs", params: { taskId: "run-1" } })
        expect(listed.json.result.configs[0]).toMatchObject({ url: "https://example.com/spec-hook" })
        runs.get("run-1")!.status = "succeeded"
        conversations.set("s-run-1", [{ role: "assistant", text: "done" }])
        await sleep(40)
      },
      { push: { fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch, pollMs: 2 } },
    )
  })

  it("SendMessage with a bad push config url is invalid params and starts no run", async () => {
    await withServer(async rpc => {
      const res = await rpc(APP_ID, {
        ...sendReq("solo"),
        params: {
          message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], metadata: { skill: "solo" } },
          configuration: { pushNotificationConfig: { url: "http://example.com/hook" } },
        },
      })
      expect(res.json.error.code).toBe(-32602)
      expect(res.json.error.message).toContain("must be https")
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)
    })
  })

  it("a config created on a completed task gets one final statusUpdate and no watcher", async () => {
    const posts: Array<{ body: any }> = []
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    await withServer(
      async rpc => {
        await rpc(APP_ID, sendReq("solo"))
        runs.get("run-1")!.status = "succeeded"
        conversations.set("s-run-1", [{ role: "assistant", text: "already done" }])
        const created = await rpc(APP_ID, pushCreateReq("run-1", "https://example.com/hook", 1, { token: "tok" }))
        expect(created.json.error).toBeUndefined()
        await waitFor(() => posts.length === 1, "the final push")
        expect(posts[0]!.body).toMatchObject({
          statusUpdate: { taskId: "run-1", status: { state: "TASK_STATE_COMPLETED" }, final: true },
        })
        // No watcher: nothing else is ever delivered.
        await sleep(40)
        expect(posts).toHaveLength(1)
      },
      { push: { fetchImpl, pollMs: 2 } },
    )
  })

})

describe("a2a task ledger", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a2a-ledger-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const entry = (taskId: string, createdAt: string, appId = "@t/app") => ({
    taskId,
    appId,
    contextId: "ctx",
    skill: "solo",
    createdAt,
  })

  it("list returns every entry newest first, ties by file order reversed, torn lines and other apps skipped", async () => {
    const ledger = createA2aTaskLedger(dir)
    await ledger.append(entry("t1", "2026-10-13T10:00:00.000Z"))
    await ledger.append(entry("t2", "2026-10-13T12:00:00.000Z"))
    await ledger.append(entry("t3", "2026-10-13T11:00:00.000Z"))
    // A torn line from a crash mid-append: partial JSON, not parseable.
    await appendFile(join(dir, `${encodeURIComponent("@t/app")}.jsonl`), '{"taskId":"torn","appId":"@t/app"\n', "utf8")
    // Another app's ledger file must not leak into this app's list.
    await ledger.append(entry("other-1", "2026-10-13T13:00:00.000Z", "@t/other"))
    await ledger.append(entry("t4", "2026-10-13T11:00:00.000Z"))
    // A duplicate taskId is kept once, first write wins.
    await ledger.append(entry("t1", "2026-10-13T23:00:00.000Z"))
    const listed = await ledger.list("@t/app")
    expect(listed.map(e => e.taskId)).toEqual(["t2", "t4", "t3", "t1"])
    expect(listed.find(e => e.taskId === "t1")!.createdAt).toBe("2026-10-13T10:00:00.000Z")
    expect(await ledger.list("@t/none")).toEqual([])
  })

  it("append after a torn trailing line closes it so the new entry survives", async () => {
    const ledger = createA2aTaskLedger(dir)
    await ledger.append(entry("t1", "2026-10-13T10:00:00.000Z"))
    // A torn trailing line from a crash mid-append: partial JSON, no newline.
    await appendFile(join(dir, `${encodeURIComponent("@t/app")}.jsonl`), '{"taskId":"torn","appId":"@t/app"', "utf8")
    await ledger.append(entry("t2", "2026-10-13T11:00:00.000Z"))
    expect((await ledger.find("@t/app", "t2"))!.taskId).toBe("t2")
    expect(await ledger.find("@t/app", "torn")).toBeUndefined()
    expect((await ledger.list("@t/app")).map(e => e.taskId)).toEqual(["t2", "t1"])
  })

  it("find still resolves a task and skips torn lines", async () => {
    const ledger = createA2aTaskLedger(dir)
    await ledger.append(entry("t1", "2026-10-13T10:00:00.000Z"))
    await appendFile(join(dir, `${encodeURIComponent("@t/app")}.jsonl`), '{"taskId":"torn"', "utf8")
    expect((await ledger.find("@t/app", "t1"))!.taskId).toBe("t1")
    expect(await ledger.find("@t/app", "torn")).toBeUndefined()
    expect(await ledger.find("@t/app", "nope")).toBeUndefined()
  })

  it("page tokens round-trip and reject anything malformed", () => {
    expect(decodePageToken(encodePageToken(0))).toBe(0)
    expect(decodePageToken(encodePageToken(42))).toBe(42)
    expect(decodePageToken("!!not-base64!!")).toBeUndefined()
    expect(decodePageToken(Buffer.from("not json", "utf8").toString("base64url"))).toBeUndefined()
    expect(decodePageToken(Buffer.from(JSON.stringify({ o: -1 }), "utf8").toString("base64url"))).toBeUndefined()
    expect(decodePageToken(Buffer.from(JSON.stringify({ o: 1.5 }), "utf8").toString("base64url"))).toBeUndefined()
    expect(decodePageToken(Buffer.from(JSON.stringify({ o: "2" }), "utf8").toString("base64url"))).toBeUndefined()
  })
})

describe("a2a-tasks mapping", () => {
  it("maps run status to task state", () => {
    expect(mapRunState({ status: "running", sessions: [] })).toBe("TASK_STATE_SUBMITTED")
    expect(mapRunState({ status: "running", sessions: [{}] })).toBe("TASK_STATE_WORKING")
    expect(mapRunState({ status: "succeeded" })).toBe("TASK_STATE_COMPLETED")
    expect(mapRunState({ status: "failed" })).toBe("TASK_STATE_FAILED")
    expect(mapRunState({ status: "cancelled" })).toBe("TASK_STATE_CANCELED")
    expect(mapRunState({})).toBe("TASK_STATE_FAILED")
  })

  it("maps workflow run status to task state", () => {
    expect(mapWorkflowState("running")).toBe("TASK_STATE_WORKING")
    expect(mapWorkflowState("idle")).toBe("TASK_STATE_WORKING")
    expect(mapWorkflowState("awaiting-input")).toBe("TASK_STATE_INPUT_REQUIRED")
    expect(mapWorkflowState("awaiting-approval")).toBe("TASK_STATE_INPUT_REQUIRED")
    expect(mapWorkflowState("done")).toBe("TASK_STATE_COMPLETED")
    expect(mapWorkflowState("failed")).toBe("TASK_STATE_FAILED")
    expect(mapWorkflowState("cancelled")).toBe("TASK_STATE_CANCELED")
    // An unrecognised status keeps the task working.
    expect(mapWorkflowState("something-new")).toBe("TASK_STATE_WORKING")
    expect(mapWorkflowState("")).toBe("TASK_STATE_WORKING")
  })

  it("completes a still-running run once every session's turn is done", () => {
    const done = { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1 }
    expect(mapRunState({ status: "running", sessions: [{ descriptor: done }] })).toBe("TASK_STATE_COMPLETED")
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { status: "exited" } }] })).toBe("TASK_STATE_COMPLETED")
    // Busy, waiting on input, or zero turns done → still working.
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { ...done, busy: true } }] })).toBe("TASK_STATE_WORKING")
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { ...done, awaitingInput: true } }] })).toBe("TASK_STATE_WORKING")
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { ...done, turnsCompleted: 0 } }] })).toBe("TASK_STATE_WORKING")
    // Every session must carry a descriptor: a slim one keeps working.
    expect(mapRunState({ status: "running", sessions: [{ descriptor: done }, {}] })).toBe("TASK_STATE_WORKING")
    expect(mapRunState({ status: "running", sessions: [{ agentId: "solo" }] })).toBe("TASK_STATE_WORKING")
    // One still-busy session among finished ones keeps the run working.
    expect(
      mapRunState({
        status: "running",
        sessions: [{ descriptor: done }, { descriptor: { status: "running", busy: true, turnsCompleted: 1 } }],
      }),
    ).toBe("TASK_STATE_WORKING")
    // An ended run ignores its sessions entirely.
    expect(mapRunState({ status: "failed", sessions: [{ descriptor: done }] })).toBe("TASK_STATE_FAILED")
  })

  it("fails a still-running run once any session's turn ended in error", () => {
    const done = { status: "running", busy: false, awaitingInput: false, turnsCompleted: 1 }
    expect(
      mapRunState({
        status: "running",
        sessions: [{ descriptor: { ...done, lastTurnErroredAt: "2026-10-13T10:00:00.000Z", lastTurnErrorMessage: "boom" } }],
      }),
    ).toBe("TASK_STATE_FAILED")
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { ...done, lastTurnReason: "error" } }] })).toBe(
      "TASK_STATE_FAILED",
    )
    // Aborted is not a failure.
    expect(mapRunState({ status: "running", sessions: [{ descriptor: { ...done, lastTurnReason: "aborted" } }] })).toBe(
      "TASK_STATE_COMPLETED",
    )
    // One failed session among completed ones fails the run.
    expect(
      mapRunState({
        status: "running",
        sessions: [{ descriptor: done }, { descriptor: { ...done, lastTurnErroredAt: "2026-10-13T10:00:00.000Z" } }],
      }),
    ).toBe("TASK_STATE_FAILED")
    // A still-busy session keeps the run working even with a prior error.
    expect(
      mapRunState({
        status: "running",
        sessions: [{ descriptor: { ...done, lastTurnErroredAt: "2026-10-13T10:00:00.000Z", busy: true } }],
      }),
    ).toBe("TASK_STATE_WORKING")
  })

  it("sessionTurnDone reads the descriptor", () => {
    expect(sessionTurnDone({ status: "exited" })).toBe(true)
    expect(sessionTurnDone({ status: "error" })).toBe(true)
    expect(sessionTurnDone({ status: "starting" })).toBe(false)
    expect(sessionTurnDone({ status: "running", busy: false, turnsCompleted: 1 })).toBe(true)
    expect(sessionTurnDone({ status: "running", busy: true, turnsCompleted: 1 })).toBe(false)
  })

  it("sessionTurnFailed reads the descriptor", () => {
    expect(sessionTurnFailed({})).toBe(false)
    expect(sessionTurnFailed({ lastTurnErroredAt: "2026-10-13T10:00:00.000Z" })).toBe(true)
    expect(sessionTurnFailed({ lastTurnErroredAt: "" })).toBe(false)
    expect(sessionTurnFailed({ lastTurnReason: "error" })).toBe(true)
    expect(sessionTurnFailed({ lastTurnReason: "completed" })).toBe(false)
    expect(sessionTurnFailed({ lastTurnReason: "aborted" })).toBe(false)
    expect(
      sessionTurnFailed({ status: "running", busy: false, turnsCompleted: 1, lastTurnErroredAt: "2026-10-13T10:00:00.000Z", lastTurnErrorMessage: "boom" }),
    ).toBe(true)
  })

  it("extractLastAssistantText strips the window suffix and takes the last non-blank assistant text", () => {
    const body = (messages: unknown[]) => `${JSON.stringify({ meta: {}, messages })}\n\n---\n[window: messages 1–2 of 3]`
    expect(
      extractLastAssistantText(
        body([
          { role: "user", text: "hi" },
          { role: "assistant", text: "first" },
          { role: "assistant", text: "  \n " },
          { role: "assistant", text: "last one" },
        ]),
      ),
    ).toBe("last one")
    expect(extractLastAssistantText(body([{ role: "user", text: "hi" }]))).toBeUndefined()
    expect(extractLastAssistantText(body([]))).toBeUndefined()
    expect(extractLastAssistantText("not json at all")).toBeUndefined()
    expect(extractLastAssistantText(JSON.stringify({ messages: "nope" }))).toBeUndefined()
  })

  it("extractSkillRequest prefers metadata over the text prefix", () => {
    const parts = [{ text: "skill:a run it" }]
    expect(extractSkillRequest({ parts, metadata: { skill: "b" } }, "@x/y")).toEqual({ skill: "b", prompt: "run it" })
    expect(extractSkillRequest({ parts }, "@x/y")).toEqual({ skill: "a", prompt: "run it" })
    expect(extractSkillRequest({ parts: [{ text: "plain" }] }, "@x/y")).toEqual({ prompt: "plain" })
  })
})

/** One parsed SSE frame: a whole JSON-RPC response, `result` or `error`. */
interface SseEvent {
  jsonrpc: string
  id: unknown
  result?: any
  error?: { code: number; message: string }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Poll `cond` until it holds (or fail the test after `timeoutMs`). */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${what} not reached`)
    await sleep(5)
  }
}

/** POST a body to the A2A route and hand back the raw response — JSON or
 *  SSE — without reading it. */
function openStream(
  port: number,
  appId: string,
  body: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/a2a/apps/${appId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/** Split an SSE body into its `data:` payloads; `:` comments (keepalive) are
 *  frames too, just not events. Drains until the server ends the stream. */
async function* sseEvents(res: Response): AsyncGenerator<SseEvent> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (let idx = buf.indexOf("\n\n"); idx !== -1; idx = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        if (frame.startsWith(":")) continue
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as SseEvent
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}
