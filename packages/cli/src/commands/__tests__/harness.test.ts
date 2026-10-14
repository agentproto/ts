/**
 * `agentproto harness` command dispatch — argv routing, help, exit codes,
 * and the JSON/text formatting, all driven through the injection seam so
 * nothing here resolves a real adapter or spawns a real harness.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { runHarness, type HarnessCommandOverrides } from "../harness.js"
import type { HarnessManifest, HarnessOutdatedRow, UpgradeResult } from "../../registry/harness.js"

const MANIFEST: HarnessManifest = {
  slug: "opencode",
  protocol: "acp",
  bin: "opencode",
  version_check: {
    cmd: "opencode --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0",
  },
  upgrade: {
    latest: { npm: "opencode-ai" },
    cmd: ["npm", "i", "-g", "opencode-ai@latest"],
  },
}

const ROW: HarnessOutdatedRow = {
  slug: "opencode",
  installed: "1.0.0",
  latest: "1.0.1",
  status: "behind",
  inRange: true,
  upgradable: true,
  note: "run `agentproto harness upgrade opencode`",
}

const UPGRADED: UpgradeResult = {
  slug: "opencode",
  outcome: "upgraded",
  before: "1.0.0",
  after: "1.0.1",
  command: ["npm", "i", "-g", "opencode-ai@latest"],
}

/** Capture one run's stdout + stderr, returning the exit code and text. */
async function run(
  args: string[],
  overrides: HarnessCommandOverrides = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  try {
    const code = await runHarness(args, overrides)
    return { code, out: out.join(""), err: err.join("") }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runHarness dispatch", () => {
  it("--help prints usage and exits 0", async () => {
    const { code, out } = await run(["--help"])
    expect(code).toBe(0)
    expect(out).toContain("agentproto harness")
    expect(out).toContain("outdated")
    expect(out).toContain("check")
    expect(out).toContain("upgrade")
  })

  it("no subcommand prints usage and exits 0", async () => {
    const { code, out } = await run([])
    expect(code).toBe(0)
    expect(out).toContain("agentproto harness")
  })

  it("an unknown subcommand exits 2", async () => {
    const { code, err } = await run(["bogus"])
    expect(code).toBe(2)
    expect(err).toContain("unknown subcommand 'bogus'")
  })
})

describe("harness outdated", () => {
  it("--json emits the rows and always exits 0", async () => {
    const { code, out } = await run(["outdated", "--json"], {
      collectRows: async () => [ROW],
    })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual([ROW])
  })

  it("prints a table with the per-row note", async () => {
    const { code, out } = await run(["outdated"], { collectRows: async () => [ROW] })
    expect(code).toBe(0)
    expect(out).toContain("SLUG")
    expect(out).toContain("opencode")
    expect(out).toContain("harness upgrade opencode")
  })

  it("a row-collection failure exits 1, not a crash", async () => {
    const { code, err } = await run(["outdated"], {
      collectRows: async () => {
        throw new Error("npm exploded")
      },
    })
    expect(code).toBe(1)
    expect(err).toContain("npm exploded")
  })
})

describe("harness check", () => {
  it("exits 0 on a compatible ACP harness", async () => {
    const { code, out } = await run(["check", "opencode"], {
      resolveManifest: async () => MANIFEST,
      smokeProbe: async () => ({ ok: true, protocolVersion: 1, loadSession: true }),
    })
    expect(code).toBe(0)
    expect(out).toContain("ACP ok")
    expect(out).toContain("loadSession")
  })

  it("exits 1 when the smoke probe fails, with the probe error on stderr", async () => {
    const { code, err } = await run(["check", "opencode"], {
      resolveManifest: async () => MANIFEST,
      smokeProbe: async () => ({ ok: false, error: "timed out after 30000ms" }),
    })
    expect(code).toBe(1)
    expect(err).toContain("timed out after 30000ms")
  })

  it("skips (exit 0) a non-ACP protocol", async () => {
    const { code, out } = await run(["check", "pi"], {
      resolveManifest: async () => ({ ...MANIFEST, slug: "pi", protocol: "proprietary" }),
      smokeProbe: async () => {
        throw new Error("must not be called")
      },
    })
    expect(code).toBe(0)
    expect(out).toContain("not ACP")
  })

  it("requires a <slug>", async () => {
    const { code, err } = await run(["check"])
    expect(code).toBe(2)
    expect(err).toContain("missing <slug>")
  })

  it("--json emits the probe result and maps ok to the exit code", async () => {
    const { code, out } = await run(["check", "opencode", "--json"], {
      resolveManifest: async () => MANIFEST,
      smokeProbe: async () => ({ ok: true, protocolVersion: 1 }),
    })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ slug: "opencode", ok: true, protocolVersion: 1 })
  })
})

describe("harness upgrade", () => {
  it("exits 0 for an upgrade that succeeded", async () => {
    const { code, out } = await run(["upgrade", "opencode"], {
      resolveManifest: async () => MANIFEST,
      upgrade: async () => UPGRADED,
    })
    expect(code).toBe(0)
    expect(out).toContain("1.0.0 → 1.0.1")
  })

  it("exits 1 when any slug was refused", async () => {
    const { code, err } = await run(["upgrade", "opencode"], {
      resolveManifest: async () => MANIFEST,
      upgrade: async () => ({
        slug: "opencode",
        outcome: "refused",
        before: "1.0.0",
        after: null,
        reason: "latest 2.0.0 is outside >=1.0.0",
      }),
    })
    expect(code).toBe(1)
    expect(err).toContain("refused — latest 2.0.0 is outside >=1.0.0")
  })

  it("exits 1 when an upgrade failed with no rollback, naming the previous version", async () => {
    const { code, err } = await run(["upgrade", "opencode"], {
      resolveManifest: async () => MANIFEST,
      upgrade: async () => ({
        slug: "opencode",
        outcome: "failed",
        before: "1.0.0",
        after: "1.0.1",
        reason: "smoke probe failed — no rollback declared; previous version was 1.0.0",
      }),
    })
    expect(code).toBe(1)
    expect(err).toContain("FAILED")
    expect(err).toContain("previous version was 1.0.0")
  })

  it("exits 1 when the upgrade was rolled back", async () => {
    const { code, err } = await run(["upgrade", "opencode"], {
      resolveManifest: async () => MANIFEST,
      upgrade: async () => ({
        slug: "opencode",
        outcome: "rolled-back",
        before: "1.0.0",
        after: "1.0.0",
        reason: "smoke probe failed — rolled back to 1.0.0",
      }),
    })
    expect(code).toBe(1)
    expect(err).toContain("rolled back to 1.0.0")
  })

  it("requires slugs or --all", async () => {
    const { code, err } = await run(["upgrade"])
    expect(code).toBe(2)
    expect(err).toContain("pass one or more <slug>s, or --all")
  })

  it("--json emits the aggregate result array", async () => {
    const { code, out } = await run(["upgrade", "opencode", "--json"], {
      resolveManifest: async () => MANIFEST,
      upgrade: async () => UPGRADED,
    })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual([UPGRADED])
  })

  it("refuses --all together with explicit slugs", async () => {
    const { code, err } = await run(["upgrade", "--all", "opencode"])
    expect(code).toBe(2)
    expect(err).toContain("--all takes no <slug> arguments")
  })

  it("an unresolvable slug exits 1 with the resolver's message", async () => {
    const { code, err } = await run(["upgrade", "ghost"], {
      resolveManifest: async () => {
        throw new Error("cannot find package '@agentproto/adapter-ghost'")
      },
    })
    expect(code).toBe(1)
    expect(err).toContain("adapter-ghost")
  })
})
