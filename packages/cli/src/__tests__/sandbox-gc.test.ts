/**
 * `agentproto sandbox gc` — dry run lists orphans; `--apply` tears their
 * boxes down (kill by default, `--pause` to pause) and stamps the ledger.
 * The fake provider records every pause/stop call so the test asserts
 * exactly what happened to each box.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxGcProviderHandle } from "@agentproto/runtime"

const { runSandbox } = await import("../commands/sandbox.js")

/** Capture stdout/stderr writes into arrays. */
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

interface FakeProviderRecorder {
  handle: SandboxGcProviderHandle
  stops: string[]
  pauses: string[]
}

function makeFakeProvider(sandboxId: string, withPause = false): FakeProviderRecorder {
  const stops: string[] = []
  const pauses: string[] = []
  const handle: SandboxGcProviderHandle = {
    provider: {
      connect: async () => ({
        sandboxId,
        stop: async () => {
          stops.push(sandboxId)
        },
        ...(withPause
          ? {
              pause: async () => {
                pauses.push(sandboxId)
              },
            }
          : {}),
      }),
    },
  }
  return { handle, stops, pauses }
}

describe("agentproto sandbox gc", () => {
  let tmp: string
  let ledgerPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-gc-test-"))
    ledgerPath = join(tmp, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
  })

  afterEach(async () => {
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function seedLedger(entries: Array<Record<string, unknown>>): Promise<void> {
    await mkdir(tmp, { recursive: true })
    await writeFile(
      ledgerPath,
      JSON.stringify({ savedAt: new Date().toISOString(), sandboxes: entries }, null, 2),
      "utf8",
    )
  }

  const deadStatuses = (): Map<string, string> =>
    new Map([
      ["sess_dead", "error"],
      ["sess_dead_killed", "killed"],
      ["sess_dead_exited", "exited"],
      ["sess_alive", "idle"],
    ])

  it("dry run lists orphan entries and touches no box", async () => {
    await seedLedger([
      {
        sandboxId: "sbx_orphan1",
        provider: "e2b",
        state: "paused",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        originSessionId: "sess_dead",
      },
      {
        sandboxId: "sbx_live_origin",
        provider: "e2b",
        state: "booted",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        originSessionId: "sess_alive",
      },
    ])
    const fake = makeFakeProvider("sbx_orphan1")
    const capture = captureOutput()
    try {
      const code = await runSandbox(["gc"], {
        fetchSessionStatuses: async () => deadStatuses(),
        resolveProvider: async () => fake.handle,
      })
      expect(code).toBe(0)
      expect(capture.stdout.join("")).toContain("sbx_orphan1")
      expect(capture.stdout.join("")).toContain("sess_dead")
      expect(capture.stdout.join("")).toContain("dry run only")
      expect(capture.stdout.join("")).not.toContain("sbx_live_origin")
      expect(fake.stops).toEqual([])
      expect(fake.pauses).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it("--apply kills orphan boxes and stamps the ledger stopped", async () => {
    await seedLedger([
      {
        sandboxId: "sbx_orphan1",
        provider: "e2b",
        state: "paused",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        originSessionId: "sess_dead_killed",
      },
    ])
    const fake = makeFakeProvider("sbx_orphan1")
    const capture = captureOutput()
    try {
      const code = await runSandbox(
        ["gc", "--apply"],
        { fetchSessionStatuses: async () => deadStatuses(), resolveProvider: async () => fake.handle },
      )
      expect(code).toBe(0)
      expect(fake.stops).toEqual(["sbx_orphan1"])
      expect(fake.pauses).toEqual([])
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        sandboxes: Array<{ sandboxId: string; state: string }>
      }
      expect(ledger.sandboxes[0]).toMatchObject({ sandboxId: "sbx_orphan1", state: "stopped" })
      expect(capture.stdout.join("")).toContain("stopped (session sess_dead_killed killed)")
    } finally {
      capture.restore()
    }
  })

  it("--apply --pause pauses the box instead of killing it", async () => {
    await seedLedger([
      {
        sandboxId: "sbx_orphan1",
        provider: "e2b",
        state: "connected",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        originSessionId: "sess_dead_exited",
      },
    ])
    const fake = makeFakeProvider("sbx_orphan1", true)
    const capture = captureOutput()
    try {
      const code = await runSandbox(
        ["gc", "--apply", "--pause"],
        { fetchSessionStatuses: async () => deadStatuses(), resolveProvider: async () => fake.handle },
      )
      expect(code).toBe(0)
      expect(fake.pauses).toEqual(["sbx_orphan1"])
      expect(fake.stops).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it("--apply --json prints the plan with per-box results", async () => {
    await seedLedger([
      {
        sandboxId: "sbx_orphan1",
        provider: "e2b",
        state: "booted",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        originSessionId: "sess_dead",
      },
    ])
    const fake = makeFakeProvider("sbx_orphan1")
    const capture = captureOutput()
    try {
      const code = await runSandbox(
        ["gc", "--apply", "--json"],
        { fetchSessionStatuses: async () => deadStatuses(), resolveProvider: async () => fake.handle },
      )
      expect(code).toBe(0)
      const parsed = JSON.parse(capture.stdout.join("")) as {
        applied: boolean
        results: Array<{ sandboxId: string; ok: boolean; action?: string }>
      }
      expect(parsed.applied).toBe(true)
      expect(parsed.results).toHaveLength(1)
      expect(parsed.results[0]).toMatchObject({ sandboxId: "sbx_orphan1", ok: true, action: "stopped" })
      expect(fake.stops).toEqual(["sbx_orphan1"])
    } finally {
      capture.restore()
    }
  })
})