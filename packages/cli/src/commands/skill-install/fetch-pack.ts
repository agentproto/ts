/**
 * Fetch a skill pack that is NOT yet on disk and materialize it into the
 * central store `~/.agentproto/packs/<name>@<version-or-ref>/`, returning
 * that directory so the rest of the install flow (listSkills / per-format
 * handlers) is unchanged — it only ever sees a local pack dir.
 *
 * Two sources, matching `--pack` grammar (see `parsePackSpec`):
 *   - npm    (stable): `npm pack <spec> --json` into a tmp dir, then extract
 *     the emitted `.tgz` (npm tarballs are rooted at `package/`) into the
 *     cache dir. No global install; honors the ambient npm registry/auth.
 *   - github (a specific published version, or the latest): download the
 *     BUILT pack `.zip` attached to the per-package GitHub Release and unzip
 *     it into the cache dir.
 *
 * Caching: a target `packs/<name>@<ver>` is reused as-is unless `refresh`
 * is set. A `packs/<name>` pointer (symlink, copy fallback) tracks the
 * most-recently-fetched version so the bare-name / default resolver finds
 * it next time WITHOUT a network round-trip.
 *
 * ── why the GitHub Release asset, not a codeload source tarball ──────────
 * For THIS repo (`agentproto/ts`) the pack's shipping shape — `skills/` +
 * `.claude-plugin/plugin.json` at the pack root — is BUILD OUTPUT, generated
 * by `packages/skill-pack-agentproto/scripts/build.mjs` from `src/skills/`
 * and gitignored (`git check-ignore packages/skill-pack-agentproto/skills`
 * → matched). No git ref therefore contains a usable pack: a source tarball
 * carries only `src/skills/` + `manifest.json`. So github mode targets the
 * SAME artifact CI publishes for the Anthropic consumer — exactly like the
 * vscode extension's `.vsix`: `release.yml`'s "Attach skill-pack bundles"
 * step uploads `<manifest-name>-v<version>.zip` to the release tagged
 * `<npm-name>@<version>` (e.g. asset `agentproto-plugin-v0.5.2.zip` on tag
 * `@agentproto/skill-pack-agentproto@0.5.2`). That zip is a single
 * self-contained `<manifest-name>-v<version>/` dir holding the built
 * `skills/` + `.claude-plugin/`. `fetchGithubPack` resolves the release
 * (a pinned version, or the latest skill-pack release when none is given),
 * downloads the `*-v*.zip` asset, unzips it, and VALIDATES the built shape;
 * when no release/asset is found it fails with a precise diagnostic pointing
 * at the npm path rather than caching an unusable pack.
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
      /**
       * The npm package name whose GitHub Release carries the built zip; the
       * release tag is `<pkg>@<version>` (`@agentproto/skill-pack-agentproto`).
       */
      pkg: string
      /** `latest` (newest skill-pack release) or a concrete semver. */
      version: string
    }

/** The first-party pack that the bare name / omitted default resolves to. */
const DEFAULT_PACK_NAME = "agentproto"
const FIRST_PARTY_SCOPE = "@agentproto"

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
 *   - `github:owner/repo[@version]`     → GitHub Release zip (default: latest)
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
    // `owner/repo` then an optional `@version`. `@` never appears in an
    // owner or repo name, so it unambiguously delimits the version.
    const at = rest.indexOf("@")
    const ownerRepo = at === -1 ? rest : rest.slice(0, at)
    const version = at === -1 ? "latest" : rest.slice(at + 1) || "latest"
    const [owner, repo] = ownerRepo.split("/", 2)
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
      pkg: firstPartyPkg(DEFAULT_PACK_NAME),
      version,
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

// ── archive extraction (system `tar` / `unzip`, mirrors zip-pack's idiom) ──

/** Run `tar -xzf <tgz> -C <outDir>`, resolving to the exit code. Exported
 *  for tests to drive extraction against a fixture .tgz. */
export function runTarExtract(tgz: string, outDir: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-xzf", tgz, "-C", outDir], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}

/** Run `unzip -q -o <zip> -d <outDir>`, resolving to the exit code. Exported
 *  for tests to drive extraction against a fixture .zip (the release-asset
 *  shape). Mirrors `zipPackDir`'s producer-side use of system `zip`. */
export function runUnzip(zip: string, outDir: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("unzip", ["-q", "-o", zip, "-d", outDir], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}

/**
 * Pick the pack directory out of a freshly-extracted archive tree.
 *   - npm:        entries are rooted at `package/` → `<root>/package`.
 *   - github-zip: the release asset holds a single self-contained
 *                 `<manifest-name>-v<version>/` dir → `<root>/<onlyTopDir>`,
 *                 which is already the pack root (`skills/` + `.claude-plugin/`
 *                 sit directly under it, no further subdir).
 * Pure given the extracted tree on disk (the only I/O is a `readdir` to find
 * the single github-zip top dir, whose name embeds the version).
 */
export async function pickPackSubdir(
  extractedRoot: string,
  spec: { kind: "npm" } | { kind: "github-zip" },
): Promise<string | null> {
  if (spec.kind === "npm") {
    const pkgDir = join(extractedRoot, "package")
    return (await pathExists(pkgDir)) ? pkgDir : null
  }
  // github-zip: exactly one top-level dir (`<manifest-name>-v<version>`).
  const tops = (await readdir(extractedRoot, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  )
  if (tops.length !== 1 || !tops[0]) return null
  return join(extractedRoot, tops[0].name)
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

// ── github release fetch ───────────────────────────────────────────────────

/**
 * Run a `gh` subcommand, capturing stdout. Resolves `{ code, stdout }`, or
 * `null` when `gh` is absent/unspawnable — so a missing CLI degrades to the
 * unauthenticated REST fallback rather than throwing. Hard-killed after
 * `timeoutMs`, matching `npmPack`'s backstop.
 */
function runGh(
  ghArgs: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("gh", ghArgs, { stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      resolvePromise(null)
      return
    }
    let out = ""
    let settled = false
    const done = (v: { code: number; stdout: string } | null) => {
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
    child.once("exit", (code) => done({ code: code ?? 1, stdout: out }))
  })
}

/** GET `url` as JSON via global fetch (GitHub REST fallback). Null on any
 *  failure. Sends the GitHub API `Accept` header + a UA (the API requires one). */
async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentproto-cli" },
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the concrete release tag to fetch for `spec`:
 *   - pinned version → `<pkg>@<version>` directly (no network).
 *   - `latest`       → the NEWEST GitHub release whose tag is prefixed
 *     `<pkg>@` (i.e. a skill-pack release for THIS package, not some other
 *     package's release in the same monorepo). `gh` first, REST fallback;
 *     both list releases newest-first, so the first prefix match wins.
 * Returns `null` when no matching release exists.
 */
async function resolveReleaseTag(
  spec: Extract<PackSpec, { kind: "github" }>,
  timeoutMs: number,
): Promise<string | null> {
  if (spec.version !== "latest") return `${spec.pkg}@${spec.version}`

  const prefix = `${spec.pkg}@`
  const repo = `${spec.owner}/${spec.repo}`

  const gh = await runGh(
    ["release", "list", "--repo", repo, "--limit", "100", "--json", "tagName"],
    timeoutMs,
  )
  if (gh && gh.code === 0) {
    try {
      const arr: unknown = JSON.parse(gh.stdout)
      if (Array.isArray(arr)) {
        const tag = arr
          .map((e) => (e as { tagName?: unknown })?.tagName)
          .find((t): t is string => typeof t === "string" && t.startsWith(prefix))
        if (tag) return tag
      }
    } catch {
      /* fall through to REST */
    }
  }

  const rest = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    timeoutMs,
  )
  if (Array.isArray(rest)) {
    const tag = rest
      .map((r) => (r as { tag_name?: unknown })?.tag_name)
      .find((t): t is string => typeof t === "string" && t.startsWith(prefix))
    if (tag) return tag
  }
  return null
}

/**
 * Download the built pack zip (`*-v*.zip`) attached to `tag` into `destDir`,
 * returning the downloaded file path (or null when no such asset exists).
 * `gh release download` first (honors the ambient auth for private repos),
 * then the unauthenticated REST `browser_download_url` fallback.
 */
async function downloadReleaseZip(
  spec: Extract<PackSpec, { kind: "github" }>,
  tag: string,
  destDir: string,
  timeoutMs: number,
): Promise<string | null> {
  const repo = `${spec.owner}/${spec.repo}`

  const gh = await runGh(
    ["release", "download", tag, "--repo", repo, "--dir", destDir, "--pattern", "*-v*.zip", "--clobber"],
    timeoutMs,
  )
  if (gh && gh.code === 0) {
    const zip = (await readdir(destDir)).find((f) => f.endsWith(".zip"))
    if (zip) return join(destDir, zip)
  }

  // REST fallback: read the release's assets, pick the `*-v*.zip`, fetch it.
  const encodedTag = encodeURIComponent(tag)
  const release = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/tags/${encodedTag}`,
    timeoutMs,
  )
  const assets = (release as { assets?: unknown })?.assets
  if (Array.isArray(assets)) {
    const asset = assets.find(
      (a) =>
        typeof (a as { name?: unknown })?.name === "string" &&
        /-v.*\.zip$/.test((a as { name: string }).name) &&
        typeof (a as { browser_download_url?: unknown })?.browser_download_url === "string",
    ) as { browser_download_url: string } | undefined
    if (asset) {
      const dest = join(destDir, "pack.zip")
      if (await download(asset.browser_download_url, dest, timeoutMs)) return dest
    }
  }
  return null
}

/**
 * Fetch the BUILT pack zip attached to a GitHub Release into
 * `packs/<name>@<version>` and return that dir (or null on failure).
 *
 * See the module header: the pack's shipping shape (`skills/` +
 * `.claude-plugin/`) is gitignored build output, so github mode targets the
 * per-package release asset CI publishes — NOT a source tarball. After
 * unzipping it VALIDATES the built shape and, on any miss (no release, no
 * `*-v*.zip` asset, or an asset without `skills/`), fails with a precise
 * diagnostic pointing at the npm path rather than caching an unusable pack.
 */
export async function fetchGithubPack(
  spec: Extract<PackSpec, { kind: "github" }>,
  opts: FetchOpts = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000

  // Pinned + already cached → no network (mirrors the npm path).
  if (spec.version !== "latest" && !opts.refresh) {
    const pinned = cacheDirFor(spec.name, spec.version)
    if (await pathExists(pinned)) return pinned
  }

  const tag = await resolveReleaseTag(spec, timeoutMs)
  if (!tag) {
    process.stderr.write(
      `agentproto install skill: no GitHub release for '${spec.pkg}' found in ` +
        `${spec.owner}/${spec.repo}` +
        (spec.version === "latest" ? "" : `@${spec.version}`) +
        `. Publish to npm and use \`--pack ${spec.name}${spec.version === "latest" ? "" : `@${spec.version}`}\`.\n`,
    )
    return null
  }

  // Derive the concrete version from the tag (`<pkg>@<version>`) so `latest`
  // still caches under its real version, not the literal string "latest".
  const version = tag.slice(`${spec.pkg}@`.length) || spec.version
  const target = cacheDirFor(spec.name, version)
  if ((await pathExists(target)) && !opts.refresh) {
    await updatePointer(spec.name, target)
    return target
  }

  await mkdir(packsRoot(), { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), "agentproto-fetch-gh-"))
  try {
    const zip = await downloadReleaseZip(spec, tag, tmp, timeoutMs)
    if (!zip) {
      process.stderr.write(
        `agentproto install skill: release '${tag}' in ${spec.owner}/${spec.repo} has no ` +
          `built pack asset ('*-v*.zip'). Publish to npm and use \`--pack ${spec.name}\`.\n`,
      )
      return null
    }

    const extractRoot = join(tmp, "unpacked")
    await mkdir(extractRoot, { recursive: true })
    const code = await runUnzip(zip, extractRoot)
    if (code !== 0) {
      process.stderr.write("agentproto install skill: failed to unzip the release asset.\n")
      return null
    }
    const packDir = await pickPackSubdir(extractRoot, { kind: "github-zip" })
    if (!packDir) {
      process.stderr.write(
        `agentproto install skill: release asset for '${tag}' is not a single '<name>-v<version>/' bundle.\n`,
      )
      return null
    }

    // Defensive: the release zip should always carry the built shape, but a
    // malformed asset must fail loudly rather than cache an empty pack.
    if (!(await pathExists(join(packDir, "skills")))) {
      process.stderr.write(
        `agentproto install skill: release asset for '${tag}' contains no 'skills/' — ` +
          `the bundle is not a built pack. Publish to npm and use \`--pack ${spec.name}\`.\n`,
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
