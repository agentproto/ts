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
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import { parseSkillFrontmatter, compareSemver } from "../commands/install-skill.js"

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
