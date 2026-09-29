/**
 * The runtime's {@link PackLoader}: resolves a `uses[].pack` ref to actual
 * pack content, for `@agentproto/review`'s `resolvePacks` to merge in.
 *
 * Three ref forms, told apart by shape:
 *   - `./relative/path` or `../relative/path` (or an absolute path) —
 *     resolved against the CONSUMER's REVIEW.md directory, same convention
 *     as a check's own `rubric` path. NOT automatically same-repo-same-trust
 *     just because the ref string looks relative: {@link isTrustedRelativePack}
 *     requires the resolved root (realpath'd, so a symlink can't escape) to
 *     sit INSIDE the reviewed repo root AND its REVIEW.md to be tracked by
 *     git there. A ref that resolves outside the repo (`../..`, an absolute
 *     path elsewhere), or inside but untracked (`./node_modules/<pkg>`, a
 *     gitignored scratch dir), still loads — it just isn't exempt from
 *     `allowCommands`, same as npm/git.
 *   - `git+https://...#<40-hex sha>` — ONLY `https://` is accepted (no
 *     ssh://, file://, ext::, or plain http://; `ext::` in particular can
 *     run an arbitrary local command). Cloned once into
 *     `~/.agentproto/review-packs/<sha>/` and reused from there on every
 *     later resolve (content-addressed by the pinned sha, so a cache hit
 *     needs no network at all). `parseReviewManifest` already rejects a
 *     floating ref (branch/tag/short sha) or a non-https transport before
 *     this loader ever runs, but both checks are repeated here defensively —
 *     this is the code that actually shells out to `git`, so it doesn't
 *     lean on the caller alone. The URL is also passed to `git clone` after
 *     a literal `--`, so even a scheme-valid but adversarial URL can never
 *     be misread as a flag.
 *   - anything else — an npm package name, resolved from the reviewed
 *     repo's root via Node's own module resolution (`node_modules`, no
 *     network, no install). The looked-up path is `<name>/package.json` —
 *     works for a files-only package with no `main`/`exports` restricting
 *     subpaths, as long as it exposes `"./package.json"` (or none at all).
 *
 * A separate confinement, orthogonal to the three forms above and applied
 * regardless of which one resolved a pack: a check's own `rubric` field is
 * untrusted input (the pack author's, not the consumer's), so
 * {@link readRubricConfined} refuses to read outside the pack's own root —
 * see its doc comment.
 */

import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { GitPackRefError, parseGitPackRef, parsePackManifest, type PackLoader, type PackSource } from "@agentproto/review"

export const defaultReviewPackCacheDir = (): string => join(homedir(), ".agentproto", "review-packs")

function execFileP(
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(bin, [...args], { cwd: opts.cwd, env: opts.env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
      else resolvePromise(String(stdout))
    })
  })
}

async function readSource(root: string): Promise<string> {
  try {
    return await readFile(join(root, "REVIEW.md"), "utf8")
  } catch (err) {
    throw new Error(`no REVIEW.md at ${join(root, "REVIEW.md")} (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** True when realpath `child` is `realParent` itself or sits inside it —
 *  the one containment check both the `allowCommands` trust boundary and
 *  the rubric-path confinement below share. Compares realpath'd strings
 *  only (never the raw, un-resolved paths), so a symlink can't fake it. */
function isRealPathInside(realChild: string, realParent: string): boolean {
  return realChild === realParent || realChild.startsWith(realParent + sep)
}

/**
 * A pack check's own `rubric` field is untrusted input — read it ONLY from
 * inside the pack's root. `resolve(root, relPath)` alone isn't enough (an
 * absolute `relPath`, a `../../..` escape, or a same-directory symlink
 * pointing elsewhere would all still "resolve"); the REALPATH of the
 * result must land inside the REALPATH of `root`. This runs at
 * `resolvePacks` time (every selected agent check's rubric is read for the
 * pack digest before any lane ever starts), so a malicious rubric path
 * never reaches a reviewer session's prompt either. Applies to every pack
 * — trusted or not; a pack pointing outside its own root has no legitimate
 * reason to, regardless of the `allowCommands` trust boundary. */
async function readRubricConfined(root: string, relPath: string): Promise<Uint8Array> {
  const resolved = resolve(root, relPath)
  let realResolved: string
  let realRoot: string
  try {
    ;[realResolved, realRoot] = await Promise.all([realpath(resolved), realpath(root)])
  } catch (err) {
    throw new Error(`could not read (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isRealPathInside(realResolved, realRoot)) {
    throw new Error(`resolves outside its pack root (${root}) — refusing to read it`)
  }
  return readFile(realResolved)
}

async function loadFromRoot(root: string, refKind: PackSource["refKind"], trusted: boolean): Promise<PackSource> {
  const source = await readSource(root)
  return {
    manifest: parsePackManifest(source),
    source,
    refKind,
    trusted,
    root,
    readRubric: (relPath: string) => readRubricConfined(root, relPath),
  }
}

/** The `allowCommands` exemption's actual gate: `root` must realpath INSIDE
 *  `repoRoot` (never merely string-prefixed — a symlink is resolved before
 *  comparing) AND its `REVIEW.md` must be tracked by git in that repo.
 *  Every failure mode (root doesn't exist, repo isn't a git repo, root is
 *  outside, REVIEW.md is untracked) safely defaults to `false` — a pack
 *  never becomes trusted by accident. */
async function isTrustedRelativePack(root: string, repoRoot: string): Promise<boolean> {
  let realRoot: string
  let realRepo: string
  try {
    ;[realRoot, realRepo] = await Promise.all([realpath(root), realpath(repoRoot)])
  } catch {
    return false
  }
  if (!isRealPathInside(realRoot, realRepo)) return false
  const relReviewMd = join(relative(realRepo, realRoot), "REVIEW.md")
  try {
    await execFileP("git", ["-C", realRepo, "ls-files", "--error-unmatch", "--", relReviewMd])
    return true
  } catch {
    return false
  }
}

async function loadRelative(ref: string, manifestDir: string, repoRoot: string): Promise<PackSource> {
  const root = isAbsolute(ref) ? ref : resolve(manifestDir, ref)
  const trusted = await isTrustedRelativePack(root, repoRoot)
  return loadFromRoot(root, "relative", trusted)
}

async function loadNpm(ref: string, repoRoot: string): Promise<PackSource> {
  const req = createRequire(join(repoRoot, "package.json"))
  let pkgJsonPath: string
  try {
    pkgJsonPath = req.resolve(`${ref}/package.json`)
  } catch (err) {
    throw new Error(
      `review pack '${ref}' is not resolvable from ${repoRoot} (node_modules, no network, no install) — is it a dependency? (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  return loadFromRoot(dirname(pkgJsonPath), "npm", false)
}

async function loadGit(ref: string, cacheDir: string, env: NodeJS.ProcessEnv | undefined): Promise<PackSource> {
  // Defense in depth: `parseReviewManifest` already screens the ref, but this
  // is the code that actually shells out to `git` — it doesn't get to assume
  // the caller validated first. It uses the SAME parser the manifest does, so
  // the two cannot disagree on where the pin starts (the first `#`).
  let url: string
  let sha: string
  try {
    ;({ url, sha } = parseGitPackRef(ref))
  } catch (err) {
    if (err instanceof GitPackRefError) throw new Error(err.message)
    throw err
  }
  const dest = join(cacheDir, sha)
  if (existsSync(join(dest, "REVIEW.md"))) return loadFromRoot(dest, "git", false)

  const tmp = await mkdtemp(join(tmpdir(), "agentproto-review-pack-"))
  try {
    // `--` terminates option parsing: even though `url` is already
    // guaranteed to start with "https://" (never "-") by the check above,
    // the clone call stays safe on its own if that guarantee ever changes.
    await execFileP("git", ["clone", "--quiet", "--", url, tmp], { env })
    await execFileP("git", ["checkout", "--quiet", sha], { cwd: tmp, env })
    try {
      await mkdir(cacheDir, { recursive: true })
      await rename(tmp, dest)
    } catch {
      // Another resolve of the same sha won the race — reuse its result and
      // drop ours; the cache is content-addressed, so either copy is fine.
      if (!existsSync(join(dest, "REVIEW.md"))) throw new Error(`could not place cloned pack at ${dest}`)
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  return loadFromRoot(dest, "git", false)
}

/** Create the daemon's {@link PackLoader}. `manifestDir` (the consumer
 *  REVIEW.md's own directory) anchors a relative-path pack ref; `repoRoot`
 *  anchors npm resolution AND is the trust boundary a relative pack's
 *  resolved root must sit inside of (see {@link isTrustedRelativePack});
 *  `cacheDir` overrides where pinned git packs are cached (default
 *  `~/.agentproto/review-packs` — tests use a temp dir); `env` overrides
 *  the environment `git` runs under (tests only — e.g. a local HTTPS
 *  fixture with `GIT_SSL_NO_VERIFY`; default `process.env`). */
export function createReviewPackLoader(opts: {
  repoRoot: string
  manifestDir: string
  cacheDir?: string
  env?: NodeJS.ProcessEnv
}): PackLoader {
  const cacheDir = opts.cacheDir ?? defaultReviewPackCacheDir()
  return {
    async load(ref: string): Promise<PackSource> {
      if (ref.startsWith("git+")) return loadGit(ref, cacheDir, opts.env)
      if (ref.startsWith("./") || ref.startsWith("../") || isAbsolute(ref)) {
        return loadRelative(ref, opts.manifestDir, opts.repoRoot)
      }
      return loadNpm(ref, opts.repoRoot)
    },
  }
}
