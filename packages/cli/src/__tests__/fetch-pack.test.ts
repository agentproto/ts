/**
 * Tests for the skill-pack FETCH layer (`skill-install/fetch-pack.ts`).
 *
 * The pure parts run everywhere, offline:
 *   - `parsePackSpec` — the `--pack` grammar parser (no I/O).
 *   - `pickPackSubdir` + `runTarExtract`/`runUnzip` — archive → pack-dir
 *     selection, exercised against fixture `.tgz`/`.zip`s BUILT IN THE TEST
 *     with the same system `tar`/`zip` tools the code shells out to. The npm
 *     path is a `.tgz` rooted at `package/`; the github path is the GitHub
 *     Release `.zip` (a single `<name>-v<version>/` bundle). No network.
 *
 * The live-network fetch (npm / github) is gated behind `AGENTPROTO_FETCH_LIVE`
 * and SKIPPED by default so `pnpm test` stays green offline (CI has no network
 * for the fetch — see the pack's WP brief).
 */

import { describe, it, expect } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

import {
  parsePackSpec,
  pickPackSubdir,
  runTarExtract,
  runUnzip,
  fetchNpmPack,
  fetchGithubPack,
} from "../commands/skill-install/fetch-pack.js"
import { resolveSkillPackDir } from "../commands/skill-install/pack-resolve.js"

// ── unit: parsePackSpec (the --pack grammar) ─────────────────────────────

describe("parsePackSpec (unit)", () => {
  it("omitted → npm @agentproto/skill-pack-agentproto@latest", () => {
    expect(parsePackSpec(undefined)).toEqual({
      kind: "npm",
      name: "agentproto",
      pkg: "@agentproto/skill-pack-agentproto",
      version: "latest",
    })
  })

  it("bare `agentproto` → same npm latest default", () => {
    expect(parsePackSpec("agentproto")).toMatchObject({ kind: "npm", version: "latest" })
  })

  it("bare `name@semver` → pinned first-party npm", () => {
    expect(parsePackSpec("agentproto@0.5.2")).toEqual({
      kind: "npm",
      name: "agentproto",
      pkg: "@agentproto/skill-pack-agentproto",
      version: "0.5.2",
    })
  })

  it("some-other-name → first-party pkg for that name, latest", () => {
    expect(parsePackSpec("widgets")).toEqual({
      kind: "npm",
      name: "widgets",
      pkg: "@agentproto/skill-pack-widgets",
      version: "latest",
    })
  })

  it("npm:<scoped pkg>@<ver> → pinned, name derived from pkg", () => {
    expect(parsePackSpec("npm:@agentproto/skill-pack-agentproto@1.2.3")).toEqual({
      kind: "npm",
      name: "agentproto",
      pkg: "@agentproto/skill-pack-agentproto",
      version: "1.2.3",
    })
  })

  it("npm:<third-party scoped pkg> → name undoes the third-party convention", () => {
    expect(parsePackSpec("npm:@acme/agentproto-skill-pack-foo")).toEqual({
      kind: "npm",
      name: "foo",
      pkg: "@acme/agentproto-skill-pack-foo",
      version: "latest",
    })
  })

  it("github:owner/repo@version → github release spec, pinned version", () => {
    expect(parsePackSpec("github:agentproto/ts@0.5.2")).toEqual({
      kind: "github",
      name: "agentproto",
      owner: "agentproto",
      repo: "ts",
      pkg: "@agentproto/skill-pack-agentproto",
      version: "0.5.2",
    })
  })

  it("github:owner/repo (no version) → defaults version to latest", () => {
    expect(parsePackSpec("github:agentproto/ts")).toEqual({
      kind: "github",
      name: "agentproto",
      owner: "agentproto",
      repo: "ts",
      pkg: "@agentproto/skill-pack-agentproto",
      version: "latest",
    })
  })

  it("malformed github (no repo) → local (never fetched blindly)", () => {
    expect(parsePackSpec("github:owneronly")).toEqual({ kind: "local", path: "github:owneronly" })
  })

  it("path-leading values → local", () => {
    expect(parsePackSpec("./rel")).toMatchObject({ kind: "local" })
    expect(parsePackSpec("~/abs")).toMatchObject({ kind: "local" })
    expect(parsePackSpec("a/b/c")).toMatchObject({ kind: "local" })
  })
})

// ── fixture .tgz helpers ─────────────────────────────────────────────────

/** Build a .tgz of `topEntry` (a top-level dir under `baseDir`). */
function tarUp(baseDir: string, topEntry: string, tgzPath: string): void {
  const r = spawnSync("tar", ["-czf", tgzPath, "-C", baseDir, topEntry], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
}

/** Build a .zip of `topEntry` (a top-level dir under `baseDir`), entries
 *  rooted at `topEntry/...` — the shape `zipPackDir` produces at release time. */
function zipUp(baseDir: string, topEntry: string, zipPath: string): void {
  const r = spawnSync("zip", ["-q", "-r", zipPath, topEntry], { cwd: baseDir, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`fixture zip failed: ${r.stderr}`)
}

async function writeFileAt(p: string, content = "x\n"): Promise<void> {
  await mkdir(join(p, ".."), { recursive: true })
  await writeFile(p, content)
}

// ── extraction + pickPackSubdir (real tar, fixture tarballs) ──────────────

describe("runTarExtract/runUnzip + pickPackSubdir (fixture archives, offline)", () => {
  it("npm tarball (rooted at package/) → picks the package/ dir with skills+plugin", async () => {
    const base = await mkdtemp(join(tmpdir(), "fetch-npm-fixture-"))
    try {
      // mirror the real npm tarball shape: package/skills + package/.claude-plugin
      await writeFileAt(join(base, "src", "package", "skills", "foo", "SKILL.md"))
      await writeFileAt(join(base, "src", "package", ".claude-plugin", "plugin.json"), "{}\n")
      const tgz = join(base, "pack.tgz")
      tarUp(join(base, "src"), "package", tgz)

      const out = join(base, "out")
      await mkdir(out, { recursive: true })
      expect(await runTarExtract(tgz, out)).toBe(0)

      const packDir = await pickPackSubdir(out, { kind: "npm" })
      expect(packDir).toBe(join(out, "package"))
      expect(existsSync(join(packDir!, "skills", "foo", "SKILL.md"))).toBe(true)
      expect(existsSync(join(packDir!, ".claude-plugin", "plugin.json"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it("github release zip (single <name>-v<ver>/ bundle) → picks that dir, skills present", async () => {
    // The GitHub Release asset is exactly what `zipPackDir` produces: a single
    // top-level `<manifest-name>-v<version>/` dir holding the BUILT pack —
    // `skills/` + `.claude-plugin/` directly under it, no repo subdir.
    const base = await mkdtemp(join(tmpdir(), "fetch-gh-release-"))
    try {
      const top = "agentproto-plugin-v0.0.0"
      const bundle = join(base, "src", top)
      await writeFileAt(join(bundle, "skills", "supervisor-session", "SKILL.md"))
      await writeFileAt(join(bundle, ".claude-plugin", "plugin.json"), "{}\n")
      const zip = join(base, "agentproto-plugin-v0.0.0.zip")
      zipUp(join(base, "src"), top, zip)

      const out = join(base, "out")
      await mkdir(out, { recursive: true })
      expect(await runUnzip(zip, out)).toBe(0)

      const packDir = await pickPackSubdir(out, { kind: "github-zip" })
      expect(packDir).toBe(join(out, top))
      // the built shape the install flow needs, sitting directly at the root
      expect(existsSync(join(packDir!, "skills", "supervisor-session", "SKILL.md"))).toBe(true)
      expect(existsSync(join(packDir!, ".claude-plugin", "plugin.json"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it("returns null when the expected root is absent", async () => {
    const base = await mkdtemp(join(tmpdir(), "fetch-empty-"))
    try {
      const out = join(base, "out")
      await mkdir(out, { recursive: true })
      expect(await pickPackSubdir(out, { kind: "npm" })).toBeNull()
      // no single top-level bundle dir → github-zip yields null
      expect(await pickPackSubdir(out, { kind: "github-zip" })).toBeNull()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

// ── resolveSkillPackDir new fetch branches (offline: allowFetch off/local) ─

describe("resolveSkillPackDir fetch branches (offline)", () => {
  it("pinned name@ver → hits the exact cache dir, no fetch needed", async () => {
    const home = await mkdtemp(join(tmpdir(), "resolve-pinned-"))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const cache = join(home, ".agentproto", "packs", "agentproto@0.5.2")
      await mkdir(join(cache, "skills", "foo"), { recursive: true })
      // allowFetch omitted → purely local; the pinned cache dir is returned.
      expect(await resolveSkillPackDir("agentproto@0.5.2")).toBe(cache)
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("github spec without allowFetch → null (never touches the network)", async () => {
    const home = await mkdtemp(join(tmpdir(), "resolve-gh-"))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      expect(await resolveSkillPackDir("github:agentproto/ts@0.5.2")).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("pinned github release → an existing packs/<name>@<version> cache is a hit (no fetch)", async () => {
    const home = await mkdtemp(join(tmpdir(), "resolve-gh-cache-"))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const cache = join(home, ".agentproto", "packs", "agentproto@0.5.2")
      await mkdir(join(cache, "skills", "foo"), { recursive: true })
      expect(await resolveSkillPackDir("github:agentproto/ts@0.5.2")).toBe(cache)
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ── live network (opt-in, skipped by default) ────────────────────────────

const LIVE = process.env.AGENTPROTO_FETCH_LIVE === "1"

describe.skipIf(!LIVE)("live npm fetch (opt-in: AGENTPROTO_FETCH_LIVE=1)", () => {
  it("fetches the published pack into the central store with skills/ + .claude-plugin/", async () => {
    const home = await mkdtemp(join(tmpdir(), "fetch-live-home-"))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const dir = await fetchNpmPack(
        { kind: "npm", name: "agentproto", pkg: "@agentproto/skill-pack-agentproto", version: "0.5.2" },
        { refresh: true },
      )
      expect(dir).not.toBeNull()
      expect(existsSync(join(dir!, "skills"))).toBe(true)
      expect(existsSync(join(dir!, ".claude-plugin", "plugin.json"))).toBe(true)
      // pointer maintained
      expect(existsSync(join(home, ".agentproto", "packs", "agentproto", "skills"))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe.skipIf(!LIVE)("live github release fetch (opt-in: AGENTPROTO_FETCH_LIVE=1)", () => {
  it("downloads the pinned release's built .zip into the central store", async () => {
    const home = await mkdtemp(join(tmpdir(), "fetch-live-gh-home-"))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const dir = await fetchGithubPack(
        { kind: "github", name: "agentproto", owner: "agentproto", repo: "ts", pkg: "@agentproto/skill-pack-agentproto", version: "0.5.2" },
        { refresh: true },
      )
      expect(dir).not.toBeNull()
      // cached under the concrete version, not the literal "latest"
      expect(dir).toBe(join(home, ".agentproto", "packs", "agentproto@0.5.2"))
      expect(existsSync(join(dir!, "skills"))).toBe(true)
      expect(existsSync(join(dir!, ".claude-plugin", "plugin.json"))).toBe(true)
      // pointer maintained
      expect(existsSync(join(home, ".agentproto", "packs", "agentproto", "skills"))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})
