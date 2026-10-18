/**
 * Sandbox expiry — registry end path.
 *
 * Field evidence (sess_795b8c58 / e39cd4da / 7d29436b / one active session,
 * 2026-10-16): an e2b box reaching its plan lifetime deadline (1h continuous
 * run, Hobby/Base) was classified `crashed`/`error` with NO artifact — even
 * though its work branch was already pushed. A sandbox box dying AT/PAST its
 * known lifetime deadline while idle is expected expiry: the row must end
 * `exited` / `sandbox-expired`, stay lazy-resumable, and never match a
 * restart policy.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry } from "../sessions.js"
import { SandboxBoxExpiredError } from "../sandbox-agent-session-proxy.js"
import type { AgentSessionLike } from "../sessions.js"

/** A live parked session whose transport-death hook the test controls. */
function disconnectableSession(): { session: AgentSessionLike; fireDisconnect: (err: Error) => void } {
  let fire: (err: Error) => void = () => {}
  const session: AgentSessionLike = {
    sessionId: "acp-sbx",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    onDisconnect(listener) {
      fire = listener
    },
  }
  return { session, fireDisconnect: err => fire(err) }
}

describe("sandbox expiry — registry end path", () => {
  let tmp: string
  const registries: ReturnType<typeof createSessionsRegistry>[] = []
  const tmps: string[] = []

  const makeReg = () => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-expiry-"))
    tmps.push(tmp)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    registries.push(reg)
    return reg
  }

  afterEach(() => {
    for (const reg of registries.splice(0)) reg.shutdown()
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("a SessionBoxExpiredError on transport death ends the row exited / sandbox-expired — not crashed", async () => {
    const reg = makeReg()
    const { session, fireDisconnect } = disconnectableSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: session,
      adapterSlug: "fake-cli",
      remote: true,
      sandboxId: "sbx_1",
    })
    expect(desc.status).toBe("running")

    fireDisconnect(
      new SandboxBoxExpiredError(
        'sandbox box for remote session "box_1" reached its 60-minute lifetime deadline while idle — ' +
          "the provider reaped it as scheduled (expected expiry, not a crash).",
      ),
    )

    const ended = reg.get(desc.id)!
    expect(ended.status).toBe("exited")
    expect(ended.endedReason).toBe("sandbox-expired")
    expect(ended.lastError).toMatch(/lifetime deadline.*expected expiry/)
    expect(ended.crashedAt).toBeUndefined()
  })

  it("an ordinary transport close still ends crashed", async () => {
    const reg = makeReg()
    const { session, fireDisconnect } = disconnectableSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: session,
      adapterSlug: "fake-cli",
      remote: true,
      sandboxId: "sbx_1",
    })
    fireDisconnect(new Error("the ACP stream died"))
    const ended = reg.get(desc.id)!
    expect(ended.status).toBe("error")
    expect(ended.endedReason).toBe("crashed")
    // …and the classification is distinguishable — the same `exited` shape
    // would be un-resumable by prompt.
    expect(ended.crashedAt).toBeDefined()
  })

  it("markSandboxExpired is running-only (idempotent): a terminal row is left alone", async () => {
    const reg = makeReg()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: disconnectableSession().session,
      adapterSlug: "fake-cli",
    })
    reg.kill(desc.id)
    const killed = reg.get(desc.id)!
    expect(reg.markSandboxExpired(desc.id, "late expiry notice")).toBe(false)
    expect(reg.get(desc.id)?.status).toBe(killed.status)
  })
})
