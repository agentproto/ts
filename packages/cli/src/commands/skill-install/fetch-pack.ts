/**
 * Fetch a skill pack that is NOT yet on disk and materialize it into the
 * central store `~/.agentproto/packs/<name>@<version-or-ref>/`, returning
 * that directory so the rest of the install flow (listSkills / per-format
 * handlers) is unchanged — it only ever sees a local pack dir.
 *
 * Two sources, matching `--pack` grammar (see `parsePackSpec`):
 *   - npm   (stable): `npm pack <spec> --json` into a tmp dir, then extract
 *     the emitted `.tgz` (npm tarballs are rooted at `package/`) into the
 *     cache dir. No global install; honors the ambient npm registry/auth.
 *   - github (test an unreleased ref): download the codeload tarball and
 *     extract the pack subdir.
 *
 * Caching: a target `packs/<name>@<ver>` is reused as-is unless `refresh`
 * is set. A `packs/<name>` pointer (symlink, copy fallback) tracks the
 * most-recently-fetched version so the bare-name / default resolver finds
 * it next time WITHOUT a network round-trip.
 *
 * ── github monorepo-subdir caveat (surfaced, not faked) ──────────────────
 * For THIS repo (`agentproto/ts`) the pack's shipping shape — `skills/` +
 * `.claude-plugin/plugin.json` at the pack root — is BUILD OUTPUT, generated
 * by `packages/skill-pack-agentproto/scripts/build.mjs` from `src/skills/`
 * and gitignored (`git check-ignore packages/skill-pack-agentproto/skills`
 * → matched). No git ref therefore contains a usable pack: the codeload
 * tarball carries only `src/skills/` + `manifest.json`. `fetchGithubPack`
 * extracts the subdir faithfully and then VALIDATES the built shape; when
 * it is absent it fails with a precise diagnostic rather than caching a
 * pack with zero installable skills. A github ref that DOES commit the
 * built `skills/` + `.claude-plugin/` works unchanged.
 */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

import { freshCopyDir, isSymlink, pathExists } from "./shared.js"

// ── pack store location ──────────────────────────────────────────────────

/** Central pack store root: `~/.agentproto/packs`. */
export function packsRoot(): string {
  return join(homedir(), ".agentproto", "packs")
}

// ── --pack spec grammar ──────────────────────────────────────────────────

/**
 * A parsed `--pack` value. `local` is handled by the caller before this is
 * reached (a path is used verbatim); the rest describe something to fetch.
 */
export type PackSpec =
  | { kind: "local"; path: string }
  | {
      /** npm: bare name (`agentproto`), `name@semver`, or `npm:<pkg>[@ver]`. */
      kind: "npm"
      /** Short pack name used for the cache dir + pointer (`agentproto`). */
      name: string
      /** The npm package to `npm pack` (`@agentproto/skill-pack-agentproto`). */
      pkg: string
      /** `latest` or a concrete semver. */
      version: string
    }
  | {
      kind: "github"
      /** Short pack name for the cache dir (`agentproto`). */
      name: string
      owner: string
      repo: string
      ref: string
      /** Subdir within the repo holding the pack (monorepo layout). */
      subdir: string
    }

/** The first-party pack that the bare name / omitted default resolves to. */
const DEFAULT_PACK_NAME = "agentproto"
const FIRST_PARTY_SCOPE = "@agentproto"
const GITHUB_PACK_SUBDIR = "packages/skill-pack-agentproto"

/** `@agentproto/skill-pack-<name>` — the first-party npm dual-naming form. */
function firstPartyPkg(name: string): string {
  return `${FIRST_PARTY_SCOPE}/skill-pack-${name}`
}

/**
 * Derive the short pack name from a full npm package spec, undoing the
 * dual-naming conventions (`@scope/skill-pack-<name>` /
 * `@scope/agentproto-skill-pack-<name>`). Falls back to the last path
 * segment so the cache dir is always deterministic.
 */
function nameFromPkg(pkg: string): string {
  const bare = pkg.replace(/^@[^/]+\//, "")
  const m = bare.match(/^(?:agentproto-)?skill-pack-(.+)$/)
  if (m?.[1]) return m[1]
  return bare
}

/** Split a `pkg@version` (scoped-aware) into `[pkg, version|"latest"]`. */
function splitPkgVersion(spec: string): [string, string] {
  // A leading '@' is the scope, not a version delimiter — look past it.
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0)
  if (at === -1) return [spec, "latest"]
  return [spec.slice(0, at), spec.slice(at + 1) || "latest"]
}

/**
 * Parse a `--pack` value (or `undefined` for the omitted default) into a
 * {@link PackSpec}. Pure — no I/O. Callers resolve `local` before calling
 * (a path is used verbatim); this covers the fetch grammar:
 *   - omitted / `agentproto`            → npm `@agentproto/skill-pack-agentproto@latest`
 *   - `agentproto@1.2.3`                → npm pinned
 *   - `npm:@scope/pkg[@ver]`            → npm pinned/latest, name derived from pkg
 *   - `github:owner/repo[#ref]`         → github tarball (default ref `HEAD`)
 *   - anything containing `/` or `.`    → `local` (path); caller uses verbatim
 */
export function parsePackSpec(pack?: string): PackSpec {
  if (pack === undefined || pack === "" || pack === DEFAULT_PACK_NAME) {
    return {
      kind: "npm",
      name: DEFAULT_PACK_NAME,
      pkg: firstPartyPkg(DEFAULT_PACK_NAME),
      version: "latest",
    }
  }

  if (pack.startsWith("github:")) {
    const rest = pack.slice("github:".length)
    const [ownerRepo, ref] = rest.split("#", 2)
    const [owner, repo] = (ownerRepo ?? "").split("/", 2)
    if (!owner || !repo) {
      // Malformed — treat as a local path so the caller's verbatim/notfound
      // handling reports it, rather than fetching a bogus url.
      return { kind: "local", path: pack }
    }
    return {
      kind: "github",
      name: DEFAULT_PACK_NAME,
      owner,
      repo,
      ref: ref && ref.length > 0 ? ref : "HEAD",
      subdir: GITHUB_PACK_SUBDIR,
    }
  }

  if (pack.startsWith("npm:")) {
    const [pkg, version] = splitPkgVersion(pack.slice("npm:".length))
    return { kind: "npm", name: nameFromPkg(pkg), pkg, version }
  }

  // A path-ish value is local. The resolver already handled real paths
  // (contains "/" or exists on disk) before calling this, so only guard the
  // path-LEADING forms here — NOT a bare `name@1.2.3`, whose version dots
  // must never be mistaken for a filename.
  if (
    pack.includes("/") ||
    pack.startsWith(".") ||
    pack.startsWith("~") ||
    pack.startsWith("\\")
  ) {
    return { kind: "local", path: pack }
  }

  // Bare name: `name` or `name@semver` → first-party npm pack.
  const [name, version] = splitPkgVersion(pack)
  return { kind: "npm", name, pkg: firstPartyPkg(name), version }
}

// ── tar extraction (system `tar`, mirrors zip-pack's system-`zip` idiom) ──

/** Run `tar -xzf <tgz> -C <outDir>`, resolving to the exit code. Exported
 *  for tests to drive extraction against a fixture .tgz. */
export function runTarExtract(tgz: string, outDir: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-xzf", tgz, "-C", outDir], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}

/**
 * Pick the pack directory out of a freshly-extracted tarball tree.
 *   - npm:    entries are rooted at `package/` → `<root>/package`.
 *   - github: codeload roots everything under a single `<repo>-<ref>/` dir →
 *             `<root>/<onlyTopDir>/<subdir>`.
 * Pure given the extracted tree on disk (the only I/O is a `readdir` to find
 * the github top dir, whose name depends on how codeload slugifies the ref).
 */
export async function pickPackSubdir(
  extractedRoot: string,
  spec: { kind: "npm" } | { kind: "github"; subdir: string },
): Promise<string | null> {
  if (spec.kind === "npm") {
    const pkgDir = join(extractedRoot, "package")
    return (await pathExists(pkgDir)) ? pkgDir : null
  }
  // github: exactly one top-level dir (`<repo>-<slugified-ref>`).
  const tops = (await readdir(extractedRoot, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  )
  if (tops.length !== 1 || !tops[0]) return null
  const sub = join(extractedRoot, tops[0].name, spec.subdir)
  return (await pathExists(sub)) ? sub : null
}

// ── central-store cache helpers ──────────────────────────────────────────

/** `packs/<name>@<version-or-ref>` — the immutable per-version cache dir. */
function cacheDirFor(name: string, versionOrRef: string): string {
  // A ref can contain '/' (e.g. `feat/x`); keep the cache dir single-segment.
  const safe = versionOrRef.replace(/[/\\]/g, "-")
  return join(packsRoot(), `${name}@${safe}`)
}

/**
 * Point `packs/<name>` at the just-fetched `packs/<name>@<ver>` so the
 * bare-name / default resolver finds it next time without the network.
 * Symlink first (cheap, always current), copy as a fallback where symlinks
 * are unavailable. NEVER clobbers a real directory a user placed at
 * `packs/<name>` — only replaces an existing pointer.
 */
async function updatePointer(name: string, versionDir: string): Promise<void> {
  const pointer = join(packsRoot(), name)
  const exists = await pathExists(pointer)
  if (exists && !(await isSymlink(pointer))) {
    // A real dir a user owns — respect it, don't turn it into a pointer.
    return
  }
  await rm(pointer, { recursive: true, force: true }).catch(() => {})
  try {
    await symlink(versionDir, pointer)
  } catch {
    // Symlink unsupported (e.g. Windows without privilege) — copy instead.
    await freshCopyDir(versionDir, pointer).catch(() => {})
  }
}

// ── npm fetch ─────────────────────────────────────────────────────────────

interface NpmPackEntry {
  filename: string
  version: string
  name: string
}

/**
 * Run `npm pack <spec> --json --pack-destination <dir>`. Returns the parsed
 * first entry, or null on any failure (offline, 404, unexpected shape) —
 * fetch failures degrade to "pack not found", never a throw.
 *
 * `--fetch-retries=0` keeps an offline/unreachable-registry attempt fast so
 * it can't blow a caller's timeout; the child is also hard-killed after
 * `timeoutMs` as a backstop.
 */
function npmPack(
  spec: string,
  destDir: string,
  timeoutMs: number,
): Promise<NpmPackEntry | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "npm",
      [
        "pack",
        spec,
        "--json",
        "--pack-destination",
        destDir,
        "--fetch-retries=0",
        "--no-audit",
        "--no-fund",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    let out = ""
    let settled = false
    const done = (v: NpmPackEntry | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(v)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null)
    }, timeoutMs)
    child.stdout?.on("data", (d) => {
      out += d.toString()
    })
    child.once("error", () => done(null))
    child.once("exit", (code) => {
      if (code !== 0) return done(null)
      try {
        const parsed: unknown = JSON.parse(out)
        // npm >= 7 emits an array of entries; be tolerant of a bare object.
        const entry = Array.isArray(parsed) ? parsed[0] : parsed
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as NpmPackEntry).filename === "string" &&
          typeof (entry as NpmPackEntry).version === "string"
        ) {
          done(entry as NpmPackEntry)
        } else {
          process.stderr.write(
            "agentproto install skill: unexpected `npm pack --json` output shape; could not locate the tarball filename.\n",
          )
          done(null)
        }
      } catch {
        done(null)
      }
    })
  })
}

/** Options threaded from the resolver to the fetchers. */
export interface FetchOpts {
  refresh?: boolean
  /** npm-pack / download hard timeout (ms). Default 60s. */
  timeoutMs?: number
}

/**
 * Fetch an npm-published pack into `packs/<name>@<version>` and return that
 * dir (or null on failure). For a pinned version an existing cache dir is a
 * hit BEFORE the network; for `latest` the caller should check the pointer
 * first (only `npm pack` reveals which concrete version `latest` is).
 */
export async function fetchNpmPack(
  spec: Extract<PackSpec, { kind: "npm" }>,
  opts: FetchOpts = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000

  // Pinned + already cached → no network.
  if (spec.version !== "latest" && !opts.refresh) {
    const pinned = cacheDirFor(spec.name, spec.version)
    if (await pathExists(pinned)) return pinned
  }

  await mkdir(packsRoot(), { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), "agentproto-fetch-npm-"))
  try {
    const npmSpec = spec.version === "latest" ? spec.pkg : `${spec.pkg}@${spec.version}`
    const entry = await npmPack(npmSpec, tmp, timeoutMs)
    if (!entry) return null

    const target = cacheDirFor(spec.name, entry.version)
    if ((await pathExists(target)) && !opts.refresh) {
      await updatePointer(spec.name, target)
      return target
    }

    const extractRoot = join(tmp, "unpacked")
    await mkdir(extractRoot, { recursive: true })
    const code = await runTarExtract(join(tmp, entry.filename), extractRoot)
    if (code !== 0) {
      process.stderr.write("agentproto install skill: failed to extract the npm tarball.\n")
      return null
    }
    const packDir = await pickPackSubdir(extractRoot, { kind: "npm" })
    if (!packDir) {
      process.stderr.write("agentproto install skill: npm tarball missing its `package/` root.\n")
      return null
    }
    await freshCopyDir(packDir, target)
    await updatePointer(spec.name, target)
    return target
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// ── github fetch ──────────────────────────────────────────────────────────

/**
 * Fetch a pack subdir from a github ref via the codeload tarball into
 * `packs/<name>@<ref>` and return that dir (or null on failure).
 *
 * See the module header: for `agentproto/ts` the built `skills/` +
 * `.claude-plugin/` are gitignored, so a raw ref carries only `src/skills/`.
 * After extracting the subdir this VALIDATES the shipping shape and fails
 * with a precise diagnostic rather than caching an unusable pack.
 */
export async function fetchGithubPack(
  spec: Extract<PackSpec, { kind: "github" }>,
  opts: FetchOpts = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const target = cacheDirFor(spec.name, spec.ref)
  if ((await pathExists(target)) && !opts.refresh) return target

  await mkdir(packsRoot(), { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), "agentproto-fetch-gh-"))
  try {
    const url = `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/${spec.ref}`
    const tgz = join(tmp, "repo.tar.gz")
    const ok = await download(url, tgz, timeoutMs)
    if (!ok) {
      process.stderr.write(
        `agentproto install skill: failed to download ${url} (check the owner/repo/ref).\n`,
      )
      return null
    }

    const extractRoot = join(tmp, "unpacked")
    await mkdir(extractRoot, { recursive: true })
    const code = await runTarExtract(tgz, extractRoot)
    if (code !== 0) {
      process.stderr.write("agentproto install skill: failed to extract the github tarball.\n")
      return null
    }
    const packDir = await pickPackSubdir(extractRoot, { kind: "github", subdir: spec.subdir })
    if (!packDir) {
      process.stderr.write(
        `agentproto install skill: '${spec.subdir}' not found in ${spec.owner}/${spec.repo}@${spec.ref}.\n`,
      )
      return null
    }

    // The shipping shape (skills/ + .claude-plugin/) is build output for this
    // pack — see module header. A ref that only committed `src/skills/` has
    // nothing installable; fail loudly instead of caching an empty pack.
    if (!(await pathExists(join(packDir, "skills")))) {
      const hasSrc = await pathExists(join(packDir, "src", "skills"))
      process.stderr.write(
        `agentproto install skill: ${spec.owner}/${spec.repo}@${spec.ref} contains no built pack ` +
          `at '${spec.subdir}/skills'` +
          (hasSrc
            ? ` (only 'src/skills' — the built 'skills/' + '.claude-plugin/' are gitignored build output). ` +
              `Publish to npm and use \`--pack ${spec.name}\`, or fetch a ref that commits the built pack.\n`
            : `.\n`),
      )
      return null
    }

    await freshCopyDir(packDir, target)
    await updatePointer(spec.name, target)
    return target
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Download `url` to `dest` via global fetch. Returns false on any failure. */
async function download(url: string, dest: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" })
    if (!res.ok || !res.body) return false
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── unified entry ─────────────────────────────────────────────────────────

/** Fetch a pack described by `spec`. `local` never fetches (returns null). */
export async function fetchPack(spec: PackSpec, opts: FetchOpts = {}): Promise<string | null> {
  switch (spec.kind) {
    case "local":
      return null
    case "npm":
      return fetchNpmPack(spec, opts)
    case "github":
      return fetchGithubPack(spec, opts)
  }
}
