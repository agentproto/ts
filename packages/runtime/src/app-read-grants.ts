/**
 * Operator-granted read-only paths for installed apps.
 *
 * An app's boundary (app-boundary.ts) reads only its own dir by default. The
 * operator can widen that, per app id, with `apps.readGrants` in
 * `~/.agentproto/config.json`:
 *
 *   { "apps": { "readGrants": { "editorial-desk": ["/abs/projects/simone"] } } }
 *
 * The grant lives ONLY there. Nothing an app ships (APP.md frontmatter, the
 * installed record in apps.json, a tool call) is ever consulted, so an app
 * cannot open itself a path. The key is `writable: false` in the config
 * registry, so `config_set` refuses it too. It is read once at daemon boot,
 * validated here, and every accepted or rejected entry is logged. Grants are
 * read-only by construction: they join `AppBoundary.readOnly`, never
 * `writable`.
 */

import { readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

// Local copy of app-boundary.ts `isPathWithin`: that module imports this one.
function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export interface AppReadGrantRejection {
  readonly appId: string
  readonly path: string
  readonly reason: string
}

export interface AppReadGrants {
  /** appId -> canonical (symlink-resolved) absolute paths that passed validation. */
  readonly granted: ReadonlyMap<string, readonly string[]>
  readonly rejected: readonly AppReadGrantRejection[]
}

/** appId -> the validated read-only grants for that app (empty when none). */
export type AppReadGrantResolver = (appId: string) => readonly string[]

/** Directory names that hold credentials; never grantable, never descended into. */
const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config",
  ".agentproto",
  ".password-store",
  "Keychains",
])

const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i

/** True for a file name that conventionally holds secrets (`.env`, keys, tokens). */
export function isSecretFileName(name: string): boolean {
  if (name === ".env") return true
  if (name.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIX.test(name)
  if (name === ".netrc" || name === ".npmrc" || name === ".git-credentials") return true
  if (name === "credentials" || name === "credentials.json") return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true
  return /\.(pem|key|p12|pfx)$/i.test(name)
}

const SYSTEM_FORBIDDEN: readonly string[] = [
  "/etc",
  "/private/etc",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/var/db",
  "/private/var/db",
  "/var/root",
  "/private/var/root",
]

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home
  if (raw.startsWith("~/")) return join(home, raw.slice(2))
  return raw
}

function canonical(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

/** Why `real` (already canonical) may not be granted, or undefined when it may. */
function forbiddenReason(real: string, home: string, daemonWorkspace: string | undefined): string | undefined {
  if (real === sep) return "refusing the filesystem root"
  if (isPathWithin(home, real)) return "refusing $HOME or one of its ancestors (it contains ~/.ssh, ~/.aws, keychains)"
  for (const sys of SYSTEM_FORBIDDEN) {
    const c = canonical(sys) ?? sys
    if (isPathWithin(real, c)) return `refusing a system secrets location (${sys})`
  }
  for (const part of real.split(sep)) {
    if (SECRET_DIR_NAMES.has(part)) return `refusing a credentials directory (${part})`
  }
  if (isPathWithin(real, join(canonical(home) ?? home, "Library", "Keychains"))) {
    return "refusing the macOS keychains"
  }
  if (isSecretFileName(basename(real))) return `refusing a secrets file (${basename(real)})`
  if (daemonWorkspace !== undefined) {
    const ws = canonical(daemonWorkspace) ?? resolve(daemonWorkspace)
    if (isPathWithin(ws, real)) return "refusing the daemon workspace or one of its ancestors"
  }
  return undefined
}

export interface ValidateAppReadGrantsOptions {
  /** Test seam; defaults to the real home directory. */
  readonly home?: string
  /** The daemon workspace: a grant may not be it, or contain it. */
  readonly daemonWorkspace?: string
}

/**
 * Validate the raw `apps.readGrants` value (anything on disk, so untrusted
 * shape). Rejected entries are returned with a reason and never granted; an
 * ill-formed value grants nothing.
 */
export function validateAppReadGrants(raw: unknown, opts: ValidateAppReadGrantsOptions = {}): AppReadGrants {
  const home = canonical(opts.home ?? homedir()) ?? resolve(opts.home ?? homedir())
  const granted = new Map<string, string[]>()
  const rejected: AppReadGrantRejection[] = []
  if (raw === undefined) return { granted, rejected }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { granted, rejected: [{ appId: "*", path: "", reason: "apps.readGrants must be an object of appId -> path[]" }] }
  }
  for (const [appId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      rejected.push({ appId, path: "", reason: "grants must be an array of absolute paths" })
      continue
    }
    for (const entry of list) {
      if (typeof entry !== "string" || entry.trim() === "") {
        rejected.push({ appId, path: String(entry), reason: "grant must be a non-empty string" })
        continue
      }
      const expanded = expandHome(entry, opts.home ?? homedir())
      if (!isAbsolute(expanded)) {
        rejected.push({ appId, path: entry, reason: "grant must be an absolute path" })
        continue
      }
      const real = canonical(expanded)
      if (real === undefined) {
        rejected.push({ appId, path: entry, reason: "path does not exist" })
        continue
      }
      const reason = forbiddenReason(real, home, opts.daemonWorkspace)
      if (reason !== undefined) {
        rejected.push({ appId, path: entry, reason })
        continue
      }
      const mine = granted.get(appId) ?? []
      if (!mine.includes(real)) mine.push(real)
      granted.set(appId, mine)
    }
  }
  return { granted, rejected }
}

/** Log every grant and rejection (one line each) and return the resolver. */
export function createAppReadGrantResolver(
  raw: unknown,
  opts: ValidateAppReadGrantsOptions & { log?: (line: string) => void } = {},
): AppReadGrantResolver {
  const log = opts.log ?? ((line: string) => console.log(line))
  const { granted, rejected } = validateAppReadGrants(raw, opts)
  for (const [appId, paths] of granted) {
    for (const p of paths) log(`[app-grants] app '${appId}' granted READ-ONLY ${p}`)
  }
  for (const r of rejected) {
    log(`[app-grants] REJECTED grant for app '${r.appId}'${r.path ? ` ${r.path}` : ""}: ${r.reason}`)
  }
  return appId => granted.get(appId) ?? []
}

const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".next", ".turbo", "dist", ".venv"])
const SCAN_MAX_ENTRIES = 50_000
const SCAN_MAX_DEPTH = 12

/**
 * Secret files/dirs inside a granted tree, to be masked from the session
 * (`AppBoundary.unreadable`). Bounded and symlink-blind (a symlink is never
 * followed; the sandbox resolves it to its target's own rules). Secret
 * directories are returned whole and not descended into.
 */
export function findSecretsInTree(root: string): string[] {
  const found: string[] = []
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || seen >= SCAN_MAX_ENTRIES) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > SCAN_MAX_ENTRIES) return
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SECRET_DIR_NAMES.has(e.name)) found.push(full)
        else if (!SCAN_SKIP_DIRS.has(e.name)) walk(full, depth + 1)
      } else if (isSecretFileName(e.name)) {
        found.push(full)
      }
    }
  }
  const real = canonical(root)
  if (real === undefined) return found
  walk(real, 0)
  return found
}
