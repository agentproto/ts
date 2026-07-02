/**
 * Tests for `agentproto install-mcp` — driven through the public
 * `runInstallMcp` entrypoint so we exercise the full code path.
 *
 * Mocks filesystem (node:fs/promises) and child_process spawn so we never
 * touch the real ~/.claude.json etc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── mock node:os so homedir() returns a temp dir ─────────────────────────────

const { FAKE_HOME, mockFs, spawnMock } = vi.hoisted(() => ({
  FAKE_HOME: { value: "/tmp/fake-home" },
  mockFs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
  },
  spawnMock: vi.fn(),
}))

vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>()
  return {
    ...actual,
    homedir: () => FAKE_HOME.value,
    platform: () => "darwin",
  }
})

// ── mock node:fs/promises ───────────────────────────────────────────────────

vi.mock("node:fs/promises", () => mockFs)

// Also mock node:fs so that `import { promises as fs } from "node:fs"`
// picks up the same mock — install-mcp.ts imports this way.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    promises: mockFs,
    default: { ...actual, promises: mockFs },
  }
})

// ── mock child_process spawn ──────────────────────────────────────────────────

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: spawnMock,
  }
})

// ── mock daemon helpers ────────────────────────────────────────────────────────

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
  }
})

// ── mock runtime config ────────────────────────────────────────────────────────

vi.mock("@agentproto/runtime/config", async importOriginal => {
  const orig = await importOriginal<typeof import("@agentproto/runtime/config")>()
  return {
    ...orig,
    loadConfig: vi.fn(),
  }
})

import {
  runInstallMcp,
  upsertHermesMcpServer,
  removeHermesMcpServer,
} from "../commands/install-mcp.js"

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const { loadConfig } = await import("@agentproto/runtime/config")
const mockLoadConfig = vi.mocked(loadConfig)

// ── helpers ────────────────────────────────────────────────────────────────────

/** Configure a file-mock: fs.access resolves, fs.stat is a file, fs.readFile returns content. */
function mockFileExists(path: string, content?: string): void {
  mockFs.access.mockImplementation(async (p: string) => {
    if (p === path) return
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.stat.mockImplementation(async (p: string) => {
    if (p === path) return { isDirectory: () => false } as any
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.readFile.mockImplementation(async (p: string) => {
    if (p === path && content !== undefined) return content
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
}

/** Configure a directory-mock: fs.stat resolves with isDirectory=true. */
function mockDirExists(path: string): void {
  mockFs.stat.mockImplementation(async (p: string) => {
    if (p === path) return { isDirectory: () => true } as any
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.access.mockImplementation(async (p: string) => {
    if (p === path) return
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
}

/** Configure a binary-on-PATH mock: spawn('which', [name]) returns exit 0. */
function mockBinaryOnPath(names: string[]): void {
  spawnMock.mockImplementation((cmd: string, args: string[]) => {
    const name = args[0] ?? ""
    const found = cmd === "which" && names.includes(name)
    const stdoutData = found ? `/usr/local/bin/${name}\n` : ""
    return {
      on: (event: string, cb: (code: number) => void) => {
        if (event === "exit") cb(found ? 0 : 1)
      },
      stdout: {
        setEncoding: () => ({
          on: (event: string, cb: (data: string) => void) => {
            if (event === "data" && stdoutData) cb(stdoutData)
          },
        }),
      },
      stderr: {
        setEncoding: () => ({ on: () => {} }),
      },
      unref: () => {},
    }
  })
}

/** Multi-path mock: different paths return file content, directory stat, or ENOENT. */
function mockMultiPath(opts: {
  files?: Record<string, string>
  dirs?: string[]
}): void {
  const { files = {}, dirs = [] } = opts
  mockFs.access.mockImplementation(async (p: string) => {
    if (p in files || dirs.includes(p)) return
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.stat.mockImplementation(async (p: string) => {
    if (dirs.includes(p)) return { isDirectory: () => true } as any
    if (p in files) return { isDirectory: () => false } as any
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.readFile.mockImplementation(async (p: string) => {
    if (p in files) return files[p]!
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
}

/** Capture stdout writes into an array. */
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

/** Capture stderr writes into an array. */
function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

beforeEach(() => {
  FAKE_HOME.value = "/tmp/fake-home"
  vi.clearAllMocks()
  mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  mockFs.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  mockFs.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  mockFs.mkdir.mockResolvedValue(undefined)
  mockFs.writeFile.mockResolvedValue(undefined)
  mockLoadConfig.mockResolvedValue({ daemon: { port: 18790 } })
  discoverDaemon.mockResolvedValue({
    found: { url: "http://127.0.0.1:18790" },
    stale: [],
  })
  httpGetJson.mockResolvedValue({ status: "ok" })
  spawnMock.mockImplementation(() => ({
    on: (_event: string, cb: (code: number) => void) => cb(1),
    stdout: {
      setEncoding: () => ({
        on: () => {},
      }),
    },
    stderr: {
      setEncoding: () => ({ on: () => {} }),
    },
    unref: () => {},
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── tests: --help ────────────────────────────────────────────────────────────

describe("runInstallMcp --help", () => {
  it("prints usage and exits 0", async () => {
    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--help"])
    restore()

    expect(code).toBe(0)
    const output = chunks.join("")
    expect(output).toContain("install-mcp")
    expect(output).toContain("--agent")
    expect(output).toContain("--skip-daemon")
  })
})

// ── tests: no agents detected ───────────────────────────────────────────────

describe("runInstallMcp with no agents detected", () => {
  it("exits 0 with --yes and says nothing to do", async () => {
    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--yes", "--skip-daemon"])
    restore()

    expect(code).toBe(0)
    expect(chunks.join("")).toContain("Nothing to do")
  })

  it("exits 0 without --yes and says no agents detected", async () => {
    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--skip-daemon"])
    restore()

    expect(code).toBe(0)
    expect(chunks.join("")).toContain("No coding-CLI agents detected")
  })
})

// ── tests: --skip-daemon path ───────────────────────────────────────────────

describe("runInstallMcp --skip-daemon", () => {
  it("skips daemon discovery and uses config port for registration", async () => {
    // Provide a cursor config so an agent is detected
    const cursorConfigPath = "/tmp/fake-home/.cursor/mcp.json"
    mockFileExists(cursorConfigPath, JSON.stringify({ mcpServers: {} }))
    mockDirExists("/tmp/fake-home/.cursor")

    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--skip-daemon", "--yes"])
    restore()

    expect(code).toBe(0)
    // discoverDaemon should NOT have been called
    expect(discoverDaemon).not.toHaveBeenCalled()
    // Should have written to cursor config
    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorConfigPath,
    )
    expect(configWrite).toBeDefined()
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers.agentproto).toBeDefined()
    expect(written.mcpServers.agentproto.command).toBe("agentproto")
  })

  it("falls back to DEFAULT_PORT when config has no daemon.port", async () => {
    mockLoadConfig.mockResolvedValue({}) // no daemon.port
    mockFileExists(
      "/tmp/fake-home/.cursor/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    )
    mockDirExists("/tmp/fake-home/.cursor")

    const code = await runInstallMcp(["--skip-daemon", "--yes"])
    expect(code).toBe(0)
  })
})

// ── tests: daemon discovery returns null ────────────────────────────────────

describe("runInstallMcp when daemon discovery fails", () => {
  it("exits 1 when daemon is not found and cannot be started", async () => {
    // Daemon not found
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    // Health checks fail
    httpGetJson.mockRejectedValue(new Error("ECONNREFUSED"))
    // spawn for `agentproto daemon start` → non-zero
    spawnMock.mockImplementation(() => ({
      on: (_event: string, cb: (code: number) => void) => cb(1),
      stdout: { setEncoding: () => ({ on: () => {} }) },
      stderr: { setEncoding: () => ({ on: () => {} }) },
      unref: () => {},
    }))

    // Make an agent detectable so we reach the daemon step
    mockFileExists(
      "/tmp/fake-home/.cursor/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    )
    mockDirExists("/tmp/fake-home/.cursor")

    const { chunks, restore } = captureStderr()

    const code = await runInstallMcp([]) // no --yes → ensureDaemon skips the 10s background-spawn health loop
    restore()

    expect(code).toBe(1)
    expect(chunks.join("")).toContain("Could not find or start the daemon")
  })
})

// ── tests: normal install flow (through public entrypoint) ─────────────────

describe("runInstallMcp normal install", () => {
  it("registers cursor via stdio JSON and writes install-state", async () => {
    const cursorConfigPath = "/tmp/fake-home/.cursor/mcp.json"
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const existingConfig = {
      mcpServers: {
        "other-server": { command: "other-cmd", args: ["--foo"] },
      },
    }

    mockMultiPath({
      files: {
        [cursorConfigPath]: JSON.stringify(existingConfig),
      },
      dirs: ["/tmp/fake-home/.cursor"],
    })

    const code = await runInstallMcp(["--yes"])
    expect(code).toBe(0)

    // Config written with both old and new server
    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorConfigPath,
    )
    expect(configWrite).toBeDefined()
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers["other-server"]).toBeDefined()
    expect(written.mcpServers.agentproto).toBeDefined()
    expect(written.mcpServers.agentproto.command).toBe("agentproto")
    expect(written.mcpServers.agentproto.args).toEqual(["mcp-bridge"])

    // State file written
    const stateWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === statePath,
    )
    expect(stateWrite).toBeDefined()
    const state = JSON.parse(stateWrite![1] as string)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].agent).toBe("cursor")
    expect(state.entries[0].transport).toBe("stdio")
  })

  it("overwrites a previous agentproto entry but preserves other servers", async () => {
    const cursorConfigPath = "/tmp/fake-home/.cursor/mcp.json"
    const existingConfig = {
      mcpServers: {
        agentproto: { command: "old-agentproto", args: ["old-bridge"] },
        "other-server": { command: "other-cmd" },
      },
    }

    mockMultiPath({
      files: { [cursorConfigPath]: JSON.stringify(existingConfig) },
      dirs: ["/tmp/fake-home/.cursor"],
    })

    const code = await runInstallMcp(["--yes"])
    expect(code).toBe(0)

    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorConfigPath,
    )
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers["other-server"].command).toBe("other-cmd")
    expect(written.mcpServers.agentproto.command).toBe("agentproto")
    expect(written.mcpServers.agentproto.args).toEqual(["mcp-bridge"])
  })

  it("writes AGENTPROTO_MCP_URL env when port is non-default", async () => {
    // Daemon running on non-default port
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18791" },
      stale: [],
    })

    const cursorConfigPath = "/tmp/fake-home/.cursor/mcp.json"
    mockMultiPath({
      files: { [cursorConfigPath]: JSON.stringify({ mcpServers: {} }) },
      dirs: ["/tmp/fake-home/.cursor"],
    })

    const code = await runInstallMcp(["--yes"])
    expect(code).toBe(0)

    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorConfigPath,
    )
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers.agentproto.env.AGENTPROTO_MCP_URL).toBe(
      "http://127.0.0.1:18791/mcp",
    )
  })

  it("does not write env when port is default", async () => {
    const cursorConfigPath = "/tmp/fake-home/.cursor/mcp.json"
    mockMultiPath({
      files: { [cursorConfigPath]: JSON.stringify({ mcpServers: {} }) },
      dirs: ["/tmp/fake-home/.cursor"],
    })

    const code = await runInstallMcp(["--yes"])
    expect(code).toBe(0)

    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorConfigPath,
    )
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers.agentproto.env).toEqual({})
  })

  it("rejects unknown agent names with exit 2", async () => {
    // Must have a detected agent to reach the --agent validation path
    mockDirExists("/tmp/fake-home/.cursor")
    mockFileExists("/tmp/fake-home/.cursor/mcp.json", "{}")

    const { chunks, restore } = captureStderr()

    const code = await runInstallMcp(["--agent", "unknown-agent", "--yes", "--skip-daemon"])
    restore()

    expect(code).toBe(2)
    expect(chunks.join("")).toContain("Unknown agent")
  })

  it("exits 1 when requested agent is not detected", async () => {
    // Cursor is detected but we request claude which is not
    mockDirExists("/tmp/fake-home/.cursor")
    mockFileExists("/tmp/fake-home/.cursor/mcp.json", "{}")

    const { chunks, restore } = captureStderr()

    const code = await runInstallMcp(["--agent", "claude", "--yes", "--skip-daemon"])
    restore()

    expect(code).toBe(1)
    expect(chunks.join("")).toContain("None of the requested agents")
  })
})

// ── tests: --uninstall (integration through runInstallMcp) ──────────────────

describe("runInstallMcp --uninstall", () => {
  it("removes entries and clears state", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    const state = {
      entries: [
        {
          agent: "cursor",
          configPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const existingConfig = {
      mcpServers: {
        agentproto: { command: "agentproto", args: ["mcp-bridge"] },
        "other-server": { command: "other-cmd" },
      },
    }

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [configPath]: JSON.stringify(existingConfig),
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    // Should have written the cleaned config file
    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === configPath,
    )
    expect(configWrite).toBeDefined()
    const writtenConfig = JSON.parse(configWrite![1] as string)
    expect(writtenConfig.mcpServers.agentproto).toBeUndefined()
    expect(writtenConfig.mcpServers["other-server"]).toBeDefined()

    // Should have written empty state
    const stateWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === statePath,
    )
    expect(stateWrite).toBeDefined()
    const writtenState = JSON.parse(stateWrite![1] as string)
    expect(writtenState.entries).toEqual([])
  })

  it("says nothing to remove when state is empty", async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--uninstall"])
    restore()

    expect(code).toBe(0)
    expect(chunks.join("")).toContain("No agentproto MCP registrations to remove")
  })

  it("uninstall removes codex TOML block via runInstallMcp", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const codexPath = "/tmp/fake-home/.codex/config.toml"
    const state = {
      entries: [
        {
          agent: "codex",
          configPath: codexPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const tomlContent = `[some.other]\nkey = "val"\n\n[mcp_servers.agentproto]\ncommand = "agentproto"\nargs = ["mcp-bridge"]\n\n[another.table]\nfoo = "bar"\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [codexPath]: tomlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === codexPath,
    )
    expect(configWrite).toBeDefined()
    const written = configWrite![1] as string
    expect(written).not.toContain("[mcp_servers.agentproto]")
    expect(written).toContain("[some.other]")
    expect(written).toContain("[another.table]")
  })

  it("uninstall removes aider YAML key via runInstallMcp", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const aiderPath = "/tmp/fake-home/.aider.conf.yml"
    const state = {
      entries: [
        {
          agent: "aider",
          configPath: aiderPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const yamlContent = `other_key: val\n\nmcp_servers:\n  agentproto:\n    command: agentproto\n    args:\n      - mcp-bridge\n\nother_key2: val2\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [aiderPath]: yamlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === aiderPath,
    )
    expect(configWrite).toBeDefined()
    const written = configWrite![1] as string
    expect(written).not.toContain("mcp_servers:")
    expect(written).toContain("other_key: val")
    expect(written).toContain("other_key2: val2")
  })

  it("uninstall is a no-op when config file is gone", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    const state = {
      entries: [
        {
          agent: "cursor",
          configPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }

    // State file exists but config file is gone
    mockMultiPath({
      files: { [statePath]: JSON.stringify(state) },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    // State should still be cleared
    const stateWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === statePath,
    )
    expect(stateWrite).toBeDefined()
    const writtenState = JSON.parse(stateWrite![1] as string)
    expect(writtenState.entries).toEqual([])
  })
})

// ── tests: --update (integration through runInstallMcp) ─────────────────────

describe("runInstallMcp --update", () => {
  it("updates registrations with current daemon port", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const cursorPath = "/tmp/fake-home/.cursor/mcp.json"
    const state = {
      entries: [
        {
          agent: "cursor",
          configPath: cursorPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [cursorPath]: JSON.stringify({ mcpServers: {} }),
      },
      dirs: ["/tmp/fake-home/.cursor"],
    })

    const code = await runInstallMcp(["--update", "--yes"])
    expect(code).toBe(0)

    // Config should have the updated agentproto entry
    const configWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === cursorPath,
    )
    expect(configWrite).toBeDefined()
    const written = JSON.parse(configWrite![1] as string)
    expect(written.mcpServers.agentproto).toBeDefined()
    expect(written.mcpServers.agentproto.command).toBe("agentproto")

    // State should be updated
    const stateWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === statePath,
    )
    expect(stateWrite).toBeDefined()
    const writtenState = JSON.parse(stateWrite![1] as string)
    expect(writtenState.entries).toHaveLength(1)
    expect(writtenState.entries[0].agent).toBe("cursor")
  })

  it("says no previous registrations when state is empty", async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--update"])
    restore()

    expect(code).toBe(0)
    expect(chunks.join("")).toContain("No previous registrations found")
  })

  it("exits 1 when daemon cannot be found during update", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const state = {
      entries: [
        {
          agent: "cursor",
          configPath: "/tmp/fake-home/.cursor/mcp.json",
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    mockMultiPath({ files: { [statePath]: JSON.stringify(state) } })

    // Daemon not found and cannot be started
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    httpGetJson.mockRejectedValue(new Error("ECONNREFUSED"))
    spawnMock.mockImplementation(() => ({
      on: (_event: string, cb: (code: number) => void) => cb(1),
      stdout: { setEncoding: () => ({ on: () => {} }) },
      stderr: { setEncoding: () => ({ on: () => {} }) },
      unref: () => {},
    }))

    const { chunks, restore } = captureStderr()

    const code = await runInstallMcp(["--update"]) // no --yes → ensureDaemon skips 10s background spawn
    restore()

    expect(code).toBe(1)
    expect(chunks.join("")).toContain("Could not find or start the daemon")
  })

  it("skips entries whose agent is no longer detected", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const state = {
      entries: [
        {
          agent: "cursor",
          configPath: "/tmp/fake-home/.cursor/mcp.json",
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    // No config files or dirs → cursor not detected
    mockMultiPath({ files: { [statePath]: JSON.stringify(state) } })

    const { chunks, restore } = captureStdout()

    const code = await runInstallMcp(["--update", "--yes"])
    restore()

    expect(code).toBe(0)
    expect(chunks.join("")).toContain("no longer detected")
  })
})

// ── tests: TOML and YAML removal (through --uninstall) ──────────────────────

describe("TOML block removal via --uninstall", () => {
  it("removes a [mcp_servers.agentproto] block, preserves others", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const codexPath = "/tmp/fake-home/.codex/config.toml"
    const state = {
      entries: [
        {
          agent: "codex",
          configPath: codexPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const tomlContent = `[some.other]\nkey = "val"\n\n[mcp_servers.agentproto]\ncommand = "agentproto"\nargs = ["mcp-bridge"]\n\n[another.table]\nfoo = "bar"\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [codexPath]: tomlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const written = mockFs.writeFile.mock.calls.find(
      c => c[0] === codexPath,
    )![1] as string
    expect(written).not.toContain("[mcp_servers.agentproto]")
    expect(written).toContain("[some.other]")
    expect(written).toContain("[another.table]")
    expect(written).toContain('foo = "bar"')
  })

  it("handles TOML block at end of file", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const codexPath = "/tmp/fake-home/.codex/config.toml"
    const state = {
      entries: [
        {
          agent: "codex",
          configPath: codexPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const tomlContent = `[other]\nkey = "val"\n\n[mcp_servers.agentproto]\ncommand = "agentproto"\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [codexPath]: tomlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const written = mockFs.writeFile.mock.calls.find(
      c => c[0] === codexPath,
    )![1] as string
    expect(written).not.toContain("[mcp_servers.agentproto]")
    expect(written).toContain("[other]")
  })
})

describe("YAML key removal via --uninstall", () => {
  it("removes a top-level key and its nested block", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const aiderPath = "/tmp/fake-home/.aider.conf.yml"
    const state = {
      entries: [
        {
          agent: "aider",
          configPath: aiderPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const yamlContent = `other_key: val\n\nmcp_servers:\n  agentproto:\n    command: agentproto\n    args:\n      - mcp-bridge\n\nother_key2: val2\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [aiderPath]: yamlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const written = mockFs.writeFile.mock.calls.find(
      c => c[0] === aiderPath,
    )![1] as string
    expect(written).not.toContain("mcp_servers:")
    expect(written).toContain("other_key: val")
    expect(written).toContain("other_key2: val2")
  })

  it("handles YAML key at end of file", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const aiderPath = "/tmp/fake-home/.aider.conf.yml"
    const state = {
      entries: [
        {
          agent: "aider",
          configPath: aiderPath,
          transport: "stdio" as const,
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const yamlContent = `other: val\n\nmcp_servers:\n  agentproto:\n    command: agentproto\n`

    mockMultiPath({
      files: {
        [statePath]: JSON.stringify(state),
        [aiderPath]: yamlContent,
      },
    })

    const code = await runInstallMcp(["--uninstall", "--yes"])
    expect(code).toBe(0)

    const written = mockFs.writeFile.mock.calls.find(
      c => c[0] === aiderPath,
    )![1] as string
    expect(written).not.toContain("mcp_servers:")
    expect(written).toContain("other: val")
  })
})

// ── hermes config.yaml surgery (pure helpers) ────────────────────────────────

describe("upsertHermesMcpServer / removeHermesMcpServer (unit)", () => {
  // A hermes config.yaml with EXISTING mcp servers that must survive edits.
  const realish = `agent:
  max_turns: 60
mcp_servers:
  bureau:
    url: http://localhost:8830/mcp
    enabled: true
  guilde:
    url: https://api.guilde.work/guilde/mcp
    enabled: true
other_key:
  foo: bar
`
  const url = "http://127.0.0.1:18790/mcp"

  it("inserts agentproto as the first child, preserving every sibling", () => {
    const out = upsertHermesMcpServer(realish, "agentproto", url)
    expect(out).toContain("  bureau:")
    expect(out).toContain("http://localhost:8830/mcp")
    expect(out).toContain("  guilde:")
    expect(out).toContain("https://api.guilde.work/guilde/mcp")
    expect(out).toContain("other_key:")
    expect(out).toMatch(
      /mcp_servers:\n {2}agentproto:\n {4}url: http:\/\/127\.0\.0\.1:18790\/mcp\n {4}enabled: true\n {2}bureau:/,
    )
  })

  it("is idempotent — a second upsert with the same url is a no-op", () => {
    const once = upsertHermesMcpServer(realish, "agentproto", url)
    expect(upsertHermesMcpServer(once, "agentproto", url)).toBe(once)
  })

  it("updates the url in place, keeping siblings intact", () => {
    const once = upsertHermesMcpServer(realish, "agentproto", url)
    const updated = upsertHermesMcpServer(once, "agentproto", "http://127.0.0.1:9999/mcp")
    expect(updated).toContain("http://127.0.0.1:9999/mcp")
    expect(updated).not.toContain("18790")
    expect(updated).toContain("  bureau:")
    expect(updated).toContain("  guilde:")
  })

  it("converts inline-empty `mcp_servers: {}` to block form", () => {
    const out = upsertHermesMcpServer("foo: 1\nmcp_servers: {}\nbar: 2\n", "agentproto", url)
    expect(out).toMatch(/mcp_servers:\n {2}agentproto:/)
    expect(out).toContain("bar: 2")
  })

  it("appends a fresh block when mcp_servers is absent", () => {
    const out = upsertHermesMcpServer("foo: 1\nbar: 2\n", "agentproto", url)
    expect(out).toMatch(/mcp_servers:\n {2}agentproto:/)
    expect(out).toContain("foo: 1")
  })

  it("removes ONLY the agentproto sub-block, keeping siblings", () => {
    const once = upsertHermesMcpServer(realish, "agentproto", url)
    const removed = removeHermesMcpServer(once, "agentproto")
    expect(removed).not.toContain("agentproto")
    expect(removed).toContain("  bureau:")
    expect(removed).toContain("http://localhost:8830/mcp")
    expect(removed).toContain("  guilde:")
    expect(removed).toContain("other_key:")
  })

  it("remove is a no-op when agentproto is absent", () => {
    expect(removeHermesMcpServer(realish, "agentproto")).toBe(realish)
  })
})
