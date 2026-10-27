import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

/**
 * Skip `npm exec` for an adapter launched as `npx -y <pkg>@<exact version>`
 * whose exact version already sits in npm's npx cache — exec the cached bin
 * directly instead.
 *
 * Why (F34b, measured live 2026-09-26): before `npx` runs anything it does a
 * full arborist `loadActual()` of the project tree around the CHILD's cwd
 * (~20s warm, ~2min cold for a large pnpm monorepo), then a second one of
 * the npx cache dir under a cross-process `concurrency.lock` keyed by the
 * package spec — i.e. one lock per adapter. Every step is filesystem-bound,
 * so a concurrent worktree provision (`pnpm install` + build in its setup
 * hooks) on the same disk stretched a plain claude-code spawn to minutes,
 * which looked exactly like spawns queuing behind provisioning. The
 * daemon never held a lock; npm did the waiting.
 *
 * Only EXACT versions qualify: an unpinned spec (`-y opencode-ai`) relies on
 * npx's registry check to pick up new releases, and bypassing it would
 * silently freeze the version. Anything that doesn't resolve cleanly (cache
 * miss, version mismatch, ambiguous bin, Windows `.cmd` shims) returns
 * `undefined` so the caller spawns `npx` exactly as before — the fast path
 * can only ever remove work, never change which version runs.
 */
export interface NpxFastPath {
  /** Absolute path of the cached bin to exec in place of `npx`. */
  bin: string
  /** The argv after the package spec — what npx would have forwarded. */
  args: string[]
  /** `<cache>/_npx/<hash>/node_modules/.bin` — npx prepends it to the
   *  child's PATH, so the fast path does too. */
  binDir: string
}

/** Same key libnpmexec uses for `<cache>/_npx/<hash>`: sha512 over the
 *  sorted package specs, newline-joined, first 16 hex chars. */
export function npxCacheKey(packages: readonly string[]): string {
  return createHash("sha512")
    .update([...packages].sort((a, b) => a.localeCompare(b, "en")).join("\n"))
    .digest("hex")
    .slice(0, 16)
}

/** `name@1.2.3` (optionally scoped, optional prerelease/build) → parts;
 *  anything else (range, tag, bare name, url, path) → undefined. */
function parseExactSpec(spec: string): { name: string; version: string } | undefined {
  const m = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/i.exec(spec)
  return m ? { name: m[1]!, version: m[2]! } : undefined
}

/** npm's own rule (`get-bin-from-manifest`): a lone bin wins; otherwise the
 *  bin named after the unscoped package name; otherwise ambiguous. */
function binNameFromManifest(name: string, bin: unknown): string | undefined {
  const unscoped = name.replace(/^@[^/]+\//, "")
  if (typeof bin === "string") return unscoped
  if (!bin || typeof bin !== "object") return undefined
  const names = Object.keys(bin)
  if (names.length === 1) return names[0]
  return names.includes(unscoped) ? unscoped : undefined
}

export function resolveNpxFastPath(
  bin: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  deps?: {
    platform?: NodeJS.Platform
    home?: string
    exists?: (p: string) => boolean
    readFile?: (p: string) => string
  },
): NpxFastPath | undefined {
  if ((deps?.platform ?? process.platform) === "win32") return undefined
  if (basename(bin) !== "npx") return undefined
  const [yes, spec, ...rest] = args
  if (yes !== "-y" && yes !== "--yes") return undefined
  if (spec === undefined) return undefined
  const parsed = parseExactSpec(spec)
  if (!parsed) return undefined

  const exists = deps?.exists ?? existsSync
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const cacheRoot =
    env["npm_config_cache"] ?? env["NPM_CONFIG_CACHE"] ?? join(deps?.home ?? homedir(), ".npm")
  const installDir = join(cacheRoot, "_npx", npxCacheKey([spec]))
  try {
    const pkg = JSON.parse(readFile(join(installDir, "node_modules", parsed.name, "package.json"))) as {
      version?: unknown
      bin?: unknown
    }
    if (pkg.version !== parsed.version) return undefined
    const binName = binNameFromManifest(parsed.name, pkg.bin)
    if (!binName) return undefined
    const binDir = join(installDir, "node_modules", ".bin")
    const binPath = join(binDir, binName)
    if (!exists(binPath)) return undefined
    return { bin: binPath, args: rest, binDir }
  } catch {
    return undefined
  }
}
