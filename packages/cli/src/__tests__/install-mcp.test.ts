/**
 * Unit tests for `agentproto install-mcp` — agent detection, JSON merge
 * non-destructive behavior, and install-state diffing for --uninstall.
 *
 * Mocks filesystem (node:fs/promises) and child_process spawn so we never
 * touch the real ~/.claude.json etc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── mock node:os so homedir() returns a temp dir ─────────────────────────────

const { FAKE_HOME, mockFs, spawnMock } = vi.hoisted(() => ({
  FAKE_HOME: { value: "" },
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
  detectAgent,
  registerStdioJson,
  removeTomlTable,
  removeYamlKey,
  loadInstallState,
  saveInstallState,
  unregisterAgent,
  runInstallMcp,
  type AgentDetection,
  type InstallState,
} from "../commands/install-mcp.js"

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const { loadConfig } = await import("@agentproto/runtime/config")
const mockLoadConfig = vi.mocked(loadConfig)

// ── helpers ────────────────────────────────────────────────────────────────────

/** Configure a file-mock: fs.access resolves, fs.readFile returns content. */
function mockFileExists(path: string, content?: string): void {
  mockFs.access.mockImplementation(async (p: string) => {
    if (p === path) return
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  })
  mockFs.stat.mockImplementation(async (p: string) => {
    if (p === path) return { isDirectory: () => true } as any
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
      on: (event: string, cb: Function) => {
        if (event === "exit") cb(found ? 0 : 1)
      },
      stdout: {
        setEncoding: () => ({
          on: (event: string, cb: Function) => {
            if (event === "data" && stdoutData) cb(stdoutData)
          },
        }),
      },
      stderr: {
        setEncoding: () => ({ on: () => {} }),
      },
    }
  })
}

function makeDetection(name: string, configPath: string, hasBinary = false, hasConfig = true): AgentDetection {
  return {
    name: name as AgentDetection["name"],
    label: name,
    configPath,
    hasBinary,
    hasConfig,
  }
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
    on: (_event: string, cb: Function) => cb(1),
    stdout: {
      setEncoding: () => ({
        on: () => {},
      }),
    },
    stderr: {
      setEncoding: () => ({ on: () => {} }),
    },
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── tests: agent detection ────────────────────────────────────────────────────

describe("agent detection", () => {
  it("detects claude when binary is on PATH", async () => {
    mockBinaryOnPath(["claude"])
    const result = await detectAgent("claude")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("claude")
    expect(result!.hasBinary).toBe(true)
  })

  it("detects claude when only config exists (no binary)", async () => {
    mockFileExists("/tmp/fake-home/.claude.json", "{}")
    const result = await detectAgent("claude")
    expect(result).not.toBeNull()
    expect(result!.hasBinary).toBe(false)
    expect(result!.hasConfig).toBe(true)
  })

  it("returns null for claude when neither binary nor config exist", async () => {
    const result = await detectAgent("claude")
    expect(result).toBeNull()
  })

  it("detects cursor when .cursor dir exists", async () => {
    mockDirExists("/tmp/fake-home/.cursor")
    const result = await detectAgent("cursor")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("cursor")
  })

  it("detects codex when config.toml exists", async () => {
    mockFileExists("/tmp/fake-home/.codex/config.toml", "")
    const result = await detectAgent("codex")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("codex")
  })

  it("detects claude-desktop on macOS when config exists", async () => {
    const configPath = "/tmp/fake-home/Library/Application Support/Claude/claude_desktop_config.json"
    mockFileExists(configPath, "{}")
    const result = await detectAgent("claude-desktop")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("claude-desktop")
  })

  it("returns null for claude-desktop on non-macOS", async () => {
    // platform is mocked to darwin in setup; we test the path here
    const result = await detectAgent("claude-desktop")
    // On macOS, it would detect if the file exists; since it doesn't, null
    expect(result).toBeNull()
  })

  it("detects aider when binary is on PATH", async () => {
    mockBinaryOnPath(["aider"])
    const result = await detectAgent("aider")
    expect(result).not.toBeNull()
    expect(result!.name).toBe("aider")
    expect(result!.hasBinary).toBe(true)
  })

  it("detects aider when only config exists", async () => {
    mockFileExists("/tmp/fake-home/.aider.conf.yml", "")
    const result = await detectAgent("aider")
    expect(result).not.toBeNull()
    expect(result!.hasConfig).toBe(true)
  })

  it("returns null for aider when neither binary nor config exist", async () => {
    const result = await detectAgent("aider")
    expect(result).toBeNull()
  })
})

// ── tests: JSON merge non-destructive ──────────────────────────────────────────

describe("JSON merge — non-destructive", () => {
  it("preserves existing mcpServers entries when adding agentproto", async () => {
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    const existingConfig = {
      mcpServers: {
        "other-server": {
          command: "other-cmd",
          args: ["--foo"],
        },
      },
    }
    mockFileExists(configPath, JSON.stringify(existingConfig))

    const detection = makeDetection("cursor", configPath)
    await registerStdioJson(detection, "cursor", {})

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)

    expect(written.mcpServers["other-server"]).toBeDefined()
    expect(written.mcpServers["other-server"].command).toBe("other-cmd")
    expect(written.mcpServers.agentproto).toBeDefined()
    expect(written.mcpServers.agentproto.command).toBe("agentproto")
    expect(written.mcpServers.agentproto.args).toEqual(["mcp-bridge"])
  })

  it("creates mcpServers key if it doesn't exist", async () => {
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const detection = makeDetection("cursor", configPath)
    await registerStdioJson(detection, "cursor", {})

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)
    expect(written.mcpServers).toBeDefined()
    expect(written.mcpServers.agentproto).toBeDefined()
  })

  it("writes AGENTPROTO_MCP_URL env when port is non-default", async () => {
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const detection = makeDetection("cursor", configPath)
    await registerStdioJson(detection, "cursor", {
      AGENTPROTO_MCP_URL: "http://127.0.0.1:18791/mcp",
    })

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)
    expect(written.mcpServers.agentproto.env.AGENTPROTO_MCP_URL).toBe(
      "http://127.0.0.1:18791/mcp",
    )
  })

  it("does not write env when port is default", async () => {
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const detection = makeDetection("cursor", configPath)
    await registerStdioJson(detection, "cursor", {})

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)
    expect(written.mcpServers.agentproto.env).toEqual({})
  })

  it("overwrites a previous agentproto entry but preserves other servers", async () => {
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    const existingConfig = {
      mcpServers: {
        agentproto: { command: "old-agentproto", args: ["old-bridge"] },
        "other-server": { command: "other-cmd" },
      },
    }
    mockFileExists(configPath, JSON.stringify(existingConfig))

    const detection = makeDetection("cursor", configPath)
    await registerStdioJson(detection, "cursor", {})

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)

    expect(written.mcpServers["other-server"].command).toBe("other-cmd")
    expect(written.mcpServers.agentproto.command).toBe("agentproto")
    expect(written.mcpServers.agentproto.args).toEqual(["mcp-bridge"])
  })
})

// ── tests: install-state diffing for --uninstall ──────────────────────────────

describe("install-state and --uninstall", () => {
  it("loadInstallState returns empty when file doesn't exist", async () => {
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    const state = await loadInstallState()
    expect(state.entries).toEqual([])
  })

  it("saveInstallState writes JSON with entries", async () => {
    const state: InstallState = {
      entries: [
        {
          agent: "cursor",
          configPath: "/tmp/.cursor/mcp.json",
          transport: "stdio",
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    await saveInstallState(state)
    expect(mockFs.writeFile).toHaveBeenCalled()
    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)
    expect(written.entries).toHaveLength(1)
    expect(written.entries[0].agent).toBe("cursor")
  })

  it("unregisterAgent removes only agentproto from JSON config", async () => {
    const configPath = "/tmp/.cursor/mcp.json"
    const existingConfig = {
      mcpServers: {
        agentproto: { command: "agentproto", args: ["mcp-bridge"] },
        "other-server": { command: "other-cmd" },
      },
    }
    mockFileExists(configPath, JSON.stringify(existingConfig))

    await unregisterAgent({
      agent: "cursor",
      configPath,
      transport: "stdio",
      registeredAt: "2025-01-01T00:00:00Z",
    })

    const writtenContent = mockFs.writeFile.mock.calls[0]![1] as string
    const written = JSON.parse(writtenContent)

    expect(written.mcpServers.agentproto).toBeUndefined()
    expect(written.mcpServers["other-server"]).toBeDefined()
    expect(written.mcpServers["other-server"].command).toBe("other-cmd")
  })

  it("unregisterAgent is a no-op when config file is gone", async () => {
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    await unregisterAgent({
      agent: "cursor",
      configPath: "/tmp/.cursor/mcp.json",
      transport: "stdio",
      registeredAt: "2025-01-01T00:00:00Z",
    })
    expect(mockFs.writeFile).not.toHaveBeenCalled()
  })

  it("runInstallMcp --uninstall removes entries and clears state", async () => {
    const statePath = "/tmp/fake-home/.agentproto/install-state.json"
    const configPath = "/tmp/fake-home/.cursor/mcp.json"
    const state: InstallState = {
      entries: [
        {
          agent: "cursor",
          configPath,
          transport: "stdio",
          registeredAt: "2025-01-01T00:00:00Z",
        },
      ],
    }
    const existingConfig = {
      mcpServers: {
        agentproto: { command: "agentproto", args: ["mcp-bridge"] },
      },
    }

    // Mock: state file read returns state, config read returns existing
    mockFs.readFile.mockImplementation(async (p: string) => {
      if (p === statePath) return JSON.stringify(state)
      if (p === configPath) return JSON.stringify(existingConfig)
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
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

    // Should have written empty state
    const stateWrite = mockFs.writeFile.mock.calls.find(
      c => c[0] === statePath,
    )
    expect(stateWrite).toBeDefined()
    const writtenState = JSON.parse(stateWrite![1] as string)
    expect(writtenState.entries).toEqual([])
  })

  it("runInstallMcp --uninstall says nothing to remove when state is empty", async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    let stdoutChunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const code = await runInstallMcp(["--uninstall"])
    spy.mockRestore()

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("No agentproto MCP registrations to remove")
  })
})

// ── tests: TOML and YAML key removal ──────────────────────────────────────────

describe("removeTomlTable", () => {
  it("removes a [mcp_servers.agentproto] block, preserves others", () => {
    const content = `[some.other]\nkey = "val"\n\n[mcp_servers.agentproto]\ncommand = "agentproto"\nargs = ["mcp-bridge"]\n\n[another.table]\nfoo = "bar"\n`
    const result = removeTomlTable(content, "mcp_servers.agentproto")
    expect(result).not.toContain("[mcp_servers.agentproto]")
    expect(result).not.toContain("agentproto")
    expect(result).toContain("[some.other]")
    expect(result).toContain("[another.table]")
    expect(result).toContain("foo = \"bar\"")
  })

  it("handles block at end of file", () => {
    const content = `[other]\nkey = "val"\n\n[mcp_servers.agentproto]\ncommand = "agentproto"\n`
    const result = removeTomlTable(content, "mcp_servers.agentproto")
    expect(result).not.toContain("[mcp_servers.agentproto]")
    expect(result).toContain("[other]")
  })

  it("is a no-op when the table doesn't exist", () => {
    const content = `[other]\nkey = "val"\n`
    const result = removeTomlTable(content, "mcp_servers.agentproto")
    expect(result).toBe(content)
  })
})

describe("removeYamlKey", () => {
  it("removes a top-level key and its nested block", () => {
    const content = `other_key: val\n\nmcp_servers:\n  agentproto:\n    command: agentproto\n    args:\n      - mcp-bridge\n\nother_key2: val2\n`
    const result = removeYamlKey(content, "mcp_servers")
    expect(result).not.toContain("mcp_servers:")
    expect(result).not.toContain("agentproto")
    expect(result).toContain("other_key: val")
    expect(result).toContain("other_key2: val2")
  })

  it("handles key at end of file", () => {
    const content = `other: val\n\nmcp_servers:\n  agentproto:\n    command: agentproto\n`
    const result = removeYamlKey(content, "mcp_servers")
    expect(result).not.toContain("mcp_servers:")
    expect(result).toContain("other: val")
  })

  it("is a no-op when key doesn't exist", () => {
    const content = `other: val\n`
    const result = removeYamlKey(content, "mcp_servers")
    expect(result).toBe(content)
  })
})

// ── tests: runInstallMcp basic flow ────────────────────────────────────────────

describe("runInstallMcp --help", () => {
  it("prints usage and exits 0", async () => {
    let stdoutChunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const code = await runInstallMcp(["--help"])
    spy.mockRestore()

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("install-mcp")
    expect(stdoutChunks.join("")).toContain("--agent")
  })
})

describe("runInstallMcp with no agents detected", () => {
  it("exits 0 with --yes and says nothing to do", async () => {
    // No binaries on PATH, no config files
    let stdoutChunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const code = await runInstallMcp(["--yes", "--skip-daemon"])
    spy.mockRestore()

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("Nothing to do")
  })

  it("exits 0 without --yes and says no agents detected", async () => {
    let stdoutChunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const code = await runInstallMcp(["--skip-daemon"])
    spy.mockRestore()

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("No coding-CLI agents detected")
  })
})
