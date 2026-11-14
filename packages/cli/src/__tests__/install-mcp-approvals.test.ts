/**
 * `agentproto install-mcp --approvals`: prints the `agentproto-approvals`
 * Claude Desktop entry and, with `--write`, adds only that entry after
 * backing the config up. Runs against a real temp HOME (no fs mocks) so the
 * byte-level claims are checked on actual files.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { FAKE_HOME } = vi.hoisted(() => ({ FAKE_HOME: { value: "/tmp/unset" } }))

vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => FAKE_HOME.value, platform: () => "darwin" }
})

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return { ...orig, discoverDaemon: vi.fn(async () => ({})) }
})

vi.mock("@agentproto/runtime/config", async importOriginal => {
  const orig = await importOriginal<typeof import("@agentproto/runtime/config")>()
  return { ...orig, loadConfig: vi.fn(async () => ({})) }
})

import { runInstallMcp } from "../commands/install-mcp.js"

let home: string
let desktopDir: string
let configPath: string
let stdout: string[]
let stderr: string[]

const OTHER_SECRET_ARG = "--token=sk-live-OTHER-ENTRY-SECRET"
const OTHER_SECRET_ENV = "env-secret-should-never-print"

function otherEntriesConfig(indent: string): string {
  return (
    JSON.stringify(
      {
        globalShortcut: "Ctrl+Space",
        mcpServers: {
          agentproto: {
            command: "agentproto",
            args: ["mcp-bridge"],
            env: { AGENTPROTO_MCP_URL: "http://127.0.0.1:18790/mcp?callerSessionId=claude-desktop&host=claude-desktop" },
          },
          vendor: { command: "npx", args: ["-y", "vendor-mcp", OTHER_SECRET_ARG], env: { VENDOR_KEY: OTHER_SECRET_ENV } },
        },
        preferences: { sidebarMode: "chat" },
      },
      null,
      indent,
    ) + "\n"
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "install-mcp-approvals-"))
  FAKE_HOME.value = home
  desktopDir = join(home, "Library", "Application Support", "Claude")
  mkdirSync(desktopDir, { recursive: true })
  configPath = join(desktopDir, "claude_desktop_config.json")
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

// A GUI app has no shell PATH and the bin is `#!/usr/bin/env node`: the entry
// carries absolute node and the absolute running cli script.
const APPROVALS_ENTRY = {
  command: process.execPath,
  args: [realpathSync(process.argv[1]!), "mcp-bridge", "--surface", "approval-cards"],
}

describe("install-mcp --approvals (print)", () => {
  it("prints the exact entry and touches nothing", async () => {
    const original = otherEntriesConfig("  ")
    writeFileSync(configPath, original)

    const code = await runInstallMcp(["--approvals"])

    expect(code).toBe(0)
    expect(JSON.parse(stdout.join(""))).toEqual({ mcpServers: { "agentproto-approvals": APPROVALS_ENTRY } })
    expect(readFileSync(configPath, "utf8")).toBe(original)
    expect(readdirSync(desktopDir)).toEqual(["claude_desktop_config.json"])
  })

  it("sets the daemon URL (without any callerSessionId) only off the default port", async () => {
    const { loadConfig } = await import("@agentproto/runtime/config")
    vi.mocked(loadConfig).mockResolvedValueOnce({ daemon: { port: 19001 } } as never)

    await runInstallMcp(["--approvals"])

    expect(JSON.parse(stdout.join(""))).toEqual({
      mcpServers: {
        "agentproto-approvals": { ...APPROVALS_ENTRY, env: { AGENTPROTO_MCP_URL: "http://127.0.0.1:19001/mcp" } },
      },
    })
  })

  it("rejects --write without --approvals and --approvals with --app", async () => {
    expect(await runInstallMcp(["--write"])).toBe(2)
    expect(await runInstallMcp(["--approvals", "--app", "x"])).toBe(2)
    expect(await runInstallMcp(["--approvals", "--agent", "cursor"])).toBe(2)
  })
})

describe("install-mcp --approvals --write", () => {
  it("backs up, adds only the new entry, and leaves the other entries byte-identical", async () => {
    const original = otherEntriesConfig("  ")
    writeFileSync(configPath, original)

    const code = await runInstallMcp(["--approvals", "--write"])
    expect(code).toBe(0)

    const backups = readdirSync(desktopDir).filter(name => name.startsWith("claude_desktop_config.json.bak-"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(desktopDir, backups[0]!), "utf8")).toBe(original)

    const after = readFileSync(configPath, "utf8")
    const before = JSON.parse(original) as { mcpServers: Record<string, unknown> }
    const next = JSON.parse(after) as { mcpServers: Record<string, unknown> } & Record<string, unknown>
    expect(Object.keys(next.mcpServers)).toEqual(["agentproto", "vendor", "agentproto-approvals"])
    expect(next.mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)

    // Everything outside the new entry is the same bytes: dropping the new
    // key from the written file gives back the original file text.
    const { "agentproto-approvals": _added, ...rest } = next.mcpServers
    expect(JSON.stringify({ ...next, mcpServers: rest }, null, 2) + "\n").toBe(original)
    expect(JSON.stringify(rest.vendor)).toBe(JSON.stringify(before.mcpServers.vendor))
    expect(next.globalShortcut).toBe("Ctrl+Space")
  })

  it("keeps a 4-space indented file 4-space indented", async () => {
    const original = otherEntriesConfig("    ")
    writeFileSync(configPath, original)

    await runInstallMcp(["--approvals", "--write"])

    const after = readFileSync(configPath, "utf8")
    expect(after.startsWith('{\n    "globalShortcut"')).toBe(true)
    expect(after).toContain(`"vendor": {\n            "command": "npx"`)
  })

  it("never prints another entry's args or env", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))

    await runInstallMcp(["--approvals", "--write"])

    const out = stdout.join("") + stderr.join("")
    expect(out).toContain("agentproto-approvals")
    expect(out).not.toContain(OTHER_SECRET_ARG)
    expect(out).not.toContain(OTHER_SECRET_ENV)
    expect(out).not.toContain("vendor")
    expect(out).not.toContain("callerSessionId")
  })

  it("is a no-op (no second backup, file untouched) when the entry is already there", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))
    await runInstallMcp(["--approvals", "--write"])
    const written = readFileSync(configPath, "utf8")
    const files = readdirSync(desktopDir).sort()

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    expect(readFileSync(configPath, "utf8")).toBe(written)
    expect(readdirSync(desktopDir).sort()).toEqual(files)
  })

  it("creates the config when Desktop has none yet (no backup to take)", async () => {
    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: { "agentproto-approvals": APPROVALS_ENTRY },
    })
    expect(readdirSync(desktopDir)).toEqual(["claude_desktop_config.json"])
  })

  it("leaves a config that is not valid JSON untouched and fails", async () => {
    writeFileSync(configPath, "{ not json")

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(1)

    expect(readFileSync(configPath, "utf8")).toBe("{ not json")
    expect(readdirSync(desktopDir)).toEqual(["claude_desktop_config.json"])
  })

  it("fails without writing when Claude Desktop is not on this machine", async () => {
    rmSync(desktopDir, { recursive: true, force: true })

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(1)
    expect(stderr.join("")).toContain("Claude Desktop was not found")
  })
})

describe("install-mcp --approvals --write (Claude-3p profile)", () => {
  let thirdPartyDir: string
  let thirdPartyPath: string

  beforeEach(() => {
    thirdPartyDir = join(home, "Library", "Application Support", "Claude-3p")
    thirdPartyPath = join(thirdPartyDir, "claude_desktop_config.json")
  })

  const backupsOf = (dir: string, base: string) => readdirSync(dir).filter(n => n.startsWith(`${base}.bak-`))

  it("writes the entry into both profiles when both exist, each backed up, other entries untouched", async () => {
    const mainOriginal = otherEntriesConfig("  ")
    const thirdOriginal = otherEntriesConfig("    ")
    writeFileSync(configPath, mainOriginal)
    mkdirSync(thirdPartyDir, { recursive: true })
    writeFileSync(thirdPartyPath, thirdOriginal)

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    for (const [path, dir, original] of [
      [configPath, desktopDir, mainOriginal],
      [thirdPartyPath, thirdPartyDir, thirdOriginal],
    ] as const) {
      const backups = backupsOf(dir, "claude_desktop_config.json")
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(original)
      const next = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> }
      expect(Object.keys(next.mcpServers)).toEqual(["agentproto", "vendor", "agentproto-approvals"])
      expect(next.mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)
      const before = JSON.parse(original) as { mcpServers: Record<string, unknown> }
      expect(JSON.stringify(next.mcpServers.vendor)).toBe(JSON.stringify(before.mcpServers.vendor))
      expect(JSON.stringify(next.mcpServers.agentproto)).toBe(JSON.stringify(before.mcpServers.agentproto))
    }
    expect(readFileSync(thirdPartyPath, "utf8").startsWith('{\n    "globalShortcut"')).toBe(true)
  })

  it("writes only Claude/ and never creates Claude-3p when that config is absent", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)
    expect(readdirSync(join(home, "Library", "Application Support"))).toEqual(["Claude"])
  })

  it("writes the Claude-3p profile even when Claude/ is not installed", async () => {
    rmSync(desktopDir, { recursive: true, force: true })
    mkdirSync(thirdPartyDir, { recursive: true })
    writeFileSync(thirdPartyPath, otherEntriesConfig("  "))

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    expect(JSON.parse(readFileSync(thirdPartyPath, "utf8")).mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)
    expect(readdirSync(join(home, "Library", "Application Support"))).toEqual(["Claude-3p"])
  })

  it("the entry uses absolute node and an absolute cli script, not bare agentproto", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))
    mkdirSync(thirdPartyDir, { recursive: true })
    writeFileSync(thirdPartyPath, otherEntriesConfig("  "))

    await runInstallMcp(["--approvals", "--write"])

    for (const path of [configPath, thirdPartyPath]) {
      const entry = JSON.parse(readFileSync(path, "utf8")).mcpServers["agentproto-approvals"] as {
        command: string
        args: string[]
      }
      expect(entry.command).toBe(process.execPath)
      expect(isAbsolute(entry.command)).toBe(true)
      expect(isAbsolute(entry.args[0]!)).toBe(true)
      expect(entry.args.slice(1)).toEqual(["mcp-bridge", "--surface", "approval-cards"])
    }
    const printed = JSON.parse(stdout.join("").slice(0, stdout.join("").indexOf("\n}\n") + 2)) as {
      mcpServers: Record<string, unknown>
    }
    expect(printed.mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)
  })

  it("prints the quit-Claude reminder once after writing, and no other entry", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))
    mkdirSync(thirdPartyDir, { recursive: true })
    writeFileSync(thirdPartyPath, otherEntriesConfig("  "))

    await runInstallMcp(["--approvals", "--write"])

    const out = stdout.join("") + stderr.join("")
    expect(out.match(/Quit Claude completely \(Cmd\+Q\) BEFORE running this/g)).toHaveLength(1)
    expect(out).not.toContain(OTHER_SECRET_ARG)
    expect(out).not.toContain(OTHER_SECRET_ENV)
    expect(out).not.toContain("vendor")
  })

  it("prints no quit reminder when nothing needed writing", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))
    await runInstallMcp(["--approvals", "--write"])
    stdout.length = 0

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(0)

    expect(stdout.join("")).not.toContain("Quit Claude completely")
  })

  it("one unreadable profile fails the run but the other is still written", async () => {
    writeFileSync(configPath, otherEntriesConfig("  "))
    mkdirSync(thirdPartyDir, { recursive: true })
    writeFileSync(thirdPartyPath, "{ not json")

    expect(await runInstallMcp(["--approvals", "--write"])).toBe(1)

    expect(readFileSync(thirdPartyPath, "utf8")).toBe("{ not json")
    expect(backupsOf(thirdPartyDir, "claude_desktop_config.json")).toHaveLength(0)
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers["agentproto-approvals"]).toEqual(APPROVALS_ENTRY)
  })
})
