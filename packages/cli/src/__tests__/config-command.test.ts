/**
 * Tests for `agentproto config set|unset` — driven through the public
 * `runConfig` entrypoint against a throwaway HOME so we exercise the full
 * config round-trip (loadConfig/saveConfig) without touching the real
 * ~/.agentproto/config.json. Focus: the new registry-backed validation
 * (`config-schema.ts`) — known key + bad value rejected, unknown key
 * written with a warning, non-writable key rejected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { FAKE_HOME } = vi.hoisted(() => ({ FAKE_HOME: { value: "" } }))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => FAKE_HOME.value }
})

import { runConfig } from "../commands/config.js"

function configPath(): string {
  return join(FAKE_HOME.value, ".agentproto", "config.json")
}
function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>
}

let out: string[]
let err: string[]
let outSpy: { mockRestore: () => void }
let errSpy: { mockRestore: () => void }

beforeEach(() => {
  FAKE_HOME.value = mkdtempSync(join(tmpdir(), "agp-config-cmd-"))
  out = []
  err = []
  outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    })
  errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk))
      return true
    })
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  rmSync(FAKE_HOME.value, { recursive: true, force: true })
})

describe("agentproto config set", () => {
  it("writes a known key with a valid value", async () => {
    const code = await runConfig(["set", "daemon.idleReapAfterMs", "5000"])
    expect(code).toBe(0)
    expect(readConfig()).toMatchObject({ daemon: { idleReapAfterMs: 5000 } })
    expect(err.join("")).toBe("")
  })

  it("rejects a known key with a badly-typed value, exit 2, nothing written", async () => {
    const code = await runConfig(["set", "daemon.idleReapAfterMs", "soon"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("agentproto config set:")
    expect(existsSync(configPath())).toBe(false)
  })

  it("rejects a bad enum value for a known key", async () => {
    const code = await runConfig(["set", "spawn.attach", "sometimes"])
    expect(code).toBe(2)
    expect(existsSync(configPath())).toBe(false)
  })

  it("rejects a write to a non-writable lockout key", async () => {
    const code = await runConfig(["set", "daemon.port", "4000"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("not writable")
    expect(existsSync(configPath())).toBe(false)
  })

  it("rejects a write to a non-writable secret key", async () => {
    const code = await runConfig(["set", "daemon.authToken", "sk-whatever"])
    expect(code).toBe(2)
    expect(existsSync(configPath())).toBe(false)
  })

  it("writes an unknown key but prints a warning", async () => {
    const code = await runConfig(["set", "someBrandNewKey", "42"])
    expect(code).toBe(0)
    expect(readConfig()).toMatchObject({ someBrandNewKey: 42 })
    expect(err.join("")).toContain("not a known config key")
  })

  it("writes a valid wildcard-matched adapter key", async () => {
    const code = await runConfig(["set", "defaults.adapters.claude-code.skills", "planning,review"])
    expect(code).toBe(0)
    expect(readConfig()).toMatchObject({
      defaults: { adapters: { "claude-code": { skills: ["planning", "review"] } } },
    })
  })
})

describe("agentproto config unset", () => {
  it("removes a known writable key", async () => {
    await runConfig(["set", "daemon.idleReapAfterMs", "5000"])
    const code = await runConfig(["unset", "daemon.idleReapAfterMs"])
    expect(code).toBe(0)
    expect(readConfig()).not.toHaveProperty("daemon.idleReapAfterMs")
  })

  it("rejects unsetting a non-writable lockout key", async () => {
    const code = await runConfig(["unset", "daemon.port"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("not writable")
  })

  it("rejects unsetting a non-writable secret key", async () => {
    const code = await runConfig(["unset", "daemon.authToken"])
    expect(code).toBe(2)
  })
})
