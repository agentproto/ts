/**
 * Unit tests for the registry-level `setKeepAlive` (sessions.ts) — the
 * write-path behind the `session_set_keepalive` MCP verb. Covers set/clear
 * and persistence across a reload; the reaper-exemption POLICY itself
 * (`isReapable`) is covered separately in idle-reaper.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-keepalive-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("setKeepAlive", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-keepalive-test-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawn = (reg: ReturnType<typeof createSessionsRegistry>) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })

  it("is absent by default", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    expect(desc.keepAlive).toBeUndefined()
    reg.shutdown()
  })

  it("sets keepAlive true", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    const updated = reg.setKeepAlive(desc.id, true)
    expect(updated.keepAlive).toBe(true)
    expect(reg.get(desc.id)?.keepAlive).toBe(true)
    reg.shutdown()
  })

  it("clears keepAlive back to false", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.setKeepAlive(desc.id, true)
    const cleared = reg.setKeepAlive(desc.id, false)
    expect(cleared.keepAlive).toBe(false)
    reg.shutdown()
  })

  it("throws on an unknown session id", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(() => reg.setKeepAlive("sess_nope", true)).toThrow(/no session/)
    reg.shutdown()
  })

  it("persists across a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = spawn(reg1)
    reg1.setKeepAlive(desc.id, true)
    reg1.shutdown() // forces a synchronous flush (persist is debounced)

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.keepAlive).toBe(true)
    reg2.shutdown()
  })
})
