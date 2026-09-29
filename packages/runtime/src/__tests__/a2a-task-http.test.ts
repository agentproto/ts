/**
 * A2A task ingress — `POST /a2a/apps/:appId` (a2a-task-http.ts). Drives the
 * real REST layer via `startHttpServer`; `app_run` / `app_status` /
 * `app_stop` / `app_artifact_get` are faked behind `dispatchTool`, and the
 * manifest's `accepts` / `exposes` come from an injected `loadHandle` (lane 2's
 * loader fields are not on main yet).
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
  extractSkillRequest,
  mapRunState,
  type A2aAppHandleLike,
  type A2aTask,
} from "../a2a-tasks.js"

const APP_ID = "@test/a2a-app"
const OTHER_APP_ID = "@test/closed-app"

const envelope = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
})

describe("A2A task ingress", () => {
  let dir: string
  let stateDir: string
  let appRegistry: AppRegistry
  let runs: Map<string, { status: string; sessions: unknown[]; error?: string }>
  let dispatched: Array<{ name: string; args: Record<string, unknown> }>
  let handles: Record<string, A2aAppHandleLike>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a2a-task-app-"))
    stateDir = await mkdtemp(join(tmpdir(), "a2a-task-state-"))
    runs = new Map()
    dispatched = []
    handles = {
      [APP_ID]: { accepts: { tasks: true }, exposes: { agents: ["solo"], workflows: ["do-it"] } },
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
      return envelope({ appRunId: args.appRunId, appId: APP_ID, ...run })
    }
    if (name === "app_stop") {
      runs.get(args.appRunId as string)!.status = "cancelled"
      return envelope({ appRunId: args.appRunId, killed: [], status: "cancelled" })
    }
    if (name === "app_artifact_get") {
      return envelope({ appId: APP_ID, title: "Report", description: "the report", html: "<h1>done</h1>" })
    }
    throw new Error(`unexpected tool ${name}`)
  }

  async function withServer(fn: (rpc: (appId: string, body: unknown, raw?: boolean) => Promise<{ status: number; json: any }>) => Promise<void>): Promise<void> {
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
    const rpc = async (appId: string, body: unknown, raw = false) => {
      const res = await fetch(`http://127.0.0.1:${port}/a2a/apps/${appId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    method: "message/send",
    params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text }], metadata: { skill } } },
  })

  it("message/send starts an app_run; tasks/get walks working → completed with an artifact", async () => {
    await withServer(async rpc => {
      const sent = await rpc(APP_ID, sendReq("solo", "summarise this"))
      expect(sent.status).toBe(200)
      const task = sent.json.result as A2aTask
      expect(task.kind).toBe("task")
      expect(task.id).toBe("run-1")
      expect(task.status.state).toBe("working")
      expect(task.contextId).toBeTruthy()
      expect(task.artifacts).toBeUndefined()
      expect(dispatched.find(d => d.name === "app_run")!.args).toEqual({ appId: APP_ID, agents: ["solo"], prompt: "summarise this" })

      runs.get("run-1")!.status = "succeeded"
      const done = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "run-1" } })
      const doneTask = done.json.result as A2aTask
      expect(doneTask.status.state).toBe("completed")
      expect(doneTask.contextId).toBe(task.contextId)
      expect(doneTask.artifacts).toHaveLength(1)
      const part = doneTask.artifacts![0]!.parts[0]!
      expect(part.kind).toBe("file")
      if (part.kind === "file") expect(Buffer.from(part.file.bytes, "base64").toString()).toBe("<h1>done</h1>")

      runs.set("run-1", { status: "failed", sessions: [{}], error: "agent crashed" })
      const failed = (await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: "run-1" } })).json.result as A2aTask
      expect(failed.status.state).toBe("failed")
      expect(failed.status.message?.parts[0]).toEqual({ kind: "text", text: "agent crashed" })
    })
  })

  it("accepts a `skill:` text prefix and the Agent Card `<appId>/<skill>` form", async () => {
    await withServer(async rpc => {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text: `skill:${APP_ID}/solo do the thing` }] } },
      }
      const res = await rpc(APP_ID, body)
      expect(res.json.result.id).toBe("run-1")
      expect(dispatched.find(d => d.name === "app_run")!.args.prompt).toBe("do the thing")
    })
  })

  it("persists the task ledger so tasks/get survives a restart", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo"))
    })
    const ledger = await readFile(join(stateDir, "a2a-tasks", `${encodeURIComponent(APP_ID)}.jsonl`), "utf8")
    expect(JSON.parse(ledger.trim())).toMatchObject({ taskId: "run-1", appId: APP_ID, skill: "solo" })
    await withServer(async rpc => {
      runs.set("run-1", { status: "succeeded", sessions: [{}] })
      const res = await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "run-1" } })
      expect(res.json.result.status.state).toBe("completed")
    })
  })

  it("refuses message/send when the app does not declare accepts.tasks", async () => {
    await withServer(async rpc => {
      const res = await rpc(OTHER_APP_ID, sendReq("solo"))
      expect(res.json.error.code).toBe(-32004)
      expect(res.json.error.message).toContain("accepts.tasks")
      handles[OTHER_APP_ID] = {}
      expect((await rpc(OTHER_APP_ID, sendReq("solo"))).json.error.code).toBe(-32004)
      expect(dispatched.some(d => d.name === "app_run")).toBe(false)
    })
  })

  it("rejects a missing, unknown, or workflow skill", async () => {
    await withServer(async rpc => {
      const none = await rpc(APP_ID, { ...sendReq("solo"), params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } } })
      expect(none.json.error.code).toBe(-32602)
      const unknown = await rpc(APP_ID, sendReq("ghost"))
      expect(unknown.json.error.code).toBe(-32602)
      expect(unknown.json.error.message).toContain("ghost")
      const workflow = await rpc(APP_ID, sendReq("do-it"))
      expect(workflow.json.error.code).toBe(-32004)
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

  it("tasks/get on an unknown id, or an id from another app, is TaskNotFound", async () => {
    await withServer(async rpc => {
      const unknown = await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "nope" } })
      expect(unknown.json.error.code).toBe(-32001)
      await rpc(APP_ID, sendReq("solo"))
      const crossApp = await rpc(OTHER_APP_ID, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "run-1" } })
      expect(crossApp.json.error.code).toBe(-32001)
    })
  })

  it("tasks/cancel stops the run; a finished task is not cancelable", async () => {
    await withServer(async rpc => {
      await rpc(APP_ID, sendReq("solo"))
      const cancel = await rpc(APP_ID, { jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: "run-1" } })
      expect(cancel.json.result.status.state).toBe("canceled")
      expect(dispatched.find(d => d.name === "app_stop")!.args).toEqual({ appRunId: "run-1" })
      const again = await rpc(APP_ID, { jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id: "run-1" } })
      expect(again.json.error.code).toBe(-32002)
      const missing = await rpc(APP_ID, { jsonrpc: "2.0", id: 4, method: "tasks/cancel", params: { id: "nope" } })
      expect(missing.json.error.code).toBe(-32001)
    })
  })

  it("answers protocol errors: parse, invalid request, unknown method, streaming, unknown app", async () => {
    await withServer(async rpc => {
      expect((await rpc(APP_ID, "{not json", true)).json.error.code).toBe(-32700)
      expect((await rpc(APP_ID, [sendReq("solo")])).json.error.code).toBe(-32600)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "tasks/nope" })).json.error.code).toBe(-32601)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "message/stream" })).json.error.code).toBe(-32004)
      expect((await rpc(APP_ID, { jsonrpc: "2.0", id: 1, method: "tasks/pushNotificationConfig/set" })).json.error.code).toBe(-32003)
      const ghost = await rpc("@test/ghost", sendReq("solo"))
      expect(ghost.status).toBe(404)
      expect(ghost.json.error.message).toContain("no installed app")
    })
  })
})

describe("a2a-tasks mapping", () => {
  it("maps run status to task state", () => {
    expect(mapRunState({ status: "running", sessions: [] })).toBe("submitted")
    expect(mapRunState({ status: "running", sessions: [{}] })).toBe("working")
    expect(mapRunState({ status: "succeeded" })).toBe("completed")
    expect(mapRunState({ status: "failed" })).toBe("failed")
    expect(mapRunState({ status: "cancelled" })).toBe("canceled")
    expect(mapRunState({})).toBe("unknown")
  })

  it("extractSkillRequest prefers metadata over the text prefix", () => {
    const parts = [{ kind: "text" as const, text: "skill:a run it" }]
    expect(extractSkillRequest({ parts, metadata: { skill: "b" } }, "@x/y")).toEqual({ skill: "b", prompt: "run it" })
    expect(extractSkillRequest({ parts }, "@x/y")).toEqual({ skill: "a", prompt: "run it" })
    expect(extractSkillRequest({ parts: [{ kind: "text", text: "plain" }] }, "@x/y")).toEqual({ prompt: "plain" })
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
