import { existsSync, readlinkSync, realpathSync } from "node:fs"
import { homedir, platform as osPlatform } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { ToolError } from "@agentproto/tool"

/** Stable AIP-14 error code for a launch that would touch a real Chrome profile. */
export const BROWSER_PROFILE_REFUSED_CODE = "browser:profile-refused" as const

export type BrowserProfileRefusedReason =
  | "default-user-data-dir"
  | "default-profile-name"
  | "full-profile"
  | "arg-override"

export interface BrowserProfileRefusedCause {
  reason: BrowserProfileRefusedReason
  providerId?: string
  /** The offending path, option or argument (never a cookie value). */
  detail?: string
}

/**
 * Thrown when a launch asks for the user's default Chrome user-data-dir, a
 * real Chrome profile name, `--full-profile`, or a raw `--user-data-dir` /
 * `--remote-debugging-port` override. Chrome 136+ refuses
 * `--remote-debugging-port` on the default user-data-dir, so providers never
 * attach to it: they always create a fresh dedicated dir and inject granted
 * cookies. Full-profile access arrives with the grant model, not here.
 */
export class BrowserProfileRefusedError extends ToolError {
  readonly reason: BrowserProfileRefusedReason
  readonly providerId: string | undefined
  readonly detail: string | undefined

  constructor(cause: BrowserProfileRefusedCause) {
    const where = cause.providerId ? ` by provider "${cause.providerId}"` : ""
    super({
      code: BROWSER_PROFILE_REFUSED_CODE,
      message: `${REASON_TEXT[cause.reason]}${cause.detail ? ` (${cause.detail})` : ""}; refused${where}. ${GUIDANCE}`,
      cause,
    })
    this.name = "BrowserProfileRefusedError"
    this.reason = cause.reason
    this.providerId = cause.providerId
    this.detail = cause.detail
  }
}

const REASON_TEXT: Record<BrowserProfileRefusedReason, string> = {
  "default-user-data-dir": "the launch targets the default Chrome user-data-dir",
  "default-profile-name": "the launch names a real Chrome profile",
  "full-profile": "a full-profile launch was requested",
  "arg-override": "an extra argument overrides the dedicated user-data-dir or debugging port",
}

const GUIDANCE =
  "Chrome 136+ refuses --remote-debugging-port on the default user-data-dir, so this provider always uses a fresh dedicated dir and receives granted cookies by injection"

export function isBrowserProfileRefusedError(value: unknown): value is BrowserProfileRefusedError {
  return value instanceof BrowserProfileRefusedError
}

export interface DefaultDirEnv {
  home?: string
  platform?: string
  /** Windows `%LOCALAPPDATA%`. */
  localAppData?: string
}

const CHROME_FLAVOURS_MAC = [
  ["Google", "Chrome"],
  ["Google", "Chrome Beta"],
  ["Google", "Chrome Canary"],
  ["Google", "Chrome for Testing"],
  ["Chromium"],
  ["BraveSoftware", "Brave-Browser"],
  ["Microsoft Edge"],
] as const

const CHROME_FLAVOURS_LINUX = [
  ["google-chrome"],
  ["google-chrome-beta"],
  ["google-chrome-unstable"],
  ["chromium"],
  ["BraveSoftware", "Brave-Browser"],
  ["microsoft-edge"],
] as const

const CHROME_FLAVOURS_WIN = [
  ["Google", "Chrome", "User Data"],
  ["Google", "Chrome Beta", "User Data"],
  ["Chromium", "User Data"],
  ["BraveSoftware", "Brave-Browser", "User Data"],
  ["Microsoft", "Edge", "User Data"],
] as const

/** Where Chrome and Chromium-family browsers keep the default user-data-dir on this OS. */
export function defaultChromeUserDataDirs(env: DefaultDirEnv = {}): string[] {
  const home = env.home ?? homedir()
  const platform = env.platform ?? osPlatform()
  if (platform === "darwin") {
    return CHROME_FLAVOURS_MAC.map((parts) => join(home, "Library", "Application Support", ...parts))
  }
  if (platform === "win32") {
    const local = env.localAppData ?? process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local")
    return CHROME_FLAVOURS_WIN.map((parts) => join(local, ...parts))
  }
  return CHROME_FLAVOURS_LINUX.map((parts) => join(home, ".config", ...parts))
}

function canonical(path: string): string {
  const abs = resolve(path)
  try {
    return existsSync(abs) ? realpathSync(abs) : abs
  } catch {
    return abs
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * True when `candidate` is, or sits inside, the default user-data-dir of any
 * supported browser on this OS (symlinks resolved when the path exists), on
 * any OS's layout when `allPlatforms` is set (used by tests).
 */
export function isDefaultChromeUserDataDir(candidate: string, env: DefaultDirEnv & { allPlatforms?: boolean } = {}): boolean {
  const target = canonical(candidate)
  const platforms = env.allPlatforms ? ["darwin", "linux", "win32"] : [env.platform ?? osPlatform()]
  for (const platform of platforms) {
    for (const dir of defaultChromeUserDataDirs({ ...env, platform })) {
      if (isInside(target, canonical(dir)) || isInside(target, resolve(dir))) return true
    }
  }
  return false
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REAL_PROFILE_NAME = /^(default|profile[ _-]?\d+|guest profile|system profile)$/i

export interface ResolveDedicatedProfileInput {
  providerId: string
  /** Root under which dedicated dirs live (the provider's data dir). */
  dataDir: string
  /** Named profile, else `label`, else `main`. */
  profile?: string
  label?: string
  /** An explicit dir; allowed only when it is not (inside) a default browser dir. */
  userDataDir?: string
  /** Always refused until the grant model lands. */
  fullProfile?: boolean
  env?: DefaultDirEnv
}

/**
 * Pick the fresh dedicated user-data-dir for a launch, or refuse. The single
 * F11 gate: every path a provider hands to Chrome or Chromium comes from here.
 */
export function resolveDedicatedProfileDir(input: ResolveDedicatedProfileInput): string {
  const { providerId } = input
  const refuse = (reason: BrowserProfileRefusedReason, detail?: string): never => {
    throw new BrowserProfileRefusedError({ reason, providerId, ...(detail ? { detail } : {}) })
  }
  if (input.fullProfile) refuse("full-profile")

  const looksLikePath = (value: string): boolean => /[\\/]/.test(value) || value.startsWith("~") || value.startsWith(".")
  const explicit = input.userDataDir ?? (input.profile !== undefined && looksLikePath(input.profile) ? input.profile : undefined)
  if (explicit !== undefined) {
    const expanded = explicit.startsWith("~") ? join(input.env?.home ?? homedir(), explicit.slice(1)) : explicit
    if (isDefaultChromeUserDataDir(expanded, input.env)) refuse("default-user-data-dir", expanded)
    if (input.userDataDir === undefined) refuse("default-profile-name", "profile must be a plain name, not a path")
    return canonical(expanded)
  }

  const requested = input.profile ?? input.label ?? "main"
  if (REAL_PROFILE_NAME.test(requested)) refuse("default-profile-name", requested)
  const safe = PROFILE_NAME.test(requested) ? requested : requested.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "p").slice(0, 64)
  if (safe.length === 0) return refuse("default-profile-name", "empty profile name")
  const dir = join(input.dataDir, "profiles", safe)
  if (isDefaultChromeUserDataDir(dir, input.env)) refuse("default-user-data-dir", dir)
  return canonical(dir)
}

/** Argument prefixes a caller may never pass: the provider owns the dir and the debugging port. */
const OWNED_FLAGS = ["--user-data-dir", "--remote-debugging-port", "--remote-debugging-pipe", "--full-profile"] as const

/** Refuse extra args that would override the dedicated dir or the debugging port. */
export function assertNoOwnedArgs(args: readonly string[], providerId: string): void {
  for (const arg of args) {
    const flag = OWNED_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`))
    if (flag === "--full-profile") throw new BrowserProfileRefusedError({ reason: "full-profile", providerId })
    if (flag) throw new BrowserProfileRefusedError({ reason: "arg-override", providerId, detail: flag })
  }
}

/**
 * Last check before a spawn: the argv that will run must carry exactly one
 * `--user-data-dir` and it must not be a default browser dir.
 */
export function assertSpawnArgsSafe(args: readonly string[], providerId: string, env?: DefaultDirEnv): void {
  const dirs = args.filter((a) => a.startsWith("--user-data-dir="))
  const first = dirs[0]
  if (dirs.length !== 1 || first === undefined) {
    throw new BrowserProfileRefusedError({ reason: "arg-override", providerId, detail: "spawn needs exactly one --user-data-dir" })
  }
  const dir = first.slice("--user-data-dir=".length)
  if (isDefaultChromeUserDataDir(dir, env)) {
    throw new BrowserProfileRefusedError({ reason: "default-user-data-dir", providerId, detail: dir })
  }
}

/**
 * Pid of a live process holding a Chrome/Chromium profile dir, read from the
 * `SingletonLock` symlink (`<host>-<pid>`). `undefined` when unlocked, stale,
 * or not readable (Windows keeps no such symlink).
 */
export function liveProfileLockPid(dir: string): number | undefined {
  let target: string
  try {
    target = readlinkSync(join(dir, "SingletonLock"))
  } catch {
    return undefined
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1))
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined
  }
}
