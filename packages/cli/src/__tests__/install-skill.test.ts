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
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import {
  parseSkillFrontmatter,
  compareSemver,
  upsertSkillManifestEntry,
  loadSkillsManifest,
} from "../commands/install-skill.js"

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
