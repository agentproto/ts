/**
 * WP-B1 — the unique human `slug` on every session (session-addressing PLAN
 * §2/§4): `spawnAgent`/`spawnPty` mint one via the shared `mintSlug`, a
 * restored descriptor without one is lazily backfilled (idempotently, never
 * overwriting), `renameSession` accepts an override, and the deprecated
 * `name` still resolves through the `slug ?? name` alias.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  getSlug,
  type AgentSessionLike,
  type PtyFactory,
  type PtyProcess,
} from "../sessions.js"

const fakeAgent = (sessionId: string): AgentSessionLike => ({
  sessionId,
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
})

const fakePtyFactory: PtyFactory = (): PtyProcess => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

describe("session slug", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-slug-test-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawnAgent = (
    reg: ReturnType<typeof createSessionsRegistry>,
    label?: string,
  ) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent(`acp-${Math.random().toString(36).slice(2)}`),
      adapterSlug: "fake",
      ...(label !== undefined ? { label } : {}),
    })

  const spawnPty = (
    reg: ReturnType<typeof createSessionsRegistry>,
    name?: string,
  ) =>
    reg.spawnPty({
      workspaceSlug: "default",
      cwd: "/tmp",
      argv: ["bash"],
      cols: 80,
      rows: 24,
      ...(name !== undefined ? { name } : {}),
    })

  it("gives every agent spawn a non-empty slug", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(spawnAgent(reg).slug).toBe("fake")
    reg.shutdown()
  })

  it("de-duplicates two identical labels as slug-2", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const a = spawnAgent(reg, "my-agent")
    const b = spawnAgent(reg, "my-agent")
    expect(a.slug).toBe("my-agent")
    expect(b.slug).toBe("my-agent-2")
    reg.shutdown()
  })

  it("mints a terminal slug from the legacy name and never writes `name`", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false, spawnPty: fakePtyFactory })
    const a = spawnPty(reg, "dev-shell")
    const b = spawnPty(reg, "dev-shell")
    expect(a.slug).toBe("dev-shell")
    expect(b.slug).toBe("dev-shell-2")
    // `name` is a read-only legacy alias now — new writes set `slug` only.
    expect(a.name).toBeUndefined()
    expect(b.name).toBeUndefined()
    reg.shutdown()
  })

  it("resolves a spawned session by its slug via findByIdOrName", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnAgent(reg, "addressable")
    expect(reg.findByIdOrName("addressable")?.id).toBe(desc.id)
    reg.shutdown()
  })

  it("reuses a dead terminal's handle so stop X && terminal --name X round-trips", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false, spawnPty: fakePtyFactory })
    const first = spawnPty(reg, "dev-shell")
    expect(first.slug).toBe("dev-shell")
    reg.kill(first.id)
    expect(reg.get(first.id)?.status).toBe("killed")

    const second = spawnPty(reg, "dev-shell")
    expect(second.slug).toBe("dev-shell")
    expect(reg.findByIdOrName("dev-shell")?.id).toBe(second.id)
    reg.shutdown()
  })

  it("honours a slug override via renameSession and keeps it unique", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnAgent(reg, "original")
    const renamed = reg.renameSession(desc.id, { slug: "custom-handle" })
    expect(renamed.slug).toBe("custom-handle")
    expect(renamed.renamedByUser).toBe(false) // a slug-only write never flips the display flag
    expect(reg.findByIdOrName("custom-handle")?.id).toBe(desc.id)

    const other = spawnAgent(reg, "other")
    expect(reg.renameSession(other.id, { slug: "custom-handle" }).slug).toBe("custom-handle-2")
    reg.shutdown()
  })

  it("persists a slug override across a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = spawnAgent(reg1, "original")
    reg1.renameSession(desc.id, { slug: "durable-handle" })
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.slug).toBe("durable-handle")
    reg2.shutdown()
  })

  it("getSlug falls back to the legacy `name` when no slug exists", () => {
    expect(getSlug({ name: "legacy-name" })).toBe("legacy-name")
    expect(getSlug({ slug: "modern", name: "legacy-name" })).toBe("modern")
    expect(getSlug({})).toBeUndefined()
  })

  describe("lazy backfill on load", () => {
    const legacyRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "sess_legacy0001",
      kind: "agent-cli",
      workspaceSlug: "default",
      command: "claude (agent)",
      pid: null,
      status: "exited",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      ...over,
    })

    const writeSnapshot = (sessions: unknown[]): void =>
      writeFileSync(persistPath, JSON.stringify({ savedAt: new Date().toISOString(), sessions }, null, 2))

    it("mints and persists a slug for a descriptor that predates the field", () => {
      writeSnapshot([legacyRow({ label: "Legacy One" })])
      const reg = createSessionsRegistry({ persistPath })
      expect(reg.get("sess_legacy0001")?.slug).toBe("legacy-one")
      reg.shutdown() // forces the debounced persist to flush

      const onDisk = JSON.parse(readFileSync(persistPath, "utf8")) as {
        sessions: Array<{ id: string; slug?: string }>
      }
      expect(onDisk.sessions.find(s => s.id === "sess_legacy0001")?.slug).toBe("legacy-one")
    })

    it("is idempotent across reloads", () => {
      writeSnapshot([legacyRow({ label: "Stable" })])
      const reg1 = createSessionsRegistry({ persistPath })
      const first = reg1.get("sess_legacy0001")?.slug
      reg1.shutdown()

      const reg2 = createSessionsRegistry({ persistPath })
      expect(reg2.get("sess_legacy0001")?.slug).toBe(first)
      reg2.shutdown()
    })

    it("never overwrites an existing slug", () => {
      writeSnapshot([legacyRow({ slug: "keep-me" })])
      const reg = createSessionsRegistry({ persistPath })
      expect(reg.get("sess_legacy0001")?.slug).toBe("keep-me")
      reg.shutdown()
    })

    it("de-duplicates two restored rows sharing a derived slug", () => {
      writeSnapshot([
        legacyRow({ id: "sess_legacy0001", label: "Twins" }),
        legacyRow({ id: "sess_legacy0002", label: "Twins" }),
      ])
      const reg = createSessionsRegistry({ persistPath })
      const slips = [reg.get("sess_legacy0001")?.slug, reg.get("sess_legacy0002")?.slug]
      expect(new Set(slips)).toEqual(new Set(["twins", "twins-2"]))
      reg.shutdown()
    })

    it("keeps a legacy `name` resolvable after backfill adds a slug", () => {
      writeSnapshot([legacyRow({ name: "old-handle" })])
      const reg = createSessionsRegistry({ persistPath })
      // Backfill prefers the existing handle, so the canonical slug matches it.
      expect(reg.get("sess_legacy0001")?.slug).toBe("old-handle")
      expect(reg.findByIdOrName("old-handle")?.id).toBe("sess_legacy0001")
      reg.shutdown()
    })
  })
})
