import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { BrowserProfileRefusedError, defaultChromeUserDataDirs } from "@agentproto/driver-browser"
import { createChromeProvider } from "../index.js"

const root = mkdtempSync(join(tmpdir(), "chrome-grants-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const REACHED_SPAWN = "reached-spawn"

describe("full-profile unlock", () => {
  const spawnedWith: string[][] = []
  const provider = createChromeProvider({
    dataDir: join(root, "data"),
    findChrome: () => "/nonexistent/chrome",
    spawn: (_bin, args) => {
      spawnedWith.push([...args])
      throw new Error(REACHED_SPAWN)
    },
  })
  const proof = (active: boolean) => ({ grantId: "grant_1", isActive: () => active })

  it("refuses fullProfile without a grant or with an inactive one, before spawning", async () => {
    await expect(provider.launch({ label: "fp", fullProfile: true }, {})).rejects.toBeInstanceOf(BrowserProfileRefusedError)
    await expect(provider.launch({ label: "fp", fullProfile: true, fullProfileGrant: proof(false) }, {})).rejects.toBeInstanceOf(
      BrowserProfileRefusedError,
    )
    expect(spawnedWith).toEqual([])
  })

  it("spawns on a fresh dedicated dir, never a default one, with an active grant", async () => {
    await expect(provider.launch({ label: "fp-ok", fullProfile: true, fullProfileGrant: proof(true) }, {})).rejects.toThrow(REACHED_SPAWN)
    expect(spawnedWith).toHaveLength(1)
    const dirs = (spawnedWith[0] ?? []).filter(a => a.startsWith("--user-data-dir="))
    expect(dirs).toHaveLength(1)
    const dir = (dirs[0] as string).slice("--user-data-dir=".length)
    expect(dir).toContain(join("profiles", "fp-ok"))
    for (const d of defaultChromeUserDataDirs()) expect(dir.startsWith(d)).toBe(false)
  })

  it("still refuses the default user-data-dir with an active grant", async () => {
    const real = defaultChromeUserDataDirs()[0] as string
    const before = spawnedWith.length
    const err = await provider
      .launch({ label: "x", fullProfile: true, fullProfileGrant: proof(true), userDataDir: real }, {})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserProfileRefusedError)
    expect((err as BrowserProfileRefusedError).reason).toBe("default-user-data-dir")
    expect(spawnedWith).toHaveLength(before)
  })
})
