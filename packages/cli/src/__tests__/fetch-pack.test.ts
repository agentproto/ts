/**
 * Tests for the skill-pack FETCH layer (`skill-install/fetch-pack.ts`).
 *
 * The pure parts run everywhere, offline:
 *   - `parsePackSpec` — the `--pack` grammar parser (no I/O).
 *   - `pickPackSubdir` + `runTarExtract` — tarball → pack-dir selection,
 *     exercised against fixture `.tgz`s BUILT IN THE TEST with the system
 *     `tar` (the same tool the code shells out to). No network.
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
  fetchNpmPack,
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

  it("github:owner/repo#ref → github spec, subdir fixed", () => {
    expect(parsePackSpec("github:agentproto/ts#some-branch")).toEqual({
      kind: "github",
      name: "agentproto",
      owner: "agentproto",
      repo: "ts",
      ref: "some-branch",
      subdir: "packages/skill-pack-agentproto",
    })
  })

  it("github:owner/repo (no ref) → defaults ref to HEAD", () => {
    expect(parsePackSpec("github:agentproto/ts")).toMatchObject({ kind: "github", ref: "HEAD" })
  })

  it("github with a slashed ref keeps the ref verbatim", () => {
    expect(parsePackSpec("github:agentproto/ts#feat/x")).toMatchObject({
      kind: "github",
      ref: "feat/x",
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

async function writeFileAt(p: string, content = "x\n"): Promise<void> {
  await mkdir(join(p, ".."), { recursive: true })
  await writeFile(p, content)
}

// ── extraction + pickPackSubdir (real tar, fixture tarballs) ──────────────

describe("runTarExtract + pickPackSubdir (fixture .tgz, offline)", () => {
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

  it("github tarball with a BUILT pack → picks the subdir (skills present)", async () => {
    const base = await mkdtemp(join(tmpdir(), "fetch-gh-built-"))
    try {
      const top = "ts-main"
      const sub = join(base, "src", top, "packages", "skill-pack-agentproto")
      await writeFileAt(join(sub, "skills", "supervisor-session", "SKILL.md"))
      await writeFileAt(join(sub, ".claude-plugin", "plugin.json"), "{}\n")
      const tgz = join(base, "repo.tgz")
      tarUp(join(base, "src"), top, tgz)

      const out = join(base, "out")
      await mkdir(out, { recursive: true })
      expect(await runTarExtract(tgz, out)).toBe(0)

      const packDir = await pickPackSubdir(out, {
        kind: "github",
        subdir: "packages/skill-pack-agentproto",
      })
      expect(packDir).toBe(join(out, top, "packages", "skill-pack-agentproto"))
      // the built shape the install flow needs
      expect(existsSync(join(packDir!, "skills", "supervisor-session"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it("github tarball with ONLY src/skills (this repo's real layout) → subdir picked but has no built skills/", async () => {
    // Documents the monorepo-subdir fork: agentproto/ts commits only
    // src/skills; skills/ + .claude-plugin/ are gitignored build output, so a
    // raw ref carries nothing installable. fetchGithubPack validates this and
    // fails loudly rather than caching an empty pack.
    const base = await mkdtemp(join(tmpdir(), "fetch-gh-src-only-"))
    try {
      const top = "ts-main"
      const sub = join(base, "src", top, "packages", "skill-pack-agentproto")
      await writeFileAt(join(sub, "src", "skills", "supervisor-session", "SKILL.md"))
      await writeFileAt(join(sub, "manifest.json"), "{}\n")
      const tgz = join(base, "repo.tgz")
      tarUp(join(base, "src"), top, tgz)

      const out = join(base, "out")
      await mkdir(out, { recursive: true })
      expect(await runTarExtract(tgz, out)).toBe(0)

      const packDir = await pickPackSubdir(out, {
        kind: "github",
        subdir: "packages/skill-pack-agentproto",
      })
      expect(packDir).not.toBeNull()
      expect(existsSync(join(packDir!, "skills"))).toBe(false) // <- the fork
      expect(existsSync(join(packDir!, "src", "skills"))).toBe(true)
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
      expect(
        await pickPackSubdir(out, { kind: "github", subdir: "packages/skill-pack-agentproto" }),
      ).toBeNull()
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
      expect(await resolveSkillPackDir("github:agentproto/ts#main")).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("github spec → an existing packs/<name>@<ref> cache is a hit (no fetch)", async () => {
    const home = await mkdtemp(join(tmpdir(), "resolve-gh-cache-"))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const cache = join(home, ".agentproto", "packs", "agentproto@main")
      await mkdir(join(cache, "skills", "foo"), { recursive: true })
      expect(await resolveSkillPackDir("github:agentproto/ts#main")).toBe(cache)
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
