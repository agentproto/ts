/**
 * Tests for `agentproto pack skill`.
 *
 * Two layers:
 *  - Unit tests for pure exported helpers (`bumpSemver`, `readManifest`).
 *  - Integration tests that spawn the BUILT CLI (`packages/cli/dist/cli.mjs`)
 *    via `spawnSync` to exercise the end-to-end verb. These REQUIRE the CLI
 *    to be built first (`pnpm --filter @agentproto/cli build`) — vitest does
 *    not rebuild. Tests use os.tmpdir() so they never touch the real `.skills/`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

import { bumpSemver } from "../commands/pack.js"

// ── repo root ────────────────────────────────────────────────────────────

const REPO_ROOT = (() => {
  // pnpm-workspace.yaml is root-only and always committed — unlike .skills/,
  // which is gitignored build output now (see packages/skill-pack-*) and
  // may not exist at all.
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
})()

// ── helpers ──────────────────────────────────────────────────────────────

/** Create a fixture with a manifest + source skill dirs under `tmp`. */
async function createFixture(tmp: string, opts?: {
  skills?: string[]
  version?: string
}): Promise<{
  manifestPath: string
  sourceDir: string
  outDir: string
  packName: string
}> {
  const manifestDir = join(tmp, "manifests")
  const sourceDir = join(tmp, "source-skills")
  const outDir = join(tmp, "out")
  const packName = "test-pack"

  await mkdir(manifestDir, { recursive: true })
  await mkdir(sourceDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  const skillSlugs = opts?.skills ?? ["skill-a", "skill-b"]

  for (const slug of skillSlugs) {
    const skillDir = join(sourceDir, slug)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: ${slug}
description: "Description for ${slug}"
---

# ${slug}
`,
      "utf8",
    )
    // Add an extra asset to test recursive copy
    await writeFile(join(skillDir, "asset.txt"), "asset content\n", "utf8")
  }

  const manifest = {
    name: packName,
    description: "A test skill pack",
    version: opts?.version ?? "1.0.0",
    skills: skillSlugs,
    sourceDir: "../source-skills",
    author: { name: "Test Author" },
    keywords: ["test", "pack"],
  }

  const manifestPath = join(manifestDir, "test-pack.json")
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

  return { manifestPath, sourceDir, outDir, packName }
}

function runPackCli(
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string | undefined>,
): {
  stdout: string
  stderr: string
  code: number | null
} {
  const cliEntry = join(REPO_ROOT, "packages/cli/dist/cli.mjs")
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const [key, value] of Object.entries(envOverrides ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const result = spawnSync("node", [cliEntry, "pack", ...args], {
    cwd,
    timeout: 15_000,
    env,
  })
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    code: result.status,
  }
}

// ── unit: bumpSemver ─────────────────────────────────────────────────────

describe("bumpSemver (unit)", () => {
  it("patch: 1.0.0 → 1.0.1", () => {
    expect(bumpSemver("1.0.0", "patch")).toBe("1.0.1")
  })

  it("minor: 1.0.0 → 1.1.0", () => {
    expect(bumpSemver("1.0.0", "minor")).toBe("1.1.0")
  })

  it("major: 1.0.0 → 2.0.0", () => {
    expect(bumpSemver("1.0.0", "major")).toBe("2.0.0")
  })

  it("minor from 0.3.0 → 0.4.0", () => {
    expect(bumpSemver("0.3.0", "minor")).toBe("0.4.0")
  })

  it("patch resets on minor", () => {
    expect(bumpSemver("0.3.5", "minor")).toBe("0.4.0")
  })

  it("minor+patch reset on major", () => {
    expect(bumpSemver("0.3.5", "major")).toBe("1.0.0")
  })

  it("returns input unchanged when version does not match semver", () => {
    expect(bumpSemver("not-a-version", "patch")).toBe("not-a-version")
  })
})

// ── integration: fresh pack generation ───────────────────────────────────

describe("agentproto pack skill (fresh generation via CLI)", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-test-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("generates a complete pack with skills, plugin.json, README.md", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp)

    const { stdout, code } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )

    expect(code).toBe(0)
    expect(stdout).toContain("pack written to")

    const packDir = join(outDir, `${packName}-v1.0.0`)

    // plugin.json
    const pluginJson = JSON.parse(
      readFileSync(join(packDir, ".claude-plugin", "plugin.json"), "utf8"),
    )
    expect(pluginJson.name).toBe(packName)
    expect(pluginJson.version).toBe("1.0.0")
    expect(pluginJson.description).toBe("A test skill pack")
    expect(pluginJson.author.name).toBe("Test Author")
    expect(pluginJson.keywords).toEqual(["test", "pack"])

    // README.md
    const readme = readFileSync(join(packDir, "README.md"), "utf8")
    expect(readme).toContain("# test-pack — 1.0.0")
    expect(readme).toContain("A test skill pack")
    expect(readme).toContain("skill-a")
    expect(readme).toContain("skill-b")

    // Skills copied
    expect(existsSync(join(packDir, "skills", "skill-a", "SKILL.md"))).toBe(true)
    expect(existsSync(join(packDir, "skills", "skill-a", "asset.txt"))).toBe(true)
    expect(existsSync(join(packDir, "skills", "skill-b", "SKILL.md"))).toBe(true)
    expect(existsSync(join(packDir, "skills", "skill-b", "asset.txt"))).toBe(true)

    // Verify frontmatter was parsed for descriptions by checking the table
    expect(readme).toContain("Description for skill-a")
    expect(readme).toContain("Description for skill-b")
  })

  it("fails with nonzero exit when a source skill directory is missing", async () => {
    const { manifestPath, outDir } = await createFixture(tmp, {
      skills: ["skill-a"],
    })

    // Manually create the manifest to include a skill that doesn't exist
    const badManifest = {
      name: "test-pack",
      description: "A test skill pack",
      version: "1.0.0",
      skills: ["skill-a", "skill-missing"],
      sourceDir: "../source-skills",
      author: { name: "Test" },
      keywords: [],
    }
    const badManifestPath = join(tmp, "manifests", "bad.json")
    await writeFile(badManifestPath, JSON.stringify(badManifest, null, 2), "utf8")

    const { stderr, code } = runPackCli(
      ["skill", "--manifest", badManifestPath, "--out", outDir],
      tmp,
    )

    expect(code).not.toBe(0)
    expect(stderr).toContain("skill-missing")
    expect(stderr).toContain("not found")
  })

  it("fails when manifest path does not exist", () => {
    const { code, stderr } = runPackCli(
      ["skill", "--manifest", join(tmp, "nonexistent.json"), "--out", tmp],
      tmp,
    )
    expect(code).toBe(1)
    expect(stderr).toContain("manifest not found")
  })

  it("--dry-run writes nothing", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp)

    const { stdout, code } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--dry-run"],
      tmp,
    )

    expect(code).toBe(0)
    expect(stdout).toContain("[dry-run]")
    expect(stdout).toContain("skill-a")
    expect(stdout).toContain("skill-b")

    // Must not create any pack directory
    const packDir = join(outDir, `${packName}-v1.0.0`)
    expect(existsSync(packDir)).toBe(false)
  })
})

// ── integration: same-version resync vs bump ────────────────────────────

describe("agentproto pack skill (resync vs bump)", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-bump-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("same-version resync overwrites existing pack directory", { timeout: 20_000 }, async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp)

    // First generation
    const first = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )
    expect(first.code).toBe(0)

    const packDir = join(outDir, `${packName}-v1.0.0`)
    expect(existsSync(packDir)).toBe(true)

    // Modify the README content to detect resync
    const origReadme = readFileSync(join(packDir, "README.md"), "utf8")
    expect(origReadme).toContain("## What's inside")

    // Second generation (same manifest, same version) — resync
    const second = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("in-place resync")

    // The old version dir still has the same name
    expect(existsSync(packDir)).toBe(true)

    // There should be only one version directory (no new version created)
    const outEntries = readdirSync(outDir)
    const versionDirs = outEntries.filter((e) => e.startsWith(packName))
    expect(versionDirs.length).toBe(1)
  })

  it("--bump patch creates a new version directory, old stays", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp)

    // Generate version 1.0.0
    const first = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )
    expect(first.code).toBe(0)
    expect(existsSync(join(outDir, `${packName}-v1.0.0`))).toBe(true)

    // Bump patch → 1.0.1
    const second = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--bump", "patch"],
      tmp,
    )
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("bumped from")

    // Both versions exist
    expect(existsSync(join(outDir, `${packName}-v1.0.0`))).toBe(true)
    expect(existsSync(join(outDir, `${packName}-v1.0.1`))).toBe(true)

    // New version has correct version in plugin.json
    const pluginJson = JSON.parse(
      readFileSync(join(outDir, `${packName}-v1.0.1`, ".claude-plugin", "plugin.json"), "utf8"),
    )
    expect(pluginJson.version).toBe("1.0.1")

    // README mentions new version
    const readme = readFileSync(join(outDir, `${packName}-v1.0.1`, "README.md"), "utf8")
    expect(readme).toContain("# test-pack — 1.0.1")
    // Old version README unchanged
    expect(
      readFileSync(join(outDir, `${packName}-v1.0.0`, "README.md"), "utf8"),
    ).toContain("# test-pack — 1.0.0")
  })

  it("fresh generation from manifest version with --bump creates bumped version", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp, {
      skills: ["skill-a"],
      version: "1.0.0",
    })

    // Bump from manifest version (1.0.0 → 1.1.0) even with no prior version dir
    const { code } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--bump", "minor"],
      tmp,
    )
    expect(code).toBe(0)
    expect(existsSync(join(outDir, `${packName}-v1.1.0`))).toBe(true)
    // The manifest version dir should NOT have been created (we bumped directly)
    expect(existsSync(join(outDir, `${packName}-v1.0.0`))).toBe(false)
  })
})

// ── integration: --out override ──────────────────────────────────────────

describe("agentproto pack skill --out override", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-out-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("writes to the specified --out directory", async () => {
    const { manifestPath } = await createFixture(tmp, { skills: ["skill-a"] })
    const customOut = join(tmp, "custom-output")

    const { code } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", customOut],
      tmp,
    )
    expect(code).toBe(0)
    expect(existsSync(join(customOut, "test-pack-v1.0.0"))).toBe(true)
  })
})

// ── integration: missing sourceDir with no --source → clear error ─────────

describe("agentproto pack skill (missing sourceDir)", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-nosource-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("exits with code 2 and a helpful message when sourceDir is absent and --source is not passed", async () => {
    const outDir = join(tmp, "out")
    const manifestDir = join(tmp, "manifests")
    await mkdir(outDir, { recursive: true })
    await mkdir(manifestDir, { recursive: true })

    // Manifest without sourceDir
    const manifest = {
      name: "test-pack",
      description: "A test skill pack",
      version: "1.0.0",
      skills: ["skill-a"],
      author: { name: "Test" },
      keywords: [],
    }
    const manifestPath = join(manifestDir, "test-pack.json")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

    const { code, stderr } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )

    expect(code).toBe(2)
    expect(stderr).toContain("no source directory")
    expect(stderr).toContain("--source")
  })
})

// ── integration: --source override ────────────────────────────────────────

describe("agentproto pack skill --source override", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-source-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("--source overrides manifest.sourceDir when the manifest path is unresolvable", async () => {
    // Create fixture: real skills live under tmp/real-skills
    const realSourceDir = join(tmp, "real-skills")
    const outDir = join(tmp, "out")
    const manifestDir = join(tmp, "manifests")

    await mkdir(realSourceDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    await mkdir(manifestDir, { recursive: true })

    // Write a skill to real-skills
    await mkdir(join(realSourceDir, "skill-a"), { recursive: true })
    await writeFile(
      join(realSourceDir, "skill-a", "SKILL.md"),
      `---
name: skill-a
description: "From real source"
---
# skill-a
`,
      "utf8",
    )

    // Manifest has a sourceDir that does NOT exist (different repo scenario)
    const manifest = {
      name: "test-pack",
      description: "A test skill pack",
      version: "1.0.0",
      skills: ["skill-a"],
      sourceDir: "../../nonexistent/skills",
      author: { name: "Test" },
      keywords: [],
    }
    const manifestPath = join(manifestDir, "test-pack.json")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

    // Without --source, this would fail because sourceDir resolves to nowhere.
    // With --source pointing at real-skills, it should succeed.
    const { code, stdout } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--source", realSourceDir],
      tmp,
    )

    expect(code).toBe(0)
    expect(stdout).toContain("pack written to")

    // Verify the pack was created correctly from the overridden source
    const packDir = join(outDir, "test-pack-v1.0.0")
    expect(existsSync(join(packDir, "skills", "skill-a", "SKILL.md"))).toBe(true)

    const readme = readFileSync(join(packDir, "README.md"), "utf8")
    expect(readme).toContain("From real source")
  })
})

// ── integration: --version override ─────────────────────────────────────

describe("agentproto pack skill --version override", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-version-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("--version overrides manifest.version when the manifest omits it", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp)

    // Drop `version` from the manifest to prove --version alone drives it.
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"))
    delete raw.version
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8")

    const { code, stdout } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--version", "2.5.0"],
      tmp,
    )

    expect(code).toBe(0)
    expect(stdout).toContain("version 2.5.0")

    const packDir = join(outDir, `${packName}-v2.5.0`)
    const plugin = JSON.parse(
      readFileSync(join(packDir, ".claude-plugin", "plugin.json"), "utf8"),
    )
    expect(plugin.version).toBe("2.5.0")
  })

  it("--version takes precedence over manifest.version when both are present", async () => {
    const { manifestPath, outDir, packName } = await createFixture(tmp, { version: "1.0.0" })

    const { code } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--version", "3.0.0"],
      tmp,
    )

    expect(code).toBe(0)
    expect(existsSync(join(outDir, `${packName}-v3.0.0`))).toBe(true)
    expect(existsSync(join(outDir, `${packName}-v1.0.0`))).toBe(false)
  })

  it("exits with code 2 when neither manifest.version nor --version is given", async () => {
    const { manifestPath, outDir } = await createFixture(tmp)

    const raw = JSON.parse(readFileSync(manifestPath, "utf8"))
    delete raw.version
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8")

    const { code, stderr } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
    )

    expect(code).toBe(2)
    expect(stderr).toContain("no version")
    expect(stderr).toContain("--version")
  })

  it("exits with code 2 for a malformed --version", async () => {
    const { manifestPath, outDir } = await createFixture(tmp)

    const { code, stderr } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir, "--version", "not-a-version"],
      tmp,
    )

    expect(code).toBe(2)
    expect(stderr).toContain("not a valid semver")
  })
})

describe("agentproto pack skill — manifest sourceDir env-var expansion", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pack-envvar-"))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("expands ${VAR} in manifest.sourceDir when the var is set", async () => {
    const realSourceDir = join(tmp, "real-skills")
    const outDir = join(tmp, "out")
    const manifestDir = join(tmp, "manifests")

    await mkdir(join(realSourceDir, "skill-a"), { recursive: true })
    await mkdir(outDir, { recursive: true })
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      join(realSourceDir, "skill-a", "SKILL.md"),
      `---
name: skill-a
description: "From env-var source"
---
# skill-a
`,
      "utf8",
    )

    const manifest = {
      name: "test-pack",
      description: "A test skill pack",
      version: "1.0.0",
      skills: ["skill-a"],
      sourceDir: "${AGENTPROTO_TEST_SOURCE_ROOT}",
      author: { name: "Test" },
      keywords: [],
    }
    const manifestPath = join(manifestDir, "test-pack.json")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

    const { code, stdout } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
      { AGENTPROTO_TEST_SOURCE_ROOT: realSourceDir },
    )

    expect(code).toBe(0)
    expect(stdout).toContain("pack written to")

    const packDir = join(outDir, "test-pack-v1.0.0")
    const readme = readFileSync(join(packDir, "README.md"), "utf8")
    expect(readme).toContain("From env-var source")
  })

  it("fails with a clear error when the referenced env var is unset", async () => {
    const outDir = join(tmp, "out")
    const manifestDir = join(tmp, "manifests")

    await mkdir(outDir, { recursive: true })
    await mkdir(manifestDir, { recursive: true })

    const manifest = {
      name: "test-pack",
      description: "A test skill pack",
      version: "1.0.0",
      skills: ["skill-a"],
      sourceDir: "${AGENTPROTO_TEST_UNSET_VAR}",
      author: { name: "Test" },
      keywords: [],
    }
    const manifestPath = join(manifestDir, "test-pack.json")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

    const { code, stdout, stderr } = runPackCli(
      ["skill", "--manifest", manifestPath, "--out", outDir],
      tmp,
      { AGENTPROTO_TEST_UNSET_VAR: undefined },
    )

    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain("AGENTPROTO_TEST_UNSET_VAR")
  })
})
