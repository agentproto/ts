/**
 * A delivery record lands after `kill()` has closed the session's transcript
 * writer; writing the notice reopens an append stream, which must be ended
 * again or each delivered session leaks a file descriptor.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WriteStream } from "node:fs"

const opened: WriteStream[] = []
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    createWriteStream: ((...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args)
      opened.push(stream)
      return stream
    }) as typeof actual.createWriteStream,
  }
})

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"
import type { SandboxDeliveryRecord } from "../sandbox-delivery.js"

const record: SandboxDeliveryRecord = {
  at: new Date().toISOString(),
  branch: "wt/x",
  baseSha: "b".repeat(40),
  ahead: 1,
  push: { status: "pushed" },
  bundle: { status: "skipped" },
}

function agentSession(): AgentSessionLike {
  return {
    sessionId: "box_1",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

describe("recordSandboxDelivery", () => {
  let dir: string

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("writes the notice after kill without leaving a transcript stream open", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-delivery-transcript-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: dir })
    try {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/home/user",
        agentSession: agentSession(),
        adapterSlug: "fake-cli",
        commandPreview: "sandbox:fake → fake-cli",
      })
      registry.recordNotice(desc.id, "[boot] hello")
      registry.kill(desc.id)
      opened.length = 0

      expect(registry.recordSandboxDelivery(desc.id, record, "[sandbox delivery] wt/x — pushed")).toBe(true)

      await vi.waitFor(() => {
        expect(opened.length).toBeGreaterThan(0)
        expect(opened.every(stream => stream.closed)).toBe(true)
      })
      const events = await readFile(sessionEventsPath(desc.id, dir), "utf8")
      expect(events).toContain("[sandbox delivery] wt/x — pushed")
    } finally {
      registry.shutdown()
    }
  })
})

describe("recordSandboxDelivery — parent rescue notice", () => {
  const rescued: SandboxDeliveryRecord = {
    ...record,
    uncommittedFiles: 3,
    checkpoint: { status: "pushed", ref: "agentproto-checkpoint/wt/x", sha: "c".repeat(40) },
  }

  function setup() {
    const registry = createSessionsRegistry({ persist: false })
    const spawn = (extra: { parentSessionId?: string } = {}) =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/home/user",
        agentSession: agentSession(),
        adapterSlug: "fake-cli",
        commandPreview: "sandbox:fake → fake-cli",
        ...extra,
      })
    const parent = spawn()
    const child = spawn({ parentSessionId: parent.id })
    const send = vi
      .spyOn(registry, "sendMessage")
      .mockResolvedValue({ messageId: "msg_fake", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" })
    return { registry, parent, child, send }
  }

  it("tells the parent which ref holds the uncommitted work and how to fetch it", () => {
    const { registry, parent, child, send } = setup()
    try {
      registry.recordSandboxDelivery(child.id, rescued, "[sandbox delivery] wt/x")
      expect(send).toHaveBeenCalledTimes(1)
      const message = send.mock.calls[0]![0]
      expect(message.to).toBe(parent.id)
      expect(message.text).toContain("3 uncommitted file(s)")
      expect(message.text).toContain("agentproto-checkpoint/wt/x")
      expect(message.text).toContain("git fetch origin agentproto-checkpoint/wt/x")
    } finally {
      registry.shutdown()
    }
  })

  it("stays silent when nothing was left uncommitted", () => {
    const { registry, child, send } = setup()
    try {
      registry.recordSandboxDelivery(child.id, { ...rescued, uncommittedFiles: 0 }, "[sandbox delivery] wt/x")
      registry.recordSandboxDelivery(child.id, record, "[sandbox delivery] wt/x")
      expect(send).not.toHaveBeenCalled()
    } finally {
      registry.shutdown()
    }
  })

  it("stays silent when the snapshot never reached the remote, and for a parentless session", () => {
    const { registry, parent, child, send } = setup()
    try {
      registry.recordSandboxDelivery(
        child.id,
        { ...rescued, checkpoint: { status: "failed", ref: "agentproto-checkpoint/wt/x" } },
        "[sandbox delivery] wt/x",
      )
      registry.recordSandboxDelivery(parent.id, rescued, "[sandbox delivery] wt/x")
      expect(send).not.toHaveBeenCalled()
    } finally {
      registry.shutdown()
    }
  })
})

