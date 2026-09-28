/**
 * The runtime's {@link PackLoader}: resolves a `uses[].pack` ref to actual
 * pack content, for `@agentproto/review`'s `resolvePacks` to merge in.
 *
 * Three ref forms, told apart by shape:
 *   - `./relative/path` or `../relative/path` (or an absolute path) —
 *     resolved against the CONSUMER's REVIEW.md directory, same convention
 *     as a check's own `rubric` path. Same repo, same trust: exempt from
 *     `allowCommands`.
 *   - `git+https://...#<40-hex sha>` — cloned once into
 *     `~/.agentproto/review-packs/<sha>/` and reused from there on every
 *     later resolve (content-addressed by the pinned sha, so a cache hit
 *     needs no network at all). `parseReviewManifest` already rejects a
 *     floating ref (branch/tag/short sha) before this loader ever runs, but
 *     the check is repeated here defensively.
 *   - anything else — an npm package name, resolved from the reviewed
 *     repo's root via Node's own module resolution (`node_modules`, no
 *     network, no install). The looked-up path is `<name>/package.json` —
 *     works for a files-only package with no `main`/`exports` restricting
 *     subpaths, as long as it exposes `"./package.json"` (or none at all).
 */

import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parsePackManifest, type PackLoader, type PackSource } from "@agentproto/review"

export const defaultReviewPackCacheDir = (): string => join(homedir(), ".agentproto", "review-packs")

const FULL_SHA = /^[0-9a-f]{40}$/

function execFileP(bin: string, args: readonly string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(bin, [...args], { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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

async function loadFromRoot(root: string, refKind: PackSource["refKind"]): Promise<PackSource> {
  const source = await readSource(root)
  return {
    manifest: parsePackManifest(source),
    source,
    refKind,
    root,
    readRubric: (relPath: string) => readFile(resolve(root, relPath)),
  }
}

async function loadRelative(ref: string, manifestDir: string): Promise<PackSource> {
  const root = isAbsolute(ref) ? ref : resolve(manifestDir, ref)
  return loadFromRoot(root, "relative")
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
  return loadFromRoot(dirname(pkgJsonPath), "npm")
}

async function loadGit(ref: string, cacheDir: string): Promise<PackSource> {
  const rest = ref.slice("git+".length)
  const hashAt = rest.lastIndexOf("#")
  const sha = hashAt === -1 ? "" : rest.slice(hashAt + 1)
  const url = hashAt === -1 ? rest : rest.slice(0, hashAt)
  if (!FULL_SHA.test(sha)) {
    throw new Error(`git pack ref '${ref}' must be pinned to a full 40-hex commit sha (git+https://...#<sha>)`)
  }
  const dest = join(cacheDir, sha)
  if (existsSync(join(dest, "REVIEW.md"))) return loadFromRoot(dest, "git")

  const tmp = await mkdtemp(join(tmpdir(), "agentproto-review-pack-"))
  try {
    await execFileP("git", ["clone", "--quiet", url, tmp])
    await execFileP("git", ["checkout", "--quiet", sha], { cwd: tmp })
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
  return loadFromRoot(dest, "git")
}

/** Create the daemon's {@link PackLoader}. `manifestDir` (the consumer
 *  REVIEW.md's own directory) anchors a relative-path pack ref; `repoRoot`
 *  anchors npm resolution; `cacheDir` overrides where pinned git packs are
 *  cached (default `~/.agentproto/review-packs` — tests use a temp dir). */
export function createReviewPackLoader(opts: { repoRoot: string; manifestDir: string; cacheDir?: string }): PackLoader {
  const cacheDir = opts.cacheDir ?? defaultReviewPackCacheDir()
  return {
    async load(ref: string): Promise<PackSource> {
      if (ref.startsWith("git+")) return loadGit(ref, cacheDir)
      if (ref.startsWith("./") || ref.startsWith("../") || isAbsolute(ref)) return loadRelative(ref, opts.manifestDir)
      return loadNpm(ref, opts.repoRoot)
    },
  }
}
