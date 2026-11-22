/**
 * Unit tests for `agentproto adapters list|show|outdated` consistency,
 * specifically covering installed adapters that do NOT declare an
 * `agentproto/adapter/v1` runtime manifest:
 *
 *   1. AIP-45 agent-CLI adapters (e.g. `@agentproto/adapter-antigravity`,
 *      referenced either by bare slug `antigravity` or full package name);
 *   2. Legacy side-effect runtime adapters (installed npm package on disk
 *      with no `agentproto.json` / `package.json#agentproto`);
 *   3. Manifest-bearing runtime adapters (`agentproto/adapter/v1`);
 *   4. Missing / uninstalled adapters (both configured-only and unknown).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  readAdapterManifestMock,
  readAdapterPackageInfoMock,
  resolveAdapterMock,
  listInstalledAdaptersMock,
} = vi.hoisted(() => ({
  readAdapterManifestMock: vi.fn(),
  readAdapterPackageInfoMock: vi.fn(),
  resolveAdapterMock: vi.fn(),
  listInstalledAdaptersMock: vi.fn(),
}))

vi.mock("../registry/manifest-loader.js", () => ({
  readAdapterManifest: readAdapterManifestMock,
  readAdapterPackageInfo: readAdapterPackageInfoMock,
}))
vi.mock("../registry/resolve.js", () => ({
  resolveAdapter: resolveAdapterMock,
  listInstalledAdapters: listInstalledAdaptersMock,
  listAdaptersWithCatalog: vi.fn(async () => []),
}))

import { extractAdapterSlug, runAdapters } from "../commands/adapters.js"

let homeDir: string
let savedAgentprotoHome: string | undefined
let out: string[]
let err: string[]

function captureStdio(): void {
  out = []
  err = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
}

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(join(homeDir, "config.json"), JSON.stringify(cfg, null, 2))
}

function fakeAntigravityResolved() {
  return {
    slug: "antigravity",
    source: "npm" as const,
    packageName: "@agentproto/adapter-antigravity",
    packageVersion: "0.3.15",
    handle: {
      name: "antigravity",
      id: "antigravity",
      version: "0.2.0",
      description: "Google Antigravity's CLI (`agy acp`)",
      protocol: "acp",
      bin: "agy",
      bin_args: ["acp"],
      capabilities: {
        streaming: true,
        tool_calls: true,
        resumable: true,
        multimodal: false,
      },
      models: {
        allowed: ["gemini-3.8-flash-high", "claude-sonnet-4-6"],
      },
      modes: [{ id: "default", status: "active" }],
    },
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  readAdapterManifestMock.mockReset()
  readAdapterPackageInfoMock.mockReset()
  resolveAdapterMock.mockReset()
  listInstalledAdaptersMock.mockReset()

  readAdapterManifestMock.mockResolvedValue(null)
  readAdapterPackageInfoMock.mockResolvedValue(null)
  resolveAdapterMock.mockRejectedValue(new Error("not found"))
  listInstalledAdaptersMock.mockResolvedValue([])

  homeDir = mkdtempSync(join(tmpdir(), "agentproto-adapters-cli-"))
  savedAgentprotoHome = process.env["AGENTPROTO_HOME"]
  process.env["AGENTPROTO_HOME"] = homeDir
  captureStdio()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedAgentprotoHome === undefined) delete process.env["AGENTPROTO_HOME"]
  else process.env["AGENTPROTO_HOME"] = savedAgentprotoHome
  rmSync(homeDir, { recursive: true, force: true })
})

describe("extractAdapterSlug", () => {
  it("normalizes bare slugs and first-party adapter/harness package names", () => {
    expect(extractAdapterSlug("antigravity")).toBe("antigravity")
    expect(extractAdapterSlug("@agentproto/adapter-antigravity")).toBe("antigravity")
    expect(extractAdapterSlug("@agentproto/harness-claude-code")).toBe("claude-code")
    expect(extractAdapterSlug("@acme/agentproto-bridge")).toBeNull()
    expect(extractAdapterSlug("./local-adapter")).toBeNull()
  })
})

describe("agentproto adapters show — installed adapters without manifest", () => {
  it("shows an installed AIP-45 agent-CLI adapter when queried by bare slug", async () => {
    writeConfig({ adapters: ["@agentproto/adapter-antigravity"] })
    resolveAdapterMock.mockResolvedValue(fakeAntigravityResolved())

    const code = await runAdapters(["show", "antigravity"])

    expect(code).toBe(0)
    expect(err.join("")).toBe("")
    const stdout = out.join("")
    expect(stdout).toContain("antigravity (@agentproto/adapter-antigravity)")
    expect(stdout).toContain("kind: agent-cli (no runtime manifest)")
    expect(stdout).toContain("version: 0.3.15 (handle: 0.2.0)")
    expect(stdout).toContain("protocol: acp")
    expect(stdout).toContain("bin: agy acp")
    expect(stdout).toContain("enabled: yes")
    expect(stdout).toContain("models: gemini-3.8-flash-high, claude-sonnet-4-6")
  })

  it("shows the same AIP-45 adapter when queried by full package name with --json", async () => {
    writeConfig({ adapters: ["@agentproto/adapter-antigravity"] })
    resolveAdapterMock.mockResolvedValue(fakeAntigravityResolved())

    const code = await runAdapters([
      "show",
      "@agentproto/adapter-antigravity",
      "--json",
    ])

    expect(code).toBe(0)
    expect(resolveAdapterMock).toHaveBeenCalledWith("antigravity")
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>
    expect(parsed).toMatchObject({
      slug: "antigravity",
      package: "@agentproto/adapter-antigravity",
      kind: "agent-cli",
      manifest: null,
      source: "npm",
      version: "0.3.15",
      handleVersion: "0.2.0",
      protocol: "acp",
      bin: "agy",
      binArgs: ["acp"],
      models: ["gemini-3.8-flash-high", "claude-sonnet-4-6"],
      enabled: true,
    })
  })

  it("shows an installed legacy side-effect adapter without manifest (exit 0)", async () => {
    writeConfig({ adapters: ["@acme/legacy-substrate"] })
    readAdapterPackageInfoMock.mockResolvedValue({
      name: "@acme/legacy-substrate",
      version: "1.4.2",
      description: "Legacy side-effect plugin",
      packageRoot: "/tmp/node_modules/@acme/legacy-substrate",
      packageJsonPath: "/tmp/node_modules/@acme/legacy-substrate/package.json",
    })

    const code = await runAdapters(["show", "@acme/legacy-substrate"])

    expect(code).toBe(0)
    const stdout = out.join("")
    expect(stdout).toContain("@acme/legacy-substrate")
    expect(stdout).toContain("legacy side-effect adapter (no agentproto manifest)")
    expect(stdout).toContain("version: 1.4.2")
    expect(stdout).toContain("enabled: yes")
  })

  it("preserves manifest display for runtime manifest adapters", async () => {
    readAdapterManifestMock.mockResolvedValue({
      packageRoot: "/tmp/bridge",
      manifest: {
        schema: "agentproto/adapter/v1",
        substrates: [
          {
            kind: "acme-mcp",
            entry: "./dist/index.mjs",
            export: "acmeMcpSubstrateFactory",
          },
        ],
        dispatchers: [],
        executors: [],
        stateStores: [],
      },
    })

    const code = await runAdapters(["show", "@acme/agentproto-bridge", "--json"])

    expect(code).toBe(0)
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>
    expect(parsed.schema).toBe("agentproto/adapter/v1")
  })

  it("exits 1 with clear message when genuinely not installed", async () => {
    const code = await runAdapters(["show", "nonexistent-adapter"])

    expect(code).toBe(1)
    expect(err.join("")).toContain("'nonexistent-adapter' is not installed.")
    expect(err.join("")).not.toContain("doesn't declare an agentproto manifest")
  })

  it("exits 1 and flags config-only broken entries", async () => {
    writeConfig({ adapters: ["@acme/removed-adapter"] })

    const code = await runAdapters(["show", "@acme/removed-adapter"])

    expect(code).toBe(1)
    expect(err.join("")).toContain("enabled in config, but is not installed")
  })
})

describe("agentproto adapters list — consistent with discovered & legacy adapters", () => {
  it("reports enabled agent-CLI, legacy, missing, and discovered-only adapters coherently", async () => {
    writeConfig({
      adapters: [
        "@agentproto/adapter-antigravity",
        "@acme/legacy-plugin",
        "@acme/ghost-adapter",
      ],
    })
    listInstalledAdaptersMock.mockResolvedValue([
      {
        slug: "antigravity",
        name: "antigravity",
        version: "0.2.0",
        packageVersion: "0.3.15",
        description: "Google Antigravity",
        protocol: "acp",
        streaming: true,
        packageName: "@agentproto/adapter-antigravity",
        commands: [],
        models: [],
        modes: [],
        modelDetails: [],
      },
      {
        slug: "codex",
        name: "codex",
        version: "0.1.0",
        packageVersion: "2.1.4",
        description: "OpenAI Codex",
        protocol: "acp",
        streaming: true,
        packageName: "@agentproto/adapter-codex",
        commands: [],
        models: [],
        modes: [],
        modelDetails: [],
      },
    ])
    readAdapterPackageInfoMock.mockImplementation(async (id: string) => {
      if (id === "@acme/legacy-plugin") {
        return {
          name: "@acme/legacy-plugin",
          version: "0.9.0",
          packageRoot: "/tmp/legacy",
          packageJsonPath: "/tmp/legacy/package.json",
        }
      }
      return null
    })

    const code = await runAdapters(["list"])

    expect(code).toBe(0)
    const stdout = out.join("")
    expect(stdout).toContain("• @agentproto/adapter-antigravity")
    expect(stdout).toContain("agent-cli: antigravity (acp, v0.3.15)")
    expect(stdout).toContain("• @acme/legacy-plugin")
    expect(stdout).toContain("no manifest — legacy side-effect adapter, v0.9.0")
    expect(stdout).toContain("• @acme/ghost-adapter")
    expect(stdout).toContain("enabled in config, but not installed")
    expect(stdout).toContain("• @agentproto/adapter-codex")
    expect(stdout).toContain("agent-cli: codex (acp, v2.1.4) [installed, not in config]")
  })

  it("--json keeps backwards-compatible id/manifest keys and adds kind/version/enabled/installed", async () => {
    writeConfig({ adapters: ["@agentproto/adapter-antigravity"] })
    listInstalledAdaptersMock.mockResolvedValue([
      {
        slug: "antigravity",
        name: "antigravity",
        version: "0.2.0",
        packageVersion: "0.3.15",
        description: "Google Antigravity",
        protocol: "acp",
        streaming: true,
        packageName: "@agentproto/adapter-antigravity",
        commands: [],
        models: [],
        modes: [],
        modelDetails: [],
      },
    ])

    const code = await runAdapters(["list", "--json"])

    expect(code).toBe(0)
    const rows = JSON.parse(out.join("")) as Array<Record<string, unknown>>
    expect(rows).toEqual([
      {
        id: "@agentproto/adapter-antigravity",
        manifest: null,
        kind: "agent-cli",
        slug: "antigravity",
        version: "0.3.15",
        protocol: "acp",
        enabled: true,
        installed: true,
      },
    ])
  })
})
