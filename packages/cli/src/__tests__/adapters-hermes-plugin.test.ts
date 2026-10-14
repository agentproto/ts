/**
 * `agentproto adapters hermes-plugin status|install` — the CLI verb over
 * the agentproto-system-prompt hermes plugin (the system-prompt channel).
 * Uses a tmp HERMES_HOME; the enable path spawns a FAKE `hermes` from a
 * tmp PATH dir (argv spawn, no shell, no network).
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runAdapters } from "../commands/adapters.js"

let home: string
let out: string[]
let err: string[]
let savedEnv: NodeJS.ProcessEnv

function fakeHermes(script: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "agentproto-fake-hermes-"))
  const bin = join(binDir, "hermes")
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
  return binDir
}

function capture(): void {
  out = []
  err = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk))
    return true
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  home = mkdtempSync(join(tmpdir(), "agentproto-hermes-home-"))
  savedEnv = { ...process.env }
  process.env.HERMES_HOME = home
  capture()
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env.HERMES_HOME = savedEnv.HERMES_HOME
  process.env.PATH = savedEnv.PATH
})

describe("agentproto adapters hermes-plugin", () => {
  it("status --json reports not installed on a fresh home", async () => {
    const code = await runAdapters(["hermes-plugin", "status", "--json"])
    expect(code).toBe(0)
    const status = JSON.parse(out.join(""))
    expect(status.installed).toBe(false)
    expect(status.enabled).toBe(false)
    expect(status.path).toBe(join(home, "plugins", "agentproto-system-prompt"))
  })

  it("status explains how to install when missing", async () => {
    const code = await runAdapters(["hermes-plugin", "status"])
    expect(code).toBe(0)
    expect(out.join("")).toContain("installed: no")
    expect(out.join("")).toContain("agentproto adapters hermes-plugin install --enable")
  })

  it("install copies the bundled plugin; status then says installed", async () => {
    const code = await runAdapters(["hermes-plugin", "install"])
    expect(code).toBe(0)
    expect(out.join("")).toContain("installed v")
    capture()
    const statusCode = await runAdapters(["hermes-plugin", "status", "--json"])
    expect(statusCode).toBe(0)
    const status = JSON.parse(out.join(""))
    expect(status.installed).toBe(true)
    // Copy carries the bundled plugin.yaml version byte-for-byte.
    expect(status.installedVersion).toBe(status.bundledVersion)
  })

  it("install --enable reports the fake hermes enable result", async () => {
    const binDir = fakeHermes("#!/bin/sh\nexit 0\n")
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`
    const code = await runAdapters(["hermes-plugin", "install", "--enable"])
    expect(code).toBe(0)
    expect(out.join("")).toContain("enabled via `hermes plugins enable`")
  })

  it("install --enable surfaces a failing hermes and exits non-zero", async () => {
    const binDir = fakeHermes("#!/bin/sh\necho 'denied' >&2\nexit 4\n")
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`
    const code = await runAdapters(["hermes-plugin", "install", "--enable"])
    expect(code).toBe(4)
    expect(err.join("")).toContain("denied")
  })

  it("rejects an unknown hermes-plugin subcommand with usage", async () => {
    const code = await runAdapters(["hermes-plugin", "bogus"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("unknown subcommand 'bogus'")
    expect(err.join("")).toContain("hermes-plugin status")
  })
})
