/**
 * End-to-end mount → override → extend → whiteout-remove cycle, over real
 * disk directories shaped like a standalone app's layout:
 *   <appDir>/packs/<id>/entries/**   — the global pack, read-only
 *   <dataDir>/knowledge/entries/**   — the local override layer, writable
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WHITEOUT_SUFFIX } from "@agentproto/corpus"
import { DiskFs } from "../disk-fs.js"
import { packFs } from "../pack-fs.js"
import { mountCascade } from "../mount-cascade.js"

describe("cascade cycle: mount -> override -> extend -> whiteout-remove", () => {
  let appDir: string
  let dataDir: string

  beforeEach(async () => {
    appDir = await mkdtemp(path.join(tmpdir(), "knowledge-cascade-app-"))
    dataDir = await mkdtemp(path.join(tmpdir(), "knowledge-cascade-data-"))

    const packEntries = path.join(appDir, "packs", "core", "entries")
    await mkdir(packEntries, { recursive: true })
    await writeFile(path.join(packEntries, "greeting.md"), "PACK: hello")
    await writeFile(path.join(packEntries, "policy.md"), "PACK: policy v1")

    await mkdir(path.join(dataDir, "knowledge"), { recursive: true })
  })

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  function mount() {
    const globalPack = packFs({ root: path.join(appDir, "packs", "core") })
    const localOverrides = new DiskFs({ root: path.join(dataDir, "knowledge") })
    return mountCascade({ base: localOverrides, lens: [globalPack] })
  }

  it("1. mount: the global pack is visible through the cascade untouched", async () => {
    const fs = mount()
    expect(await fs.readFile("entries/greeting.md")).toBe("PACK: hello")
    expect(await fs.readFile("entries/policy.md")).toBe("PACK: policy v1")
  })

  it("2. override: a same-path local entry shadows the pack's", async () => {
    await mkdir(path.join(dataDir, "knowledge", "entries"), { recursive: true })
    await writeFile(
      path.join(dataDir, "knowledge", "entries", "greeting.md"),
      "LOCAL: hi there"
    )

    const fs = mount()
    expect(await fs.readFile("entries/greeting.md")).toBe("LOCAL: hi there")
    // The pack file itself is untouched — only the read view shadows it.
    expect(await packFs({ root: path.join(appDir, "packs", "core") }).readFile(
      "entries/greeting.md"
    )).toBe("PACK: hello")
  })

  it("3. extend: a new local path is additive, alongside the pack's entries", async () => {
    const fs = mount()
    await fs.writeFile("entries/local-only.md", "LOCAL: extra")

    expect(await fs.readFile("entries/local-only.md")).toBe("LOCAL: extra")
    const names = await fs.walk("entries")
    expect(names).toEqual(
      expect.arrayContaining(["greeting.md", "policy.md", "local-only.md"])
    )
  })

  it("4. whiteout: a local `.whiteout` marker removes the pack's entry", async () => {
    const fs = mount()
    await fs.writeFile(`entries/policy.md${WHITEOUT_SUFFIX}`, "")

    expect(await fs.exists("entries/policy.md")).toBe(false)
    const names = await fs.walk("entries")
    expect(names).not.toContain("policy.md")
    // Marker files themselves never surface as visible entries.
    expect(names).not.toContain(`policy.md${WHITEOUT_SUFFIX}`)
    // The pack file on disk is untouched by the whiteout.
    expect(await packFs({ root: path.join(appDir, "packs", "core") }).readFile(
      "entries/policy.md"
    )).toBe("PACK: policy v1")
  })

  it("full cycle: override + extend + whiteout compose in one mount", async () => {
    await mkdir(path.join(dataDir, "knowledge", "entries"), { recursive: true })
    await writeFile(
      path.join(dataDir, "knowledge", "entries", "greeting.md"),
      "LOCAL: hi there"
    )
    await writeFile(
      path.join(dataDir, "knowledge", "entries", "extra.md"),
      "LOCAL: extra"
    )
    await writeFile(
      path.join(dataDir, "knowledge", "entries", `policy.md${WHITEOUT_SUFFIX}`),
      ""
    )

    const fs = mount()
    expect(await fs.readFile("entries/greeting.md")).toBe("LOCAL: hi there") // override
    expect(await fs.readFile("entries/extra.md")).toBe("LOCAL: extra") // extend
    expect(await fs.exists("entries/policy.md")).toBe(false) // whiteout-remove

    const names = await fs.walk("entries")
    expect([...names].sort()).toEqual(["extra.md", "greeting.md"])
  })
})
