/**
 * Tests for `agentproto acp <add|ls|rm>` — driven through the public
 * `runAcp` entrypoint against a throwaway HOME so we exercise the full
 * config round-trip (loadConfig/saveConfig) without touching the real
 * ~/.agentproto/config.json.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── mock node:os so homedir() (used by CONFIG_FILE_PATH) is our temp dir ──
const { FAKE_HOME } = vi.hoisted(() => ({ FAKE_HOME: { value: "" } }))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => FAKE_HOME.value }
})

import { runAcp } from "../commands/acp.js"

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
  FAKE_HOME.value = mkdtempSync(join(tmpdir(), "agp-acp-cmd-"))
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

describe("agentproto acp add", () => {
  it("writes a config.acpAgents entry and prints how to run it", async () => {
    const code = await runAcp([
      "add",
      "my-agent",
      "--bin",
      "my-agent",
      "--args",
      "acp",
      "--resumable",
    ])
    expect(code).toBe(0)

    const cfg = readConfig()
    const agents = cfg.acpAgents as Record<string, Record<string, unknown>>
    expect(agents["my-agent"]).toEqual({
      bin: "my-agent",
      bin_args: ["acp"],
      resumable: true,
    })
    expect(out.join("")).toContain("agentproto run my-agent")
  })

  it("parses --env K=V pairs and --name/--desc", async () => {
    const code = await runAcp([
      "add",
      "envy",
      "--bin",
      "envy",
      "--name",
      "Envy",
      "--desc",
      "an agent",
      "--env",
      "A=1",
      "--env",
      "B=two",
    ])
    expect(code).toBe(0)
    const agents = readConfig().acpAgents as Record<string, Record<string, unknown>>
    expect(agents.envy).toEqual({
      bin: "envy",
      name: "Envy",
      description: "an agent",
      env: { A: "1", B: "two" },
    })
  })

  it("rejects a missing --bin", async () => {
    const code = await runAcp(["add", "no-bin"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("--bin is required")
  })

  it("rejects a malformed --env pair", async () => {
    const code = await runAcp(["add", "bad", "--bin", "bad", "--env", "nope"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("K=V")
  })

  it("rejects an invalid (too-short) slug before writing", async () => {
    const code = await runAcp(["add", "a", "--bin", "a"])
    expect(code).toBe(2)
    expect(existsSync(configPath())).toBe(false)
  })
})

describe("agentproto acp ls", () => {
  it("lists catalog + config agents as JSON", async () => {
    await runAcp(["add", "zeta-agent", "--bin", "zeta"])
    out.length = 0
    const code = await runAcp(["ls", "--json"])
    expect(code).toBe(0)
    const entries = JSON.parse(out.join("")) as Array<{ slug: string; source: string }>
    const custom = entries.find((e) => e.slug === "zeta-agent")
    expect(custom?.source).toBe("acp-config")
    // Catalog entries appear too.
    expect(entries.some((e) => e.source === "acp-catalog")).toBe(true)
  })
})

describe("agentproto acp rm", () => {
  it("removes a config entry (round-trip) and keeps the key absent when empty", async () => {
    await runAcp(["add", "temp-agent", "--bin", "temp"])
    expect((readConfig().acpAgents as Record<string, unknown>)["temp-agent"]).toBeDefined()

    const code = await runAcp(["rm", "temp-agent"])
    expect(code).toBe(0)
    expect(readConfig().acpAgents).toBeUndefined()
  })

  it("refuses to remove a curated catalog entry", async () => {
    const code = await runAcp(["rm", "gemini-cli"])
    expect(code).toBe(1)
    expect(err.join("")).toContain("curated catalog entry")
  })

  it("errors on an unknown slug", async () => {
    const code = await runAcp(["rm", "nope-agent"])
    expect(code).toBe(1)
    expect(err.join("")).toContain("no config-defined agent")
  })
})
