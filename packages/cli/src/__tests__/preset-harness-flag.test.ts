/**
 * `agentproto preset add --harness <slug>` is canonical; `--adapter` still
 * works, saves the same preset, and prints a dated deprecation on stderr.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getUserPreset } from "@agentproto/runtime/user-presets"
import { runPreset } from "../commands/preset.js"

const DEPRECATION =
  "agentproto preset add: `--adapter` is deprecated and will be removed in the next major of @agentproto/runtime; use `--harness`"

let previousHome: string | undefined
let home: string
let stderr: string[]

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-preset-harness-"))
  process.env.HOME = home
  stderr = []
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (stderr.push(String(c)), true))
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("agentproto preset add --harness", () => {
  it("--harness saves the preset's harness, no warning", async () => {
    expect(await runPreset(["add", "fast", "--label", "Fast", "--harness", "hermes"])).toBe(0)
    expect((await getUserPreset("fast"))?.harness).toBe("hermes")
    expect(stderr.join("")).not.toContain("deprecated")
  })

  it("--adapter still saves the same harness, with a deprecation on stderr", async () => {
    expect(await runPreset(["add", "fast", "--label", "Fast", "--adapter", "hermes"])).toBe(0)
    expect((await getUserPreset("fast"))?.harness).toBe("hermes")
    expect(stderr.join("")).toContain(DEPRECATION)
  })
})
