/**
 * `PATCH /tasks/:id` forwards `approvalIds` / `artifacts` to the ledger
 * (parity with the MCP `task_update` tool), so an HTTP client can park a
 * task on `awaiting_approval` with links and read them back with GET.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createRuntimeEvents } from "../events.js"
import { startHttpServer } from "../http-server.js"
import { createTaskLedger, type TaskRecord, type TaskVerifySupervisor } from "../task-ledger.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tasks-http-patch-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const supervisor: TaskVerifySupervisor = {
  attach() {
    throw new Error("supervisor.attach must not be reached")
  },
  getStatus: () => undefined,
  onSettle: () => () => {},
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const bus = createSessionEventBus()
  const ledger = createTaskLedger({
    registry: { get: () => undefined },
    sessionEvents: bus,
    supervisor,
    gateRunner: async () => ({ passed: false, error: "no gate runner in this test" }),
  })
  const registry = createSessionsRegistry({ persist: false, transcriptDir: join(home, "sessions") })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    token: "test-daemon-token",
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    meta: { workspace: process.cwd(), registered: [] },
    taskLedger: ledger,
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
    registry.shutdown()
    ledger.dispose()
  }
}

async function send(
  base: string,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<{ status: number; body: { task?: TaskRecord; error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { task?: TaskRecord; error?: string } }
}

async function getTask(base: string, taskId: string): Promise<TaskRecord> {
  const res = await fetch(`${base}/tasks/${taskId}`)
  expect(res.status).toBe(200)
  return (await res.json()) as TaskRecord
}

/** Create a task and move it to in_progress (owner `human`) over HTTP. */
async function startedTask(base: string): Promise<TaskRecord> {
  const created = await send(base, "POST", "/tasks", { title: "Send the invoice", owner: "human" })
  expect(created.status).toBe(201)
  const task = created.body.task as TaskRecord
  const started = await send(base, "PATCH", `/tasks/${task.taskId}`, {
    rev: task.rev,
    status: "in_progress",
  })
  expect(started.status).toBe(200)
  return started.body.task as TaskRecord
}

describe("PATCH /tasks/:id forwards approvalIds / artifacts", () => {
  it("links approvals + artifacts and parks the task on awaiting_approval, readable via GET", async () => {
    await withServer(async base => {
      const task = await startedTask(base)
      const artifacts = [
        { approvalId: "apr_1" },
        { sessionId: "sess_a", key: "invoice.pdf", sha256: "abc123" },
      ]
      const res = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: task.rev,
        status: "awaiting_approval",
        approvalIds: ["apr_1"],
        artifacts,
      })
      expect(res.status).toBe(200)
      expect(res.body.task?.status).toBe("awaiting_approval")

      const read = await getTask(base, task.taskId)
      expect(read.status).toBe("awaiting_approval")
      expect(read.approvalIds).toEqual(["apr_1"])
      expect(read.artifacts).toEqual(artifacts)
    })
  })

  it("awaiting_approval without any approvalIds is refused (400)", async () => {
    await withServer(async base => {
      const task = await startedTask(base)
      const res = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: task.rev,
        status: "awaiting_approval",
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain("no linked approvalIds")
      expect((await getTask(base, task.taskId)).status).toBe("in_progress")
    })
  })

  it("links can be written on their own, then satisfy a later awaiting_approval write", async () => {
    await withServer(async base => {
      const task = await startedTask(base)
      const linked = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: task.rev,
        approvalIds: ["apr_9"],
      })
      expect(linked.status).toBe(200)
      const parked = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: (linked.body.task as TaskRecord).rev,
        status: "awaiting_approval",
      })
      expect(parked.status).toBe(200)
      const read = await getTask(base, task.taskId)
      expect(read.status).toBe("awaiting_approval")
      expect(read.approvalIds).toEqual(["apr_9"])
    })
  })

  it("malformed approvalIds / artifacts are rejected (400), not silently dropped", async () => {
    await withServer(async base => {
      const task = await startedTask(base)
      const badIds = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: task.rev,
        approvalIds: ["apr_1", 7],
      })
      expect(badIds.status).toBe(400)
      expect(badIds.body.error).toBe("invalid_approval_ids")

      const badArtifacts = await send(base, "PATCH", `/tasks/${task.taskId}`, {
        rev: task.rev,
        artifacts: [{ sessionId: "sess_a" }],
      })
      expect(badArtifacts.status).toBe(400)
      expect(badArtifacts.body.error).toBe("invalid_artifacts")

      const read = await getTask(base, task.taskId)
      expect(read.rev).toBe(task.rev)
      expect(read.approvalIds ?? []).toEqual([])
    })
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
