/**
 * A restarted or continued session takes over its predecessor's slug.
 *
 * Before: every revival minted `slugify(title || label || adapterSlug)` while
 * the predecessor (still `running` at spawn time, it is stopped only after the
 * spawn) and every older row held the base slug, so a long-lived session ended
 * up at `orchestrator-agent-pm-shopbot-32`. Now `replaces` hands the slug to
 * the new row and the replaced row gives it up, so a slug keeps naming the one
 * live session of the conversation. `resolveSessionRef` is untouched.
 *
 * Covered here: registry spawns, the host restart path, rename carry-over,
 * `agent_start.succeeds` (must NOT transfer), a failing spawn (predecessor
 * keeps its slug), persistence, and the addressing contract. The box restart,
 * the PTY restart and the continue-fresh input have their own cases in
 * session-restart-sandbox / session-restart / session-continue-fresh tests.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  PtyFactory,
  PtyProcess,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { resolveSessionRef } from "../session-ref.js"
import { agentStartInputShape } from "../agent-start-schema.js"

let seq = 0
const fakeSession = (): AgentSessionLike => ({
  sessionId: `acp_slug_${seq++}`,
  // eslint-disable-next-line require-yield
  async *send(): AsyncIterable<AgentStreamEvent> {
    return
  },
  async cancel() {},
  async close() {},
})

const resolver: AgentAdapterResolver = async () => ({
  async startSession() {
    return fakeSession()
  },
  commandPreview: "mock-adapter",
})
const fakePtyFactory: PtyFactory = (): PtyProcess => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})
const restartOpts = {
  forceAgentResume: true,
  loadDefaultsConfig: async () => undefined,
}

const spawn = (
  registry: ReturnType<typeof createSessionsRegistry>,
  extra: Record<string, unknown> = {}
) =>
  registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeSession(),
    adapterSlug: "hermes",
    ...extra,
  })

describe("registry: spawn with `replaces`", () => {
  it("hands the slug to the new row even while the replaced row is still running", () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })
    expect(prev.slug).toBe("pm")
    expect(registry.get(prev.id)!.status).toBe("running")

    const next = spawn(registry, { label: "pm", replaces: prev.id })

    expect(next.slug).toBe("pm")
    expect(registry.get(prev.id)!.slug).toBeUndefined()
  })

  it("keeps the same slug across three successive restarts, with no suffix", () => {
    const registry = createSessionsRegistry({ persist: false })
    let current = spawn(registry, { label: "pm" })
    for (let i = 0; i < 3; i++) {
      current = spawn(registry, { label: "pm", replaces: current.id })
      expect(current.slug).toBe("pm")
    }
    const slugs = registry.list({ includeArchived: true }).map(d => d.slug)
    expect(slugs.filter(s => s === "pm")).toHaveLength(1)
    expect(slugs.some(s => /-\d+$/.test(s ?? ""))).toBe(false)
  })

  it("carries a user-chosen slug (a rename) to the successor", () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })
    registry.renameSession(prev.id, { slug: "chat-pm" })
    expect(registry.get(prev.id)!.slug).toBe("chat-pm")

    const next = spawn(registry, { label: "pm", replaces: prev.id })

    expect(next.slug).toBe("chat-pm")
  })

  it("does NOT transfer on a plain spawn: the predecessor of agent_start.succeeds keeps its slug", () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })

    // `agent_start.succeeds` never sets `replaces` (a position handover, the
    // predecessor stays a live, separately addressable session).
    const successor = spawn(registry, { label: "pm" })

    expect(registry.get(prev.id)!.slug).toBe("pm")
    expect(successor.slug).toBe("pm-2")
    expect(Object.keys(agentStartInputShape)).not.toContain("replaces")
  })

  it("leaves the predecessor's slug intact when the spawn throws", () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })

    expect(() =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: undefined as never,
        adapterSlug: "hermes",
        label: "pm",
        replaces: prev.id,
      })
    ).toThrow()

    expect(registry.get(prev.id)!.slug).toBe("pm")
  })

  it("still de-duplicates unrelated sessions that share a label", () => {
    const registry = createSessionsRegistry({ persist: false })
    const a = spawn(registry, { label: "pm" })
    const b = spawn(registry, { label: "pm" })
    expect(a.slug).toBe("pm")
    expect(b.slug).toBe("pm-2")
  })

  it("mints normally when `replaces` names a row without a slug or an unknown row", () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })
    registry.renameSession(prev.id, { slug: null })

    const fromSlugless = spawn(registry, { label: "pm", replaces: prev.id })
    const fromUnknown = spawn(registry, {
      label: "other",
      replaces: "sess_does_not_exist",
    })

    expect(fromSlugless.slug).toBe("pm")
    expect(fromUnknown.slug).toBe("other")
  })

  it("transfers for a PTY spawn too, while the replaced PTY is still alive", () => {
    const registry = createSessionsRegistry({
      persist: false,
      spawnPty: fakePtyFactory,
    })
    const prev = registry.spawnPty({
      argv: ["bash"],
      cwd: process.cwd(),
      workspaceSlug: "default",
      cols: 80,
      rows: 24,
      name: "dev-shell",
    })
    expect(prev.slug).toBe("dev-shell")
    expect(registry.get(prev.id)!.status).toBe("running")

    const next = registry.spawnPty({
      argv: ["bash"],
      cwd: process.cwd(),
      workspaceSlug: "default",
      cols: 80,
      rows: 24,
      replaces: prev.id,
    })

    expect(next.slug).toBe("dev-shell")
    expect(registry.get(prev.id)!.slug).toBeUndefined()
    registry.kill(prev.id)
    registry.kill(next.id)
    registry.shutdown()
  })
})

describe("restartAgentSession keeps the slug (host path, predecessor alive)", () => {
  it("three restarts in a row leave one row holding the base slug", async () => {
    const registry = createSessionsRegistry({ persist: false })
    let current = spawn(registry, { label: "pm" })
    const chain = [current.id]
    for (let i = 0; i < 3; i++) {
      const restarted = await restartAgentSession(
        registry,
        resolver,
        registry.get(current.id)!,
        restartOpts
      )
      current = restarted.desc
      chain.push(current.id)
      expect(current.slug).toBe("pm")
    }
    const holders = chain.filter(id => registry.get(id)?.slug === "pm")
    expect(holders).toEqual([current.id])
    registry.shutdown()
  })

  it("a renamed slug survives a restart", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })
    registry.renameSession(prev.id, { slug: "chat-pm" })

    const restarted = await restartAgentSession(
      registry,
      resolver,
      registry.get(prev.id)!,
      restartOpts
    )

    expect(restarted.desc.slug).toBe("chat-pm")
    registry.shutdown()
  })
})

describe("addressing after a restart (resolveSessionRef is unchanged)", () => {
  it("the slug names the successor; the predecessor stays addressable by id", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawn(registry, { label: "pm" })
    const restarted = await restartAgentSession(
      registry,
      resolver,
      registry.get(prev.id)!,
      restartOpts
    )

    expect(resolveSessionRef(registry, { slug: "pm" })).toEqual({
      ok: true,
      id: restarted.desc.id,
    })
    expect(resolveSessionRef(registry, { sessionId: prev.id })).toEqual({
      ok: true,
      id: prev.id,
    })
    registry.shutdown()
  })
})

describe("persistence", () => {
  it("the transferred slug survives a daemon restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "slug-replaces-"))
    const persistPath = join(dir, "sessions.json")
    try {
      const first = createSessionsRegistry({ persistPath })
      const prev = spawn(first, { label: "pm" })
      const next = spawn(first, { label: "pm", replaces: prev.id })
      first.shutdown()

      const reloaded = createSessionsRegistry({ persistPath })
      expect(reloaded.get(next.id)?.slug).toBe("pm")
      expect(reloaded.get(prev.id)?.slug).not.toBe("pm")
      reloaded.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
