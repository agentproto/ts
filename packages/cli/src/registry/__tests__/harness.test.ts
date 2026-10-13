/**
 * Harness freshness + upgrade flow — the logic behind
 * `agentproto harness outdated|check|upgrade`.
 *
 * Everything network- or process-touching goes through the injectable
 * {@link HarnessProbes} seam (and the smoke-probe dep), so these tests
 * never touch npm, GitHub, or a real harness binary.
 */

import { describe, it, expect } from "vitest"
import {
  buildHarnessRow,
  collectHarnessRows,
  latestFromGithubRelease,
  latestFromNpm,
  parseNpxPin,
  resolveLatestVersion,
  upgradeHarness,
  versionInRange,
  type HarnessManifest,
  type HarnessProbes,
} from "../harness.js"

// ── fakes ─────────────────────────────────────────────────────────────

interface FakeState {
  /** Installed version reported by `version_check` (null = check fails). */
  installed: string | null
  /** Version `npm view <pkg> version` reports (null = offline/404). */
  latest: string | null
  /** Exit code of the next upgrade.cmd run (null = spawn failed). */
  upgradeCode?: number | null
  /** Exit code of the next rollback run (null = spawn failed). */
  rollbackCode?: number | null
  /** Installed version AFTER the upgrade cmd ran. */
  afterUpgrade?: string | null
  /** Installed version AFTER the rollback cmd ran. */
  afterRollback?: string | null
  /** Every argv the upgrade/rollback layer ran, in order. */
  runs: string[][]
}

function fakeProbes(state: FakeState): HarnessProbes {
  return {
    async exec(cmd, args) {
      if (cmd === "bash") {
        return state.installed === null
          ? { code: 1, stdout: "" }
          : { code: 0, stdout: `opencode ${state.installed}\n` }
      }
      if (cmd === "npm" && args[0] === "view") {
        return state.latest === null ? null : { code: 0, stdout: `${state.latest}\n` }
      }
      return null
    },
    async fetchJson() {
      return null
    },
    async run(cmd, args) {
      state.runs.push([cmd, ...args])
      // The upgrade flow runs at most one upgrade then one rollback, in
      // order — run #2 is the rollback.
      if (state.runs.length > 1) {
        state.installed = state.afterRollback ?? null
        return state.rollbackCode ?? 0
      }
      state.installed = state.afterUpgrade ?? null
      return state.upgradeCode ?? 0
    },
  }
}

const ACP_MANIFEST: HarnessManifest = {
  slug: "opencode",
  protocol: "acp",
  bin: "opencode",
  version_check: {
    cmd: "opencode --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0 <2.0.0",
  },
  upgrade: {
    latest: { npm: "opencode-ai" },
    cmd: ["npm", "i", "-g", "opencode-ai@latest"],
    rollback: ["npm", "i", "-g", "opencode-ai@{version}"],
  },
}

// ── latest resolution ─────────────────────────────────────────────────

describe("latestFromNpm", () => {
  it("reads the first semver from `npm view <pkg> version`", async () => {
    const probes: HarnessProbes = {
      exec: async () => ({ code: 0, stdout: "1.2.3\n" }),
      fetchJson: async () => null,
      run: async () => 0,
    }
    expect(await latestFromNpm("some-pkg", probes)).toBe("1.2.3")
  })

  it("returns null on a non-zero exit or a failed spawn", async () => {
    const badExit: HarnessProbes = {
      exec: async () => ({ code: 1, stdout: "1.2.3\n" }),
      fetchJson: async () => null,
      run: async () => 0,
    }
    const failed: HarnessProbes = {
      exec: async () => null,
      fetchJson: async () => null,
      run: async () => 0,
    }
    expect(await latestFromNpm("some-pkg", badExit)).toBeNull()
    expect(await latestFromNpm("some-pkg", failed)).toBeNull()
  })
})

describe("latestFromGithubRelease", () => {
  it("reads tag_name and strips a leading v", async () => {
    const probes: HarnessProbes = {
      exec: async () => null,
      fetchJson: async () => ({ tag_name: "v2.1.0" }),
      run: async () => 0,
    }
    expect(await latestFromGithubRelease("owner/repo", probes)).toBe("2.1.0")
  })

  it("accepts an unprefixed numeric tag", async () => {
    const probes: HarnessProbes = {
      exec: async () => null,
      fetchJson: async () => ({ tag_name: "2.1.0" }),
      run: async () => 0,
    }
    expect(await latestFromGithubRelease("owner/repo", probes)).toBe("2.1.0")
  })

  it("degrades to null on offline, missing tag, or a non-numeric tag", async () => {
    const offline: HarnessProbes = {
      exec: async () => null,
      fetchJson: async () => null,
      run: async () => 0,
    }
    const noTag: HarnessProbes = { ...offline, fetchJson: async () => ({}) }
    const nightly: HarnessProbes = { ...offline, fetchJson: async () => ({ tag_name: "nightly" }) }
    expect(await latestFromGithubRelease("owner/repo", offline)).toBeNull()
    expect(await latestFromGithubRelease("owner/repo", noTag)).toBeNull()
    expect(await latestFromGithubRelease("owner/repo", nightly)).toBeNull()
  })
})

describe("resolveLatestVersion", () => {
  it("routes the npm arm to npm and the githubRelease arm to the API", async () => {
    const probes: HarnessProbes = {
      exec: async (cmd, args) =>
        cmd === "npm" && args[0] === "view" && args[1] === "pkg-a"
          ? { code: 0, stdout: "3.0.0\n" }
          : null,
      fetchJson: async (url) =>
        url.includes("owner/repo") ? { tag_name: "v9.9.9" } : null,
      run: async () => 0,
    }
    expect(await resolveLatestVersion({ npm: "pkg-a" }, probes)).toBe("3.0.0")
    expect(await resolveLatestVersion({ githubRelease: "owner/repo" }, probes)).toBe("9.9.9")
  })
})

// ── pin parsing ───────────────────────────────────────────────────────

describe("parseNpxPin", () => {
  it("parses a pinned scoped package from bin_args", () => {
    expect(parseNpxPin("npx", ["-y", "@agentclientprotocol/claude-agent-acp@1.2.3"])).toEqual({
      package: "@agentclientprotocol/claude-agent-acp",
      version: "1.2.3",
    })
  })

  it("parses a pinned unscoped package from bin_args", () => {
    expect(parseNpxPin("npx", ["-y", "codex@0.45.0"])).toEqual({
      package: "codex",
      version: "0.45.0",
    })
  })

  it("ignores channel selectors and bare packages — only a real pin freezes", () => {
    expect(parseNpxPin("npx", ["-y", "pkg@latest"])).toBeNull()
    expect(parseNpxPin("npx", ["-y", "pkg"])).toBeNull()
  })

  it("is null for non-npx bins (a global install, not a pin)", () => {
    expect(parseNpxPin("opencode", ["serve"])).toBeNull()
    expect(parseNpxPin(undefined, ["-y", "pkg@1.0.0"])).toBeNull()
  })

  it("recognises an npx shim path (Windows .cmd suffix)", () => {
    expect(parseNpxPin("C:\\Program Files\\npx.cmd", ["-y", "pkg@1.0.0"])).toEqual({
      package: "pkg",
      version: "1.0.0",
    })
  })
})

// ── range guard ───────────────────────────────────────────────────────

describe("versionInRange", () => {
  it("handles comparators", () => {
    expect(versionInRange("1.2.3", ">=1.0.0")).toBe(true)
    expect(versionInRange("1.2.3", ">=2.0.0")).toBe(false)
    expect(versionInRange("1.2.3", "<2.0.0")).toBe(true)
    expect(versionInRange("2.0.0", "<2.0.0")).toBe(false)
  })

  it("handles caret and tilde", () => {
    expect(versionInRange("1.9.0", "^1.2.3")).toBe(true)
    expect(versionInRange("2.0.0", "^1.2.3")).toBe(false)
    expect(versionInRange("1.2.9", "~1.2.3")).toBe(true)
    expect(versionInRange("1.3.0", "~1.2.3")).toBe(false)
  })

  it("handles bare partial ranges per npm", () => {
    expect(versionInRange("20.1.0", "20")).toBe(true)
    expect(versionInRange("21.0.0", "20")).toBe(false)
    expect(versionInRange("1.2.9", "1.2")).toBe(true)
    expect(versionInRange("1.3.0", "1.2")).toBe(false)
  })

  it("handles space-separated conjunctions, || groups, and *", () => {
    expect(versionInRange("0.13.5", ">=0.13.0 <1.0.0")).toBe(true)
    expect(versionInRange("1.0.0", ">=0.13.0 <1.0.0")).toBe(false)
    expect(versionInRange("2.0.0", "1.x || 2.0.0")).toBe(true)
    expect(versionInRange("3.4.5", "*")).toBe(true)
  })

  it("a release outranks its own prereleases", () => {
    expect(versionInRange("1.0.0-rc.1", ">=1.0.0")).toBe(false)
    expect(versionInRange("1.0.1-rc.1", ">=1.0.0")).toBe(true)
  })

  it("degrades to null (unknown, never guessed) on junk", () => {
    expect(versionInRange("not-a-version", ">=1.0.0")).toBeNull()
    expect(versionInRange("1.2.3", "wat")).toBeNull()
  })
})

// ── outdated row ──────────────────────────────────────────────────────

describe("buildHarnessRow", () => {
  it("reports a pinned-npx harness against the registry, never upgradable", async () => {
    const probes: HarnessProbes = {
      exec: async (cmd, args) =>
        cmd === "npm" && args[0] === "view"
          ? { code: 0, stdout: "1.0.31\n" }
          : { code: 0, stdout: "unused" },
      fetchJson: async () => null,
      run: async () => 0,
    }
    const row = await buildHarnessRow(
      {
        slug: "claude-code",
        protocol: "acp",
        bin: "npx",
        bin_args: ["-y", "@agentclientprotocol/claude-agent-acp@1.0.12"],
        version_check: { cmd: "true", parse: "(\\d+\\.\\d+\\.\\d+)", range: ">=1.0.0" },
      },
      probes,
    )
    expect(row.status).toBe("pinned")
    expect(row.installed).toBe("1.0.12")
    expect(row.latest).toBe("1.0.31")
    expect(row.upgradable).toBe(false)
    expect(row.note).toContain("bump the pin")
  })

  it("reports an upgradable harness that is behind", async () => {
    const probes = fakeProbes({
      installed: "1.0.0",
      latest: "1.0.1",
      runs: [],
    })
    const row = await buildHarnessRow(ACP_MANIFEST, probes)
    expect(row.status).toBe("behind")
    expect(row.inRange).toBe(true)
    expect(row.upgradable).toBe(true)
    expect(row.note).toContain("harness upgrade opencode")
  })

  it("marks behind-but-out-of-range as NOT upgradable", async () => {
    const probes = fakeProbes({ installed: "1.9.0", latest: "2.0.0", runs: [] })
    const row = await buildHarnessRow(ACP_MANIFEST, probes)
    expect(row.status).toBe("behind")
    expect(row.inRange).toBe(false)
    expect(row.upgradable).toBe(false)
    expect(row.note).toContain("outside")
  })

  it("degrades an unresolvable adapter to an unknown row", async () => {
    const rows = await collectHarnessRows({
      listSlugs: async () => [{ slug: "ghost" }],
      resolveSlug: async () => {
        throw new Error("cannot find package '@agentproto/adapter-ghost'")
      },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("unknown")
    expect(rows[0]?.note).toContain("could not resolve adapter")
  })
})

// ── upgrade flow ──────────────────────────────────────────────────────

describe("upgradeHarness", () => {
  it("upgrades in place and reports the new version when the probe passes", async () => {
    const state: FakeState = {
      installed: "1.0.0",
      latest: "1.0.1",
      afterUpgrade: "1.0.1",
      runs: [],
    }
    const result = await upgradeHarness(ACP_MANIFEST, {
      deps: {
        probes: fakeProbes(state),
        smokeProbe: async () => ({ ok: true, protocolVersion: 1 }),
        hasLiveSessions: async () => false,
      },
    })
    expect(result.outcome).toBe("upgraded")
    expect(result.before).toBe("1.0.0")
    expect(result.after).toBe("1.0.1")
    expect(result.command).toEqual(["npm", "i", "-g", "opencode-ai@latest"])
    expect(state.runs).toHaveLength(1)
  })

  it("runs the declared rollback with the previous version when the probe fails", async () => {
    const state: FakeState = {
      installed: "1.0.0",
      latest: "1.0.1",
      afterUpgrade: "1.0.1",
      afterRollback: "1.0.0",
      rollbackCode: 0,
      runs: [],
    }
    const result = await upgradeHarness(ACP_MANIFEST, {
      deps: {
        probes: fakeProbes(state),
        smokeProbe: async () => ({ ok: false, error: "session/new timed out" }),
        hasLiveSessions: async () => false,
      },
    })
    expect(result.outcome).toBe("rolled-back")
    expect(result.before).toBe("1.0.0")
    expect(result.after).toBe("1.0.0")
    expect(state.runs[1]).toEqual(["npm", "i", "-g", "opencode-ai@1.0.0"])
    expect(result.reason).toContain("session/new timed out")
    expect(result.reason).toContain("rolled back to 1.0.0")
  })

  it("fails loudly naming the previous version when no rollback is declared", async () => {
    const manifest: HarnessManifest = {
      ...ACP_MANIFEST,
      upgrade: { latest: { npm: "opencode-ai" }, cmd: ["opencode", "update"] },
    }
    const state: FakeState = {
      installed: "1.0.0",
      latest: "1.0.1",
      afterUpgrade: "1.0.1",
      runs: [],
    }
    const result = await upgradeHarness(manifest, {
      deps: {
        probes: fakeProbes(state),
        smokeProbe: async () => ({ ok: false, error: "protocol mismatch" }),
        hasLiveSessions: async () => false,
      },
    })
    expect(result.outcome).toBe("failed")
    expect(result.reason).toContain("no rollback declared")
    expect(result.reason).toContain("previous version was 1.0.0")
    expect(state.runs).toHaveLength(1) /* upgrade only — nothing to roll back with */
  })

  it("refuses when latest falls outside version_check.range, upgrades with --force", async () => {
    const state: FakeState = {
      installed: "1.9.0",
      latest: "2.0.0",
      afterUpgrade: "2.0.0",
      runs: [],
    }
    const probes = fakeProbes(state)
    const refused = await upgradeHarness(ACP_MANIFEST, {
      deps: { probes, smokeProbe: async () => ({ ok: true }), hasLiveSessions: async () => false },
    })
    expect(refused.outcome).toBe("refused")
    expect(refused.reason).toContain(">=1.0.0 <2.0.0")
    expect(state.runs).toHaveLength(0)

    const forced = await upgradeHarness(ACP_MANIFEST, {
      force: true,
      deps: { probes, smokeProbe: async () => ({ ok: true }), hasLiveSessions: async () => false },
    })
    expect(forced.outcome).toBe("upgraded")
    expect(state.runs).toHaveLength(1)
  })

  it("refuses while a live daemon session of the adapter exists", async () => {
    const state: FakeState = {
      installed: "1.0.0",
      latest: "1.0.1",
      afterUpgrade: "1.0.1",
      runs: [],
    }
    const result = await upgradeHarness(ACP_MANIFEST, {
      deps: {
        probes: fakeProbes(state),
        smokeProbe: async () => ({ ok: true }),
        hasLiveSessions: async () => true,
      },
    })
    expect(result.outcome).toBe("refused")
    expect(result.reason).toContain("live session")
    expect(state.runs).toHaveLength(0)
  })

  it("--dry-run prints the command and runs nothing", async () => {
    const state: FakeState = { installed: "1.0.0", latest: "1.0.1", runs: [] }
    const result = await upgradeHarness(ACP_MANIFEST, {
      dryRun: true,
      deps: { probes: fakeProbes(state), hasLiveSessions: async () => false },
    })
    expect(result.outcome).toBe("dry-run")
    expect(result.command).toEqual(["npm", "i", "-g", "opencode-ai@latest"])
    expect(state.runs).toHaveLength(0)
  })

  it("reports 'current' (exit 0) when already at the latest version", async () => {
    const state: FakeState = { installed: "1.0.1", latest: "1.0.1", runs: [] }
    const result = await upgradeHarness(ACP_MANIFEST, {
      deps: { probes: fakeProbes(state), hasLiveSessions: async () => false },
    })
    expect(result.outcome).toBe("current")
    expect(state.runs).toHaveLength(0)
  })

  it("refuses an adapter that declares no upgrade command (pin lives in the repo)", async () => {
    const manifest: HarnessManifest = {
      slug: "claude-code",
      protocol: "acp",
      bin: "npx",
      bin_args: ["-y", "pkg@1.0.0"],
      version_check: { cmd: "true", parse: "(\\d+\\.\\d+\\.\\d+)", range: ">=1.0.0" },
    }
    const result = await upgradeHarness(manifest, {
      deps: { probes: fakeProbes({ installed: null, latest: null, runs: [] }) },
    })
    expect(result.outcome).toBe("refused")
    expect(result.reason).toContain("bump the pin")
  })

  it("skips the ACP smoke probe for a non-ACP protocol and judges by version_check", async () => {
    const manifest: HarnessManifest = {
      ...ACP_MANIFEST,
      slug: "pi",
      protocol: "proprietary",
    }
    const state: FakeState = {
      installed: "1.0.0",
      latest: "1.0.1",
      afterUpgrade: "1.0.1",
      runs: [],
    }
    const result = await upgradeHarness(manifest, {
      deps: {
        probes: fakeProbes(state),
        smokeProbe: async () => {
          throw new Error("must not be called for a proprietary protocol")
        },
        hasLiveSessions: async () => false,
      },
    })
    expect(result.outcome).toBe("upgraded")
    expect(result.note).toContain("not ACP")
  })
})
