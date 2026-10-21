/**
 * Unit tests for the service-owner launcher (app-services.ts) — the frozen
 * `services:` semantics (parse/validate), the owner-record bookkeeping store,
 * the idempotent `ensureAppServiceOwners` / `removeAppServiceOwners`
 * orchestration, and the pid-kill primitive. No spawn, no MCP server: every
 * seam (spawn, kill, liveness, clock) is injected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAppServiceStore,
  ensureAppServiceOwners,
  killServicePid,
  parseAppServices,
  reensureAppServiceOwners,
  removeAppServiceOwners,
  serviceDisplayEntry,
  serviceOwnerLabel,
  type AppServiceOwner,
} from "../app-services.js"

describe("parseAppServices (frozen semantics)", () => {
  it("absent block is the no-op case", () => {
    expect(parseAppServices(undefined)).toEqual({ services: [], errors: [] })
    expect(parseAppServices(null)).toEqual({ services: [], errors: [] })
  })

  it("parses name/entry/port entries", () => {
    const { services, errors } = parseAppServices([
      { name: "web", entry: "node server.js", port: 4321 },
      { name: "worker", entry: "node worker.js" },
    ])
    expect(errors).toEqual([])
    expect(services).toEqual([
      { name: "web", entry: "node server.js", port: 4321 },
      { name: "worker", entry: "node worker.js" },
    ])
  })

  it("rejects a non-array block", () => {
    expect(parseAppServices({ name: "web" }).errors).toHaveLength(1)
  })

  it("rejects an explicitly-present but empty services array (no longer a no-op)", () => {
    const { services, errors } = parseAppServices([])
    expect(services).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("at least one service")
  })

  it("rejects a non-kebab name starting with an uppercase letter", () => {
    const { errors } = parseAppServices([{ name: "Web", entry: "node server.js" }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("kebab-case slug")
  })

  it("rejects a name starting with a digit (now requires a leading letter)", () => {
    const { errors } = parseAppServices([{ name: "0abc", entry: "node server.js" }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("kebab-case slug")
  })

  it("accepts a name with consecutive/trailing hyphens (leading letter is the only constraint)", () => {
    const { services, errors } = parseAppServices([{ name: "a--b", entry: "node server.js" }])
    expect(errors).toEqual([])
    expect(services).toEqual([{ name: "a--b", entry: "node server.js" }])
  })

  it("rejects an empty entry", () => {
    const { errors } = parseAppServices([{ name: "web", entry: "   " }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("non-empty shell command")
  })

  it("rejects a bad port (too high, zero, or non-integer)", () => {
    expect(parseAppServices([{ name: "api", entry: "node api.js", port: 70000 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseAppServices([{ name: "zero", entry: "node z.js", port: 0 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseAppServices([{ name: "frac", entry: "node f.js", port: 1.5 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseAppServices([{ name: "str", entry: "node s.js", port: "4321" as unknown as number }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
  })

  it("rejects duplicate names", () => {
    const { errors } = parseAppServices([
      { name: "web", entry: "a" },
      { name: "web", entry: "b" },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("unique")
  })

  it("rejects an unknown object field", () => {
    const { errors } = parseAppServices([{ name: "web", entry: "a", extra: 1 } as unknown as object])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("not a supported service field")
  })

  it("accepts the structured { command, args, cwd } form (preferred) and keeps legacy entry", () => {
    const { services, errors } = parseAppServices([
      { name: "web", command: "node", args: ["server.js"], cwd: "server", port: 4321 },
      { name: "legacy", entry: "node server.js" },
    ])
    expect(errors).toEqual([])
    expect(services).toEqual([
      { name: "web", command: "node", args: ["server.js"], cwd: "server", port: 4321 },
      { name: "legacy", entry: "node server.js" },
    ])
  })

  it("rejects entry + command together, and either field missing", () => {
    expect(parseAppServices([{ name: "web", entry: "a", command: "b" }]).errors).toHaveLength(1)
    expect(parseAppServices([{ name: "web" }]).errors).toHaveLength(1)
  })

  it("rejects args without command, and a bad args/cwd shape", () => {
    expect(parseAppServices([{ name: "web", entry: "a", args: ["x"] }]).errors).toHaveLength(1)
    expect(parseAppServices([{ name: "web", command: "node", args: [] }]).errors).toHaveLength(1)
    expect(parseAppServices([{ name: "web", command: "node", args: [1] }]).errors).toHaveLength(1)
    expect(parseAppServices([{ name: "web", command: "node", cwd: "" }]).errors).toHaveLength(1)
  })

  it("fails fast on the first bad entry — does not accumulate every entry's error", () => {
    const { errors } = parseAppServices([
      { name: "Bad", entry: "x" },
      { name: "also-bad", entry: "" },
    ])
    expect(errors).toHaveLength(1)
  })
})

describe("createAppServiceStore", () => {
  let base: string
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "app-services-store-"))
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const owner = (appId: string, name: string, pid?: number): AppServiceOwner => ({
    appId,
    name,
    entry: `run ${name}`,
    sessionId: `sess_${name}`,
    ...(pid !== undefined ? { pid } : {}),
    startedAt: "2026-01-01T00:00:00.000Z",
  })

  it("persists owners and reloads them from disk", () => {
    const path = join(base, "app-services.json")
    createAppServiceStore({ persistPath: path }).upsert(owner("@a/app", "web", 111))
    const reloaded = createAppServiceStore({ persistPath: path })
    expect(reloaded.listForApp("@a/app")).toEqual([owner("@a/app", "web", 111)])
  })

  it("upserts by appId + name (no duplicate) and removes per app", () => {
    const store = createAppServiceStore({ persist: false })
    store.upsert(owner("@a/app", "web", 1))
    store.upsert(owner("@a/app", "web", 2))
    store.upsert(owner("@a/app", "worker", 3))
    expect(store.list()).toHaveLength(2)
    expect(store.listForApp("@a/app").find(o => o.name === "web")?.pid).toBe(2)
    expect(store.removeForApp("@a/app")).toBe(2)
    expect(store.list()).toHaveLength(0)
  })

  it("a non-persisting store never touches disk", () => {
    const store = createAppServiceStore({ persist: false })
    store.upsert(owner("@a/app", "web"))
    expect(store.list()).toHaveLength(1)
  })
})

describe("ensureAppServiceOwners", () => {
  const svc = (name: string) => ({ name, entry: `run ${name}` })
  const fixedNow = () => new Date("2026-02-02T03:04:05.000Z")

  it("spawns one owner per service and records the full owner shape", async () => {
    const store = createAppServiceStore({ persist: false })
    const spawn = vi.fn(async (service: { name: string }) => ({
      ok: true as const,
      sessionId: `sess_${service.name}`,
      pid: 4242,
    }))
    const result = await ensureAppServiceOwners({
      store,
      appId: "@a/app",
      services: [svc("web"), { name: "worker", entry: "run worker", port: 8080 }],
      isOwnerAlive: () => false,
      spawn,
      killOwner: () => {},
      now: fixedNow,
    })
    expect(result.errors).toEqual([])
    expect(result.kept).toEqual([])
    expect(result.spawned.map(o => o.name)).toEqual(["web", "worker"])
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(store.listForApp("@a/app")).toEqual([
      {
        appId: "@a/app",
        name: "web",
        entry: "run web",
        sessionId: "sess_web",
        pid: 4242,
        startedAt: "2026-02-02T03:04:05.000Z",
      },
      {
        appId: "@a/app",
        name: "worker",
        entry: "run worker",
        sessionId: "sess_worker",
        pid: 4242,
        port: 8080,
        startedAt: "2026-02-02T03:04:05.000Z",
      },
    ])
  })

  it("keeps a live owner (idempotent — no duplicate spawn)", async () => {
    const store = createAppServiceStore({ persist: false })
    const existing: AppServiceOwner = {
      appId: "@a/app",
      name: "web",
      entry: "run web",
      sessionId: "sess_web",
      pid: 9,
      startedAt: "2026-01-01T00:00:00.000Z",
    }
    store.upsert(existing)
    const spawn = vi.fn()
    const killOwner = vi.fn()
    const result = await ensureAppServiceOwners({
      store,
      appId: "@a/app",
      services: [svc("web")],
      isOwnerAlive: () => true,
      spawn,
      killOwner,
    })
    expect(result.kept).toEqual([existing])
    expect(result.spawned).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(killOwner).not.toHaveBeenCalled()
    expect(store.listForApp("@a/app")).toEqual([existing])
  })

  it("replaces a dead owner: kills it, then spawns fresh", async () => {
    const store = createAppServiceStore({ persist: false })
    const dead: AppServiceOwner = {
      appId: "@a/app",
      name: "web",
      entry: "run web",
      sessionId: "sess_dead",
      pid: 7,
      startedAt: "2026-01-01T00:00:00.000Z",
    }
    store.upsert(dead)
    const killOwner = vi.fn()
    const spawn = vi.fn(async () => ({ ok: true as const, sessionId: "sess_new", pid: 8 }))
    const result = await ensureAppServiceOwners({
      store,
      appId: "@a/app",
      services: [svc("web")],
      isOwnerAlive: () => false,
      spawn,
      killOwner,
      now: fixedNow,
    })
    expect(killOwner).toHaveBeenCalledWith(dead)
    expect(result.spawned).toHaveLength(1)
    expect(store.listForApp("@a/app")).toHaveLength(1)
    expect(store.listForApp("@a/app")[0]!.sessionId).toBe("sess_new")
  })

  it("collects a spawn failure without throwing", async () => {
    const store = createAppServiceStore({ persist: false })
    const result = await ensureAppServiceOwners({
      store,
      appId: "@a/app",
      services: [svc("web")],
      isOwnerAlive: () => false,
      spawn: async () => ({ ok: false as const, error: "adapter_not_found" }),
      killOwner: () => {},
    })
    expect(result.spawned).toEqual([])
    expect(result.errors).toEqual([{ name: "web", error: "adapter_not_found" }])
    expect(store.listForApp("@a/app")).toEqual([])
  })
})

describe("removeAppServiceOwners", () => {
  it("kills every owner and drops the records", async () => {
    const store = createAppServiceStore({ persist: false })
    const owners: AppServiceOwner[] = ["web", "worker"].map(name => ({
      appId: "@a/app",
      name,
      entry: `run ${name}`,
      sessionId: `sess_${name}`,
      pid: name === "web" ? 10 : 11,
      startedAt: "2026-01-01T00:00:00.000Z",
    }))
    owners.forEach(o => store.upsert(o))
    store.upsert({ ...owners[0]!, appId: "@other/app", sessionId: "sess_other" })
    const killOwner = vi.fn()
    const removed = await removeAppServiceOwners({ store, appId: "@a/app", killOwner })
    expect(removed).toEqual(["web", "worker"])
    expect(killOwner).toHaveBeenCalledTimes(2)
    expect(store.listForApp("@a/app")).toEqual([])
    expect(store.listForApp("@other/app")).toHaveLength(1)
  })
})

describe("killServicePid", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("SIGTERMs a positive integer pid", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    killServicePid(1234)
    expect(kill).toHaveBeenCalledWith(1234, "SIGTERM")
  })

  it("no-ops on undefined / zero / negative / non-integer", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    killServicePid(undefined)
    killServicePid(0)
    killServicePid(-5)
    killServicePid(1.5)
    expect(kill).not.toHaveBeenCalled()
  })

  it("swallows ESRCH (already gone)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException
      err.code = "ESRCH"
      throw err
    })
    expect(() => killServicePid(999)).not.toThrow()
  })
})

describe("reensureAppServiceOwners (boot)", () => {
  const svc = (name: string) => ({ name, entry: `run ${name}` })

  it("force-replaces every owner (never keeps a live one)", async () => {
    const store = createAppServiceStore({ persist: false })
    store.upsert({
      appId: "@a/app",
      name: "web",
      entry: "run web",
      sessionId: "old_web",
      pid: 9,
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const killOwner = vi.fn()
    const spawn = vi.fn(async (s: { name: string }) => ({
      ok: true as const,
      sessionId: `new_${s.name}`,
      pid: 1234,
    }))
    const result = await reensureAppServiceOwners({
      store,
      appId: "@a/app",
      services: [svc("web"), svc("worker")],
      spawn,
      killOwner,
    })
    // The pre-boot owner is killed even though a liveness check might call it
    // alive — force never keeps.
    expect(killOwner).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "@a/app", name: "web", sessionId: "old_web" }),
    )
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(result.kept).toEqual([])
    expect(result.spawned.map(o => o.sessionId).sort()).toEqual(["new_web", "new_worker"])
    expect(store.listForApp("@a/app").map(o => o.sessionId).sort()).toEqual(["new_web", "new_worker"])
  })
})

describe("serviceDisplayEntry / label", () => {
  it("joins the structured command argv; passes legacy entry through", () => {
    expect(serviceDisplayEntry({ name: "web", command: "node", args: ["server.js", "--port", "4321"] })).toBe(
      "node server.js --port 4321",
    )
    expect(serviceDisplayEntry({ name: "web", entry: "node server.js" })).toBe("node server.js")
  })

  it("label encodes the app id and service name", () => {
    expect(serviceOwnerLabel("@a/app", "web")).toBe("app:@a/app:service:web")
  })
})
