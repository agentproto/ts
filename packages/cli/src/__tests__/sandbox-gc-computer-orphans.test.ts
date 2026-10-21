/**
 * `agentproto sandbox gc` - the ORPHAN sweep over a PROVIDER's control
 * plane (the computer controller).
 *
 * A box the controller still holds keeps its RAM (and its session slots)
 * even when no agentproto session references it any more: the daemon's
 * ledger gc cannot see those boxes, so the provider sweep is what frees
 * the memory that blocks every later launch with "host capacity".
 *
 * The fake provider below stands in for the controller: it lists boxes and
 * records every `remove()` with the force flag the gc passes.
 *
 * A candidate must be past the 15-minute grace window and carry no
 * attached session: a box the controller still counts a session on, and a
 * box that is still fresh, are NEVER proposed (nor deleted).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxGcProviderHandle } from "@agentproto/runtime"

const { runSandbox } = await import("../commands/sandbox.js")

/** A creation timestamp well past the 15-minute grace window. */
const oldEnough = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString()
/** A creation timestamp inside the grace window. */
const freshEnough = (): string => new Date(Date.now() - 60 * 1000).toISOString()

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  return { stdout, stderr, restore: () => { outSpy.mockRestore(); errSpy.mockRestore() } }
}

interface FakeController {
  handle: SandboxGcProviderHandle
  /** Every `remove()` call: the box id and the force flag. */
  removes: Array<{ id: string; force: boolean | undefined }>
  /** Make `listBoxes` throw (a controller that is down). */
  failList: boolean
}

/** A fake computer controller: lists boxes, records the destroys. */
function makeFakeController(
  boxes: Array<{ id: string; state?: string; sessions?: number; createdAt?: string }>,
): FakeController {
  const removes: Array<{ id: string; force: boolean | undefined }> = []
  const controller: FakeController = {
    removes,
    failList: false,
    handle: {
      provider: {
        listBoxes: async () => {
          if (controller.failList) throw new Error("computer controller unreachable at http://ctrl:7110")
          return boxes.map(b => ({
            id: b.id,
            ...(b.state !== undefined ? { state: b.state } : {}),
            ...(b.sessions !== undefined ? { sessions: b.sessions } : {}),
            ...(b.createdAt !== undefined ? { createdAt: b.createdAt } : {}),
          }))
        },
        remove: async (id: string, opts?: { force?: boolean }) => {
          removes.push({ id, force: opts?.force })
        },
      },
    },
  }
  return controller
}

describe("agentproto sandbox gc - computer orphan boxes", () => {
  let tmp: string
  let ledgerPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-gc-orphan-"))
    ledgerPath = join(tmp, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
    await mkdir(tmp, { recursive: true })
    await writeFile(
      ledgerPath,
      JSON.stringify({ savedAt: new Date().toISOString(), sandboxes: [] }, null, 2),
      "utf8",
    )
  })

  afterEach(async () => {
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  const noStatuses = async (): Promise<Map<string, string>> => new Map()

  it("dry run lists an orphan box the daemon registry does not know", async () => {
    const controller = makeFakeController([
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
      { id: "cmp-running-orphan", state: "running", sessions: 0, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).toContain("cmp-orphan")
      expect(out).toContain("cmp-running-orphan")
      expect(out).toContain("dry run only")
      // Dry run deletes nothing.
      expect(controller.removes).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it("never lists a box a live session holds", async () => {
    const controller = makeFakeController([
      { id: "cmp-held", state: "running", sessions: 1, createdAt: oldEnough() },
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [{ id: "sess_live", status: "running", sandboxId: "cmp-held" }],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).not.toContain("cmp-held")
      expect(out).toContain("cmp-orphan")
      expect(controller.removes).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it("never lists a box the provider still counts a session on", async () => {
    const controller = makeFakeController([
      { id: "cmp-attached", state: "running", sessions: 1, createdAt: oldEnough() },
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).not.toContain("cmp-attached")
      expect(out).toContain("cmp-orphan")
    } finally {
      capture.restore()
    }
  })

  it("--include-attached proposes the attached boxes too", async () => {
    const controller = makeFakeController([
      { id: "cmp-attached", state: "running", sessions: 1, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc", "--include-attached"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      expect(capture.stdout.join("")).toContain("cmp-attached")
    } finally {
      capture.restore()
    }
  })

  it("never lists a box that is still inside the grace window", async () => {
    const controller = makeFakeController([
      { id: "cmp-fresh", state: "stopped", sessions: 0, createdAt: freshEnough() },
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).not.toContain("cmp-fresh")
      expect(out).toContain("cmp-orphan")
    } finally {
      capture.restore()
    }
  })

  it("--apply deletes the orphan boxes with force=true", async () => {
    const controller = makeFakeController([
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
      { id: "cmp-attached", state: "running", sessions: 1, createdAt: oldEnough() },
      { id: "cmp-held", state: "running", createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc", "--apply"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [{ id: "sess_live", status: "running", sandboxId: "cmp-held" }],
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      expect(controller.removes).toEqual([{ id: "cmp-orphan", force: true }])
    } finally {
      capture.restore()
    }
  })

  it("reports a controller error without crashing the gc of other providers", async () => {
    const broken = makeFakeController([])
    broken.failList = true
    const healthy = makeFakeController([{ id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() }])
    const capture = captureOutput()
    try {
      const code = await runSandbox(
        ["gc", "--apply", "--provider", "broken", "--provider", "healthy"],
        {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async (slug: string) => (slug === "broken" ? broken.handle : healthy.handle),
      })
      expect(code).toBe(1)
      const err = capture.stderr.join("")
      expect(err).toContain("broken")
      expect(err).toContain("computer controller unreachable")
      // The healthy provider was still swept.
      expect(healthy.removes).toEqual([{ id: "cmp-orphan", force: true }])
    } finally {
      capture.restore()
    }
  })

  it("says the provider sweep was NOT SCANNED when the daemon cannot be reached", async () => {
    const controller = makeFakeController([
      { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: oldEnough() },
    ])
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => {
          throw new Error("no live daemon found")
        },
        resolveProvider: async () => controller.handle,
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).toContain("not scanned")
      expect(out).not.toContain("every box the provider lists is known or in use")
      expect(controller.removes).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it("says the provider sweep was NOT SCANNED when the provider cannot enumerate its boxes", async () => {
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: noStatuses,
        fetchLiveSessions: async () => [],
        resolveProvider: async () => ({ provider: {} }),
      })
      expect(code).toBe(0)
      const out = capture.stdout.join("")
      expect(out).toContain("not scanned")
      expect(out).not.toContain("every box the provider lists is known or in use")
    } finally {
      capture.restore()
    }
  })
})
