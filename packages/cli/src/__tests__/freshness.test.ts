/**
 * Tests for the read-only freshness probes (`registry/freshness.ts`) and
 * their two surfaces:
 *
 *   - `agentproto --version --check-updates` (cli.ts) — silent when current
 *     or offline; one update line only when positively behind.
 *   - `agentproto adapters outdated` (commands/adapters.ts) — per-adapter
 *     installed-vs-latest rows; read-only, degrades to "unknown".
 *
 * `npm view` / `npm ls -g` are mocked at the `node:child_process` seam —
 * no test here touches the real registry or a real global tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { spawnMock, listInstalledAdaptersMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  listInstalledAdaptersMock: vi.fn(),
}))

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: spawnMock }
})
vi.mock("../registry/resolve.js", () => ({
  resolveAdapter: vi.fn(),
  listInstalledAdapters: listInstalledAdaptersMock,
  listAdaptersWithCatalog: vi.fn(async () => []),
}))

import {
  compareVersions,
  freshnessVerdict,
  cliFreshnessLine,
  npmLatestVersion,
  npmInstalledVersion,
} from "../registry/freshness.js"
import { runAdapters } from "../commands/adapters.js"

/** Spawn stub resolving a scripted (cmd, args-prefix) → outcome. `stdout`
 *  is delivered via the `data` event before a clean exit. */
function spawnScript(
  table: Array<{
    cmd: string
    argsPrefix: string[]
    stdout?: string
    exit?: number
  }>
) {
  spawnMock.mockImplementation((cmd: string, args: string[]) => {
    const row = table.find(
      (r) => r.cmd === cmd && r.argsPrefix.every((p, i) => args[i] === p)
    )
    const child = {
      stdout: {
        on: (_e: string, cb: (c: Buffer) => void) => {
          if (row?.stdout) cb(Buffer.from(row.stdout))
        },
      },
      once: (event: string, cb: (c: number | Error) => void) => {
        if (event === "exit") queueMicrotask(() => cb(row?.exit ?? 0))
        return child
      },
      kill: () => {},
    }
    return child
  })
}

beforeEach(() => {
  spawnMock.mockReset()
  listInstalledAdaptersMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("freshness — compareVersions / freshnessVerdict", () => {
  it("orders patch/minor/major correctly", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.2", "1.2.3")).toBeLessThan(0)
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0)
  })

  it("verdict: behind only when installed is strictly older", () => {
    expect(freshnessVerdict("1.0.0", "1.0.1")).toBe("behind")
    expect(freshnessVerdict("1.0.0", "1.0.0")).toBe("current")
    expect(freshnessVerdict("1.1.0", "1.0.0")).toBe("current")
  })

  it("verdict: unknown when either side is missing or unparseable", () => {
    expect(freshnessVerdict(null, "1.0.0")).toBe("unknown")
    expect(freshnessVerdict("1.0.0", null)).toBe("unknown")
    expect(freshnessVerdict("next", "1.0.0")).toBe("unknown")
  })
})

describe("freshness — npm probes", () => {
  it("npmLatestVersion parses the registry answer", async () => {
    spawnScript([
      { cmd: "npm", argsPrefix: ["view", "pkg-a", "version"], stdout: "1.2.3\n" },
    ])
    expect(await npmLatestVersion("pkg-a")).toBe("1.2.3")
  })

  it("npmLatestVersion degrades to null on registry failure (offline/404)", async () => {
    spawnScript([
      { cmd: "npm", argsPrefix: ["view", "pkg-a", "version"], exit: 1 },
    ])
    expect(await npmLatestVersion("pkg-a")).toBeNull()
  })

  it("npmInstalledVersion reads the matching line of the global tree", async () => {
    spawnScript([
      {
        cmd: "npm",
        argsPrefix: ["ls", "-g", "pkg-a", "--depth=0"],
        stdout: "/usr/lib\n`-- pkg-a@4.5.6\n",
      },
    ])
    expect(await npmInstalledVersion("pkg-a")).toBe("4.5.6")
  })

  it("npmInstalledVersion returns null when the package is absent (exit 1, `(empty)`)", async () => {
    // A real miss prints the global root — which CONTAINS a node version —
    // so the package-name-anchored regex, not any loose \d+.\d+.\d+ match,
    // is what keeps this honest.
    spawnScript([
      {
        cmd: "npm",
        argsPrefix: ["ls", "-g", "pkg-a", "--depth=0"],
        exit: 1,
        stdout: "/Users/me/.nvm/versions/node/v22.22.0/lib\n`-- (empty)\n\n",
      },
    ])
    expect(await npmInstalledVersion("pkg-a")).toBeNull()
  })
})

describe("freshness — cliFreshnessLine (--version --check-updates)", () => {
  it("prints an update line only when positively behind", async () => {
    spawnScript([
      { cmd: "npm", argsPrefix: ["view", "@agentproto/cli", "version"], stdout: "9.9.9\n" },
    ])
    const line = await cliFreshnessLine("0.20.0")
    expect(line).toContain("9.9.9")
    expect(line).toContain("npm i -g @agentproto/cli")
  })

  it("stays silent when current", async () => {
    spawnScript([
      { cmd: "npm", argsPrefix: ["view", "@agentproto/cli", "version"], stdout: "0.20.0\n" },
    ])
    expect(await cliFreshnessLine("0.20.0")).toBeNull()
  })

  it("stays silent when the registry is unreachable (graceful degrade)", async () => {
    spawnScript([
      { cmd: "npm", argsPrefix: ["view", "@agentproto/cli", "version"], exit: 1 },
    ])
    expect(await cliFreshnessLine("0.20.0")).toBeNull()
  })
})

/** Capture stdout writes into an array. */
function captureStdio(): { out: string[]; restore: () => void } {
  const out: string[] = []
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((c: unknown) => {
      out.push(String(c))
      return true
    })
  return { out, restore: () => spy.mockRestore() }
}

describe("agentproto adapters outdated", () => {
  it("reports installed vs latest per adapter, read-only", async () => {
    listInstalledAdaptersMock.mockResolvedValue([
      {
        slug: "claude-code",
        name: "claude-code",
        packageName: "@agentproto/adapter-claude-code",
      },
      {
        slug: "opencode",
        name: "opencode",
        packageName: "@agentproto/adapter-opencode",
      },
    ])
    spawnScript([
      {
        cmd: "npm",
        argsPrefix: ["ls", "-g", "@agentproto/adapter-claude-code", "--depth=0"],
        stdout: "/usr/lib\n`-- @agentproto/adapter-claude-code@0.6.1\n",
      },
      {
        cmd: "npm",
        argsPrefix: ["view", "@agentproto/adapter-claude-code", "version"],
        stdout: "0.7.0\n",
      },
      {
        cmd: "npm",
        argsPrefix: ["ls", "-g", "@agentproto/adapter-opencode", "--depth=0"],
        exit: 1,
        stdout: "/usr/lib\n`-- (empty)\n",
      },
      {
        cmd: "npm",
        argsPrefix: ["view", "@agentproto/adapter-opencode", "version"],
        exit: 1,
      },
    ])
    const io = captureStdio()

    const code = await runAdapters(["outdated"])

    expect(code).toBe(0)
    const out = io.out.join("")
    expect(out).toMatch(/claude-code.*0\.6\.1 → 0\.7\.0.*update available/)
    expect(out).toMatch(/opencode.*freshness unknown/)
    io.restore()
  })

  it("--json emits structured rows with null on unknown", async () => {
    listInstalledAdaptersMock.mockResolvedValue([
      {
        slug: "opencode",
        name: "opencode",
        packageName: "@agentproto/adapter-opencode",
      },
    ])
    spawnScript([
      {
        cmd: "npm",
        argsPrefix: ["ls", "-g", "@agentproto/adapter-opencode", "--depth=0"],
        exit: 1,
        stdout: "/usr/lib\n`-- (empty)\n",
      },
      {
        cmd: "npm",
        argsPrefix: ["view", "@agentproto/adapter-opencode", "version"],
        stdout: "1.0.0\n",
      },
    ])
    const io = captureStdio()

    const code = await runAdapters(["outdated", "--json"])

    expect(code).toBe(0)
    const rows = JSON.parse(io.out.join("")) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      slug: "opencode",
      installed: null,
      latest: "1.0.0",
      status: "unknown",
    })
    io.restore()
  })
})
