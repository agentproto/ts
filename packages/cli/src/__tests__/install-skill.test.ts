/**
 * Tests for `agentproto install skill/<slug>`.
 *
 * Two layers:
 *  - Unit tests for the pure exported helpers (`parseSkillFrontmatter`,
 *    `compareSemver`) — no child process, no writes.
 *  - Integration tests that spawn the BUILT CLI (`packages/cli/dist/cli.mjs`)
 *    via `spawnSync` to exercise the end-to-end verb. These REQUIRE the CLI
 *    to be built first (`pnpm --filter @agentproto/cli build`) — vitest does
 *    not rebuild. There is no mocking: writes go to `os.tmpdir()` or are
 *    dry-run, and `HOME` is overridden to a throwaway path so a stray hermes
 *    install can never touch the real `~/.hermes`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import {
  parseSkillFrontmatter,
  compareSemver,
  upsertSkillManifestEntry,
  loadSkillsManifest,
  isSymlink,
  freshCopyDir,
} from "../commands/install-skill.js"
import { resolveSkillPackDir } from "../commands/skill-install/pack-resolve.js"
import { isAdapterSkillsTarget } from "../commands/skill-install/types.js"

// ── repo root + pack resolution (test helpers) ─────────────────────────

const REPO_ROOT = (() => {
  // walk up from this test file to find the repo root (where .skills/ lives)
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".skills"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
})()

/** Resolve whichever agentproto-plugin-v* pack is checked out. */
function packSkillsDir(): string {
  const skillsRoot = join(REPO_ROOT, ".skills")
  const pack = readdirSync(skillsRoot).find((e) =>
    e.startsWith("agentproto-plugin-v"),
  )
  if (!pack) throw new Error("no agentproto-plugin-v* pack found under .skills")
  return join(skillsRoot, pack, "skills")
}

/**
 * Run `agentproto install skill/<slug>` via a child process using the built
 * CLI output (requires a prior build). HOME is overridden so a real install
 * can never touch the user's `~/.hermes`.
 */
function runCli(args: string[]): {
  stdout: string
  stderr: string
  code: number | null
} {
  const cliEntry = join(REPO_ROOT, "packages/cli/dist/cli.mjs")
  const result = spawnSync("node", [cliEntry, "install", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: join(tmpdir(), "agentproto-fake-home") },
    timeout: 15_000,
  })
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    code: result.status,
  }
}

// ── unit: pure helpers ─────────────────────────────────────────────────

describe("parseSkillFrontmatter (unit)", () => {
  it("parses name + description from a real SKILL.md", async () => {
    const dir = join(packSkillsDir(), "agent-session-orchestration-agentproto")
    const info = await parseSkillFrontmatter(dir)
    expect(info.name).toBe("agent-session-orchestration-agentproto")
    expect(info.description.length).toBeGreaterThan(0)
    expect(info.dir).toBe(dir)
  })

  it("rejects a directory without a SKILL.md", async () => {
    await expect(
      parseSkillFrontmatter(join(tmpdir(), "agentproto-no-such-skill-xyz")),
    ).rejects.toThrow()
  })
})

describe("compareSemver (unit)", () => {
  it("orders major.minor.patch correctly", () => {
    expect(compareSemver("0.3.0", "0.2.0")).toBeGreaterThan(0)
    expect(compareSemver("0.2.0", "0.3.0")).toBeLessThan(0)
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareSemver("0.2.1", "0.2.0")).toBeGreaterThan(0)
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0)
  })
})

// ── integration: dry-run CLI ───────────────────────────────────────────

describe("agentproto install skill (dry-run via real CLI)", () => {
  it("--list shows all pack skills", () => {
    const { stdout, code } = runCli(["skill/agentproto-pack", "--list"])
    expect(code).toBe(0)
    expect(stdout).toContain("adapter-setup-kit")
    expect(stdout).toContain("agent-session-orchestration-agentproto")
    expect(stdout).toContain("durable-supervision")
    expect(stdout).toContain("light-coder-orchestration")
    expect(stdout).toContain("nested-orchestration")
  })

  it("--list shows descriptions", () => {
    const { stdout, code } = runCli(["skill/agentproto-pack", "--list"])
    expect(code).toBe(0)
    for (const line of stdout.trim().split("\n")) {
      expect(line.length).toBeGreaterThan(44) // name padded to 44 + desc
    }
  })

  it("hermes --dry-run for a single skill", () => {
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "hermes",
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("dry-run")
    expect(stdout).toContain("hermes")
    expect(stdout).toContain("agent-session-orchestration-agentproto")
  })

  it("claude-code --dry-run with --out tmp dir", () => {
    const tmpOut = join(tmpdir(), `agentproto-skill-test-${Date.now()}`)
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-code",
      "--dry-run",
      "--out",
      tmpOut,
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("dry-run")
    expect(stdout).toContain("claude-code")
    expect(stdout).toContain("agentproto plugin")
  })

  it("--force skips overwrite prompt (hermes --dry-run)", () => {
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "hermes",
      "--force",
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("dry-run")
    expect(stdout).toContain("hermes")
  })

  it("nonexistent slug returns a clean error (code 1)", () => {
    const { stderr, code } = runCli([
      "skill/nonexistent-skill-xyz",
      "--target",
      "hermes",
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("both targets specified", () => {
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "hermes",
      "--target",
      "claude-code",
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("hermes")
    expect(stdout).toContain("claude-code")
  })
})

// ── integration: claude-code emit to temp dir ──────────────────────────

describe("install-skill claude-code emit", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentproto-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await rm(`${tmpDir}.zip`, { force: true }).catch(() => {})
  })

  it("emits plugin bundle to --out dir", () => {
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-code",
      "--out",
      tmpDir,
      "--force",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("claude-code")
    expect(stdout).toContain("agentproto plugin")
    expect(stdout).toContain(tmpDir)
    expect(stdout).toContain("Plugin bundle written")

    expect(existsSync(join(tmpDir, ".claude-plugin", "plugin.json"))).toBe(true)
    expect(
      existsSync(join(tmpDir, "skills", "agent-session-orchestration-agentproto")),
    ).toBe(true)
  })

  it("emits a plugin zip when `zip` is available", () => {
    const { code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-code",
      "--out",
      tmpDir,
      "--force",
    ])
    expect(code).toBe(0)
    // `zip` is present on CI + dev machines; the archive is best-effort.
    expect(existsSync(`${tmpDir}.zip`)).toBe(true)
  })
})

// ── integration: dry-run writes nothing ────────────────────────────────

describe("overwrite / dry-run", () => {
  it("--dry-run never writes", () => {
    const tmpOut = join(tmpdir(), `agentproto-skill-test-${Date.now()}`)
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-code",
      "--out",
      tmpOut,
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("dry-run")
    expect(existsSync(tmpOut)).toBe(false)
  })

  it("--force writes without prompting", () => {
    const tmpOut = join(tmpdir(), `agentproto-skill-force-${Date.now()}`)
    const { code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-code",
      "--out",
      tmpOut,
      "--force",
    ])
    expect(code).toBe(0)
    expect(existsSync(tmpOut)).toBe(true)
    rm(tmpOut, { recursive: true, force: true }).catch(() => {})
    rm(`${tmpOut}.zip`, { force: true }).catch(() => {})
  })
})

// ── unit: upsertSkillManifestEntry ──────────────────────────────────────

describe("upsertSkillManifestEntry (unit)", () => {
  const baseManifest = {
    lastUpdated: 1000000,
    skills: [
      {
        skillId: "skill_existing_01",
        name: "existing-skill",
        description: "old desc",
        creatorType: "user",
        updatedAt: "2026-01-01T00:00:00.000Z",
        enabled: true,
      },
    ],
  }

  it("appends a new entry when name is absent", () => {
    const original = structuredClone(baseManifest)
    const nowMs = 2000000
    const newSkillId = "skill_local_deadbeef"
    const result = upsertSkillManifestEntry(
      baseManifest,
      { name: "new-skill", description: "a new skill" },
      nowMs,
      newSkillId,
    )
    expect(result.skills.length).toBe(2)
    const entry = result.skills.find((e) => e.name === "new-skill")!
    expect(entry.skillId).toBe(newSkillId)
    expect(entry.description).toBe("a new skill")
    expect(entry.creatorType).toBe("user")
    expect(entry.enabled).toBe(true)
    expect(entry.updatedAt).toBe(new Date(nowMs).toISOString())
    expect(result.lastUpdated).toBe(nowMs)
    // original must be unchanged
    expect(original.skills.length).toBe(1)
    expect(original.lastUpdated).toBe(1000000)
  })

  it("updates in place when name is present, preserving skillId", () => {
    const original = structuredClone(baseManifest)
    const nowMs = 3000000
    const newSkillId = "skill_local_shouldnotbeused"
    const result = upsertSkillManifestEntry(
      baseManifest,
      { name: "existing-skill", description: "updated desc" },
      nowMs,
      newSkillId,
    )
    expect(result.skills.length).toBe(1)
    const first = result.skills[0]!
    expect(first.skillId).toBe("skill_existing_01")
    expect(first.description).toBe("updated desc")
    expect(first.enabled).toBe(true)
    expect(first.updatedAt).toBe(new Date(nowMs).toISOString())
    expect(result.lastUpdated).toBe(nowMs)
    // original unchanged
    expect(original.skills[0]!.description).toBe("old desc")
    expect(original.lastUpdated).toBe(1000000)
  })

  it("does not mutate the input object", () => {
    const original = structuredClone(baseManifest)
    upsertSkillManifestEntry(
      baseManifest,
      { name: "another-new", description: "desc" },
      4000000,
      "skill_local_abcdef",
    )
    expect(baseManifest.skills.length).toBe(1)
    expect(baseManifest.lastUpdated).toBe(1000000)
    // also verify the first test's original was not mutated
    expect(original.skills.length).toBe(1)
  })

  it("preserves sibling entries verbatim, including `updatedAt: null`", () => {
    // Real Claude Desktop manifests carry null updatedAt on some built-ins;
    // upserting our skill must NOT rewrite or drop those siblings.
    const manifest = {
      lastUpdated: 1000000,
      skills: [
        {
          skillId: "schedule",
          name: "schedule",
          description: "built-in",
          creatorType: "anthropic",
          updatedAt: null,
          enabled: true,
        },
      ],
    }
    const result = upsertSkillManifestEntry(
      manifest,
      { name: "agent-session-orchestration-agentproto", description: "ours" },
      5000000,
      "skill_local_feedface",
    )
    expect(result.skills.length).toBe(2)
    const sibling = result.skills.find((e) => e.name === "schedule")!
    expect(sibling.skillId).toBe("schedule")
    expect(sibling.creatorType).toBe("anthropic")
    expect(sibling.updatedAt).toBeNull()
  })
})

// ── unit: loadSkillsManifest (data-loss safety) ─────────────────────────

describe("loadSkillsManifest (unit)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-manifest-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("parses a valid registry and preserves a null-updatedAt entry", async () => {
    const p = join(dir, "manifest.json")
    await writeFile(
      p,
      JSON.stringify({
        lastUpdated: 42,
        skills: [
          {
            skillId: "schedule",
            name: "schedule",
            description: "d",
            creatorType: "anthropic",
            updatedAt: null,
            enabled: true,
          },
        ],
      }),
    )
    const m = await loadSkillsManifest(p)
    expect(m).not.toBeNull()
    expect(m!.lastUpdated).toBe(42)
    expect(m!.skills[0]!.updatedAt).toBeNull()
  })

  it("returns null (skip, do not clobber) when an entry is malformed", async () => {
    const p = join(dir, "manifest.json")
    await writeFile(
      p,
      JSON.stringify({ lastUpdated: 1, skills: [{ name: "no-skill-id" }] }),
    )
    expect(await loadSkillsManifest(p)).toBeNull()
  })

  it("returns null for non-JSON and for a missing file", async () => {
    const bad = join(dir, "bad.json")
    await writeFile(bad, "{ not json")
    expect(await loadSkillsManifest(bad)).toBeNull()
    expect(await loadSkillsManifest(join(dir, "nope.json"))).toBeNull()
  })
})

// ── integration: claude-desktop target ──────────────────────────────────

describe("install-skill claude-desktop target", () => {
  it("--target claude-desktop --dry-run exits 0, mentions claude-desktop + dry-run", () => {
    const { stdout, stderr, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-desktop",
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout + stderr).toContain("claude-desktop")
    expect(stdout + stderr).toContain("dry-run")
  })

  it("--target claude-desktop without Claude installed reports skipped (not a crash)", () => {
    const { stdout, stderr, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--target",
      "claude-desktop",
    ])
    expect(code).toBe(0)
    expect(stdout + stderr).toContain("skipped")
  })
})

// ── overwrite mechanics: the ERR_FS_CP_DIR_TO_NON_DIR fix ───────────────────

describe("freshCopyDir — clean overwrite regardless of the existing dest type", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-freshcopy-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("replaces an existing FILE at dest with the source directory (no ERR_FS_CP_DIR_TO_NON_DIR)", async () => {
    const src = join(tmp, "src")
    await mkdir(src, { recursive: true })
    await writeFile(join(src, "SKILL.md"), "# skill\n", "utf8")

    // dest is already a plain file here — the exact shape that made `fs.cp` throw.
    const dest = join(tmp, "dest")
    await writeFile(dest, "stale non-directory\n", "utf8")

    await freshCopyDir(src, dest) // must not throw
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true)
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# skill\n")
  })

  it("replaces a stale existing DIR fully (no leftover files from the old version)", async () => {
    const src = join(tmp, "src")
    await mkdir(src, { recursive: true })
    await writeFile(join(src, "SKILL.md"), "# new\n", "utf8")

    const dest = join(tmp, "dest")
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, "OLD.md"), "stale\n", "utf8")

    await freshCopyDir(src, dest)
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true)
    expect(existsSync(join(dest, "OLD.md"))).toBe(false) // stale file gone — clean replace, not merge
  })
})

describe("isSymlink", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-islink-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("is true for a symlink, false for a real dir, false for a missing path", async () => {
    const realDir = join(tmp, "real")
    await mkdir(realDir, { recursive: true })
    const link = join(tmp, "link")
    await symlink(realDir, link)

    expect(await isSymlink(link)).toBe(true)
    expect(await isSymlink(realDir)).toBe(false)
    expect(await isSymlink(join(tmp, "nope"))).toBe(false)
  })
})

// ── unit: --pack resolution ─────────────────────────────────────────────

describe("resolveSkillPackDir (unit)", () => {
  let tmp: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-resolve-"))
    prevHome = process.env.HOME
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("omitted → resolves the legacy .skills/agentproto-plugin-v* pack", async () => {
    const dir = await resolveSkillPackDir()
    expect(dir).not.toBeNull()
    expect(dir!).toContain(".skills")
    expect(existsSync(join(dir!, "skills"))).toBe(true)
  })

  it("path containing '/' → used verbatim, even if it doesn't exist yet", async () => {
    const fakePath = join(tmp, "some/nested/path")
    const dir = await resolveSkillPackDir(fakePath)
    expect(dir).toBe(fakePath)
  })

  it("existing absolute path with no '/' ambiguity → used verbatim", async () => {
    const packDir = join(tmp, "my-pack")
    await mkdir(join(packDir, "skills", "a-skill"), { recursive: true })
    const dir = await resolveSkillPackDir(packDir)
    expect(dir).toBe(packDir)
  })

  it("bare name → hits the central store ~/.agentproto/packs/<name>/", async () => {
    process.env.HOME = tmp
    const packDir = join(tmp, ".agentproto", "packs", "central-pack")
    await mkdir(join(packDir, "skills", "a-skill"), { recursive: true })

    const dir = await resolveSkillPackDir("central-pack")
    expect(dir).toBe(packDir)
  })

  it("unknown bare pack name → null (caller produces the clear error message)", async () => {
    process.env.HOME = tmp
    const dir = await resolveSkillPackDir("totally-unknown-pack-name-xyz")
    expect(dir).toBeNull()
  })
})

describe("agentproto install skill --pack (dry-run via real CLI)", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-cli-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("--pack <dir> resolves a skill from an arbitrary pack directory", async () => {
    const skillDir = join(tmp, "skills", "my-custom-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: my-custom-skill\ndescription: a custom test skill\n---\nBody.\n",
    )

    const { stdout, code } = runCli([
      "skill/my-custom-skill",
      "--pack",
      tmp,
      "--target",
      "hermes",
      "--dry-run",
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("hermes")
    expect(stdout).toContain("my-custom-skill")
    expect(stdout).toContain("dry-run")
  })

  it("unknown --pack name produces a clear, actionable error", () => {
    const { stderr, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--pack",
      "totally-nonexistent-pack-xyz",
      "--dry-run",
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("totally-nonexistent-pack-xyz")
    expect(stderr).toContain("could not resolve pack")
  })
})

// ── unit: isAdapterSkillsTarget shape guard ──────────────────────────────

describe("isAdapterSkillsTarget (unit)", () => {
  it("accepts a valid flat-dir target", () => {
    expect(isAdapterSkillsTarget({ format: "flat-dir", dir: "~/.hermes/skills" })).toBe(true)
  })

  it("accepts a valid claude-plugin target with unit: whole-pack", () => {
    expect(
      isAdapterSkillsTarget({
        format: "claude-plugin",
        unit: "whole-pack",
        outDir: "~/.claude/plugins/agentproto",
      }),
    ).toBe(true)
  })

  it("rejects undefined, null, and non-object values", () => {
    expect(isAdapterSkillsTarget(undefined)).toBe(false)
    expect(isAdapterSkillsTarget(null)).toBe(false)
    expect(isAdapterSkillsTarget("flat-dir")).toBe(false)
    expect(isAdapterSkillsTarget(42)).toBe(false)
  })

  it("rejects an unknown format", () => {
    expect(isAdapterSkillsTarget({ format: "something-else" })).toBe(false)
  })

  it("rejects a target with a non-string dir", () => {
    expect(isAdapterSkillsTarget({ format: "flat-dir", dir: 123 })).toBe(false)
  })
})

// ── integration: fan-out (no --target) ───────────────────────────────────

describe("agentproto install skill fan-out (no --target, dry-run via real CLI)", () => {
  it("installs into every adapter declaring metadata.skills, skips the rest informationally", { timeout: 15_000 }, () => {
    const { stdout, code } = runCli([
      "skill/agent-session-orchestration-agentproto",
      "--dry-run",
    ])
    expect(code).toBe(0)
    // hermes (flat-dir) and claude-code (claude-plugin) both declare
    // metadata.skills in adapters/{hermes,claude-code}/src/index.ts.
    expect(stdout).toContain("hermes: agent-session-orchestration-agentproto")
    expect(stdout).toContain("claude-code: agentproto plugin")
    expect(stdout).toContain("dry-run")
    // adapters with no metadata.skills block are skipped informationally,
    // not as a failure.
    expect(stdout).toContain("no skills metadata declared")
  })

  it("still short-circuits on --dry-run (no writes) in fan-out mode", { timeout: 15_000 }, () => {
    const fakeHome = join(tmpdir(), `agentproto-fanout-dryrun-${Date.now()}`)
    const cliEntry = join(REPO_ROOT, "packages/cli/dist/cli.mjs")
    const result = spawnSync(
      "node",
      [cliEntry, "install", "skill/agent-session-orchestration-agentproto", "--dry-run"],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome }, timeout: 15_000 },
    )
    const stdout = result.stdout?.toString("utf8") ?? ""
    expect(result.status).toBe(0)
    expect(stdout).toContain("[dry-run]")
    // A dry-run must never touch the (throwaway) hermes skills dir.
    expect(existsSync(join(fakeHome, ".hermes", "skills"))).toBe(false)
  })

  it("preserves symlink-skip in fan-out mode (hermes flat-dir target)", { timeout: 15_000 }, async () => {
    const fakeHome = join(tmpdir(), `agentproto-fanout-symlink-${Date.now()}`)
    const hermesSkillsDir = join(fakeHome, ".hermes", "skills")
    const linkTarget = join(fakeHome, "dev-skill-source")
    const linkDest = join(hermesSkillsDir, "agent-session-orchestration-agentproto")

    await mkdir(linkTarget, { recursive: true })
    await mkdir(hermesSkillsDir, { recursive: true })
    await symlink(linkTarget, linkDest)

    try {
      const cliEntry = join(REPO_ROOT, "packages/cli/dist/cli.mjs")
      const result = spawnSync(
        "node",
        [cliEntry, "install", "skill/agent-session-orchestration-agentproto", "--force"],
        { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome }, timeout: 15_000 },
      )
      const stdout = result.stdout?.toString("utf8") ?? ""
      expect(result.status).toBe(0)
      // the compact summary line reports the skip; the full "symlinked at
      // ... left untouched" explanation lives in the action's `detail`
      // field, which isn't printed in the one-line-per-action summary.
      expect(stdout).toContain("hermes: agent-session-orchestration-agentproto — skipped")
      // the symlink itself must survive (never clobbered)
      expect(await isSymlink(linkDest)).toBe(true)
    } finally {
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
    }
  })
})
