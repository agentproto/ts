/**
 * PLAN-D1 — the sandbox ledger (`~/.agentproto/sandboxes.json`).
 *
 * Everything here runs against a per-test tmp ledger path — the real
 * `~/.agentproto/sandboxes.json` is off-limits (same rule every other
 * store test in this suite follows). Covers: round-trip + upsert dedup,
 * corrupt-file degradation, the never-throw contract of every helper, the
 * proxy close() → paused/stopped stamps, and the `reuse` label/prefix
 * resolution including the ambiguous case.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSandboxAgentSessionProxy,
} from "../sandbox-agent-session-proxy.js"
import {
  readSandboxLedger,
  recordSandboxBoot,
  recordSandboxOrigin,
  recordSandboxState,
  removeSandboxLedgerEntry,
  resolveReuseFromLedger,
  sandboxLedgerPath,
  type SandboxLedgerEntry,
} from "../sandbox-ledger.js"

const tmps: string[] = []

afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.AGENTPROTO_SANDBOX_LEDGER
})

const newLedgerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-ledger-"))
  tmps.push(dir)
  return join(dir, "sandboxes.json")
}

const entry = (overrides: Partial<SandboxLedgerEntry>): SandboxLedgerEntry => ({
  sandboxId: "bx_abc123",
  provider: "box",
  state: "booted",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  ...overrides,
})

describe("sandbox ledger", () => {
  it("round-trips an upsert and dedups by sandboxId", () => {
    const path = newLedgerPath()
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "booted", path })
    recordSandboxBoot({ sandboxId: "bx_2", provider: "e2b", state: "booted", path })
    // Re-boot the same id (a reconnect) — upsert, not a second row.
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "connected", path })
    const rows = readSandboxLedger(path)
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.sandboxId === "bx_1")?.state).toBe("connected")
    expect(rows.find(r => r.sandboxId === "bx_2")?.provider).toBe("e2b")
  })

  it("preserves createdAt and label across a reconnect", () => {
    const path = newLedgerPath()
    recordSandboxBoot({
      sandboxId: "bx_1",
      provider: "box",
      state: "booted",
      label: "my-task",
      path,
    })
    const first = readSandboxLedger(path)[0]
    expect(first).toBeDefined()
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "connected", path })
    const second = readSandboxLedger(path)[0]
    expect(second).toBeDefined()
    expect(second?.createdAt).toBe(first?.createdAt)
    expect(second?.label).toBe("my-task")
    expect(second?.state).toBe("connected")
  })

  it("stamps expiresAt when the boot knew an idle window", () => {
    const path = newLedgerPath()
    recordSandboxBoot({
      sandboxId: "bx_1",
      provider: "box",
      state: "booted",
      expiresAt: "2026-09-08T01:00:00.000Z",
      path,
    })
    expect(readSandboxLedger(path)[0]?.expiresAt).toBe("2026-09-08T01:00:00.000Z")
  })

  it("backfills originSessionId without disturbing the row", () => {
    const path = newLedgerPath()
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "booted", path })
    recordSandboxOrigin("bx_1", "sess_42", path)
    const row = readSandboxLedger(path)[0]
    expect(row).toBeDefined()
    expect(row?.originSessionId).toBe("sess_42")
    expect(row?.state).toBe("booted")
    // No row — a no-op, not a phantom insert.
    recordSandboxOrigin("bx_ghost", "sess_42", path)
    expect(readSandboxLedger(path)).toHaveLength(1)
  })

  it("transitions to paused/stopped and removes entries", () => {
    const path = newLedgerPath()
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "booted", path })
    recordSandboxState("bx_1", "paused", path)
    expect(readSandboxLedger(path)[0]?.state).toBe("paused")
    // Transition for an unknown id is a silent no-op.
    recordSandboxState("bx_ghost", "stopped", path)
    expect(readSandboxLedger(path)).toHaveLength(1)
    expect(removeSandboxLedgerEntry("bx_1", path)).toBe(true)
    expect(removeSandboxLedgerEntry("bx_1", path)).toBe(false)
    expect(readSandboxLedger(path)).toHaveLength(0)
  })

  it("degrades a missing or corrupt file to [] and never throws", () => {
    const missing = newLedgerPath()
    expect(readSandboxLedger(missing)).toEqual([])
    const corrupt = newLedgerPath()
    writeFileSync(corrupt, "{ not json", "utf8")
    expect(readSandboxLedger(corrupt)).toEqual([])
    // Every writer on a corrupt base still succeeds (read degrades to []
    // and the upsert proceeds).
    recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "booted", path: corrupt })
    expect(readSandboxLedger(corrupt)).toHaveLength(1)
  })

  it("drops malformed rows on read instead of throwing", () => {
    const path = newLedgerPath()
    writeFileSync(
      path,
      JSON.stringify({
        savedAt: "2026-09-08T00:00:00.000Z",
        sandboxes: [
          entry({ sandboxId: "bx_ok" }),
          { sandboxId: "no-provider" },
          "not-an-object",
          { sandboxId: "bx_bad_state", provider: "box", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", state: "somewhere-else" },
        ],
      }),
      "utf8",
    )
    const rows = readSandboxLedger(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sandboxId).toBe("bx_ok")
  })

  it("unwritable ledger path never throws a writer", () => {
    // A path inside a non-existent FILE (not dir) fails mkdir — the
    // best-effort contract says swallow, not throw.
    const dir = mkdtempSync(join(tmpdir(), "sandbox-ledger-"))
    tmps.push(dir)
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "not a dir", "utf8")
    const path = join(blocker, "sandboxes.json")
    expect(() =>
      recordSandboxBoot({ sandboxId: "bx_1", provider: "box", state: "booted", path }),
    ).not.toThrow()
  })
})

describe("reuse resolution (PLAN-D1 §3)", () => {
  const entries: SandboxLedgerEntry[] = [
    entry({ sandboxId: "bx_alpha01", label: "review-task" }),
    entry({ sandboxId: "bx_alpha02" }),
    entry({ sandboxId: "e2b_xyz", provider: "e2b" }),
  ]

  it("resolves an exact label", () => {
    const r = resolveReuseFromLedger("review-task", entries)
    expect(r).toMatchObject({ kind: "resolved", sandboxId: "bx_alpha01" })
  })

  it("resolves a unique id prefix", () => {
    const r = resolveReuseFromLedger("e2b_xy", entries)
    expect(r).toMatchObject({ kind: "resolved", sandboxId: "e2b_xyz" })
  })

  it("reports ambiguity with every candidate", () => {
    const r = resolveReuseFromLedger("bx_alpha", entries)
    expect(r.kind).toBe("ambiguous")
    if (r.kind !== "ambiguous") return
    expect(r.candidates.map(c => c.sandboxId).sort()).toEqual(["bx_alpha01", "bx_alpha02"])
  })

  it("passes an unknown token through unresolved (provider error unchanged)", () => {
    expect(resolveReuseFromLedger("bx_nope", entries)).toEqual({ kind: "unresolved" })
  })
})

describe("proxy close() stamps the ledger (PLAN-D1 §1)", () => {
  it("records 'paused' when the lifecycle policy pauses, 'stopped' on kill", async () => {
    const paused = newLedgerPath()
    process.env.AGENTPROTO_SANDBOX_LEDGER = paused
    recordSandboxBoot({ sandboxId: "bx_p", provider: "box", state: "booted" })
    recordSandboxBoot({ sandboxId: "bx_k", provider: "box", state: "booted" })

    const makeHost = () => ({
      prompt: vi.fn(async () => {}),
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async (_ids: string[], _opts?: { timeoutMs?: number; since?: number }) => ({ timedOut: true })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      mcpUrl: "http://127.0.0.1:9/mcp",
    })

    const pauseHost = makeHost()
    const pauseProxy = createSandboxAgentSessionProxy({
      host: pauseHost,
      remoteSessionId: "remote_1",
      lifecyclePolicy: { teardown: "pause" },
      ledger: { sandboxId: "bx_p", provider: "box" },
    })
    await pauseProxy.close()
    expect(pauseHost.pause).toHaveBeenCalledTimes(1)
    expect(readSandboxLedger(paused).find(r => r.sandboxId === "bx_p")?.state).toBe("paused")

    const killHost = makeHost()
    const killProxy = createSandboxAgentSessionProxy({
      host: killHost,
      remoteSessionId: "remote_2",
      lifecyclePolicy: { teardown: "kill" },
      ledger: { sandboxId: "bx_k", provider: "box" },
    })
    await killProxy.close()
    expect(killHost.stop).toHaveBeenCalledTimes(1)
    expect(readSandboxLedger(paused).find(r => r.sandboxId === "bx_k")?.state).toBe("stopped")
  })

  it("a teardown that throws still stamps the ledger", async () => {
    const path = newLedgerPath()
    process.env.AGENTPROTO_SANDBOX_LEDGER = path
    recordSandboxBoot({ sandboxId: "bx_e", provider: "box", state: "booted" })

    const proxy = createSandboxAgentSessionProxy({
      host: {
        prompt: vi.fn(async () => {}),
        output: vi.fn(async () => ""),
        kill: vi.fn(async () => {}),
        waitForAny: vi.fn(async (_ids: string[], _opts?: { timeoutMs?: number; since?: number }) => ({ timedOut: true })),
        currentEventsCursor: vi.fn(async () => 0),
        stop: vi.fn(async () => {
          throw new Error("box already gone")
        }),
        mcpUrl: "http://127.0.0.1:9/mcp",
      },
      remoteSessionId: "remote_3",
      ledger: { sandboxId: "bx_e", provider: "box" },
    })
    await expect(proxy.close()).rejects.toThrow("box already gone")
    expect(readSandboxLedger(path)[0]?.state).toBe("stopped")
  })
})
