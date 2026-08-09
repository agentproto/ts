import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppRegistry } from "../app-registry.js"

describe("app-registry persistence", () => {
  let dir: string
  let persistPath: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("survives a registry restart: upsert → new registry from same path → app present", async () => {
    dir = await mkdtemp(join(tmpdir(), "app-reg-persist-"))
    persistPath = join(dir, "apps.json")

    const reg1 = createAppRegistry({ persist: true, persistPath })
    reg1.upsertApp({
      appId: "@test/persist-check",
      dir: "/tmp/fake-app",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    })

    // Create a fresh registry from the same path — simulates daemon restart
    const reg2 = createAppRegistry({ persist: true, persistPath })
    const loaded = reg2.getApp("@test/persist-check")
    expect(loaded).toBeDefined()
    expect(loaded!.appId).toBe("@test/persist-check")
    expect(loaded!.dir).toBe("/tmp/fake-app")
  })

  it("does not persist when persist: false", async () => {
    dir = await mkdtemp(join(tmpdir(), "app-reg-nopersist-"))
    persistPath = join(dir, "apps.json")

    const reg1 = createAppRegistry({ persist: false, persistPath })
    reg1.upsertApp({
      appId: "@test/no-persist",
      dir: "/tmp/fake-app",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    })

    // A new registry from the same path should be empty
    const reg2 = createAppRegistry({ persist: true, persistPath })
    expect(reg2.getApp("@test/no-persist")).toBeUndefined()
  })
})
