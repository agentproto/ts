import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { configFilePath, readConfigFile, writeConfigFile } from "./daemonConfigFile.js"
import { parseDaemonSection, setConfigKey } from "./daemonConfig.logic.js"

describe("configFilePath", () => {
  it("resolves ~/.agentproto/config.json from the given home", () => {
    expect(configFilePath("/home/jeremy")).toBe("/home/jeremy/.agentproto/config.json")
  })
})

describe("readConfigFile / writeConfigFile round-trip", () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "apt-cfg-"))
    path = join(dir, "config.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("returns {} when the file is missing", async () => {
    expect(await readConfigFile(path)).toEqual({})
  })

  it("returns {} on malformed JSON rather than throwing", async () => {
    await fs.writeFile(path, "{ not json", "utf8")
    expect(await readConfigFile(path)).toEqual({})
  })

  it("writes an edited knob and reads it back, version-stamped", async () => {
    await fs.writeFile(path, JSON.stringify({ version: 1, daemon: { port: 18790 } }), "utf8")

    const config = await readConfigFile(path)
    await writeConfigFile(setConfigKey(config, "daemon.idleReapAfterMs", 30000), path)

    const written = await readConfigFile(path)
    expect(written.version).toBe(1)
    expect(parseDaemonSection(written)).toEqual({ port: 18790, idleReapAfterMs: 30000 })
    // trailing newline (matches runtime saveConfig)
    expect(await fs.readFile(path, "utf8")).toMatch(/\n$/)
  })

  it("creates the parent directory when it does not exist", async () => {
    const nested = join(dir, "deep", "config.json")
    await writeConfigFile({ daemon: { resumeSessionsOnBoot: true } }, nested)
    expect(parseDaemonSection(await readConfigFile(nested))).toEqual({ resumeSessionsOnBoot: true })
  })
})
