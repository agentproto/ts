/**
 * A2A task ingress — `POST /a2a/apps/:appId` (a2a-task-http.ts). Drives the
 * real REST layer via `startHttpServer` over the A2A 1.0 wire shapes
 * (PascalCase methods, flat parts, enum-prefixed states); `app_run` / `app_status` /
 * `app_stop` / `app_artifact_get` and `workflow_run_file` / `workflow_status` /
 * `workflow_cancel` are faked behind `dispatchTool`, and the
 * manifest's `accepts` / `exposes` / bundled workflows come from an injected `loadHandle`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
import {
  extractLastAssistantText,
  extractSkillRequest,
  mapRunState,
  mapWorkflowState,
  sessionTurnDone,
  sessionTurnFailed,
  type A2aAppHandleLike,
  type A2aTask,
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

  async function withServer(fn: (rpc: (appId: string, body: unknown, raw?: boolean, opts?: { version?: string | null; query?: string }) => Promise<{ status: number; json: any }>) => Promise<void>): Promise<void> {
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
      a2aTasks: { stateDir, loadHandle: async d => handles[d.endsWith("/a") ? APP_ID : OTHER_APP_ID]! },
    })
    const rpc = async (appId: string, body: unknown, raw = false, opts: { version?: string | null; query?: string } = {}) => {
      const version = opts.version === undefined ? "1.0" : opts.version
      const res = await fetch(`http://127.0.0.1:${port}/a2a/apps/${appId}${opts.query ?? ""}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(version ? { "a2a-version": version } : {}) },
        body: raw ? (body as string) : JSON.stringify(body),
      })
      return { status: res.status, json: await res.json() }
    }
    try {
      await fn(rpc)
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

  it("answers protocol errors: parse, invalid request, unknown/0.3 methods, streaming, push, unknown app", async () => {
    await withServer(async rpc => {
      expect((await rpc(APP_ID, "{not json", true)).json.error.code).toBe(-32700)
      expect((await rpc(APP_ID, [sendReq("solo")])).json.error.code).toBe(-32600)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "Nope" })).json.error.code).toBe(-32601)
      // The 0.3 method names are gone.
      for (const legacy of ["message/send", "tasks/get", "tasks/cancel"]) {
        expect((await rpc(APP_ID, { ...sendReq("solo"), method: legacy })).json.error.code).toBe(-32601)
      }
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "SendStreamingMessage" })).json.error.code).toBe(-32004)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "CreateTaskPushNotificationConfig" })).json.error.code).toBe(-32003)
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
