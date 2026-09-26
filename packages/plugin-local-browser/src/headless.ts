/**
 * Headless-browser building blocks for daemon-spawned agents
 * (`agent_start({ browser: "headless" })` in `@agentproto/runtime`).
 *
 * Unlike the rest of this plugin (which bridges the USER's authed Chrome
 * profile through the daemon's shared MCP proxy), everything here serves a
 * throwaway, per-session browser: `chrome-devtools-mcp --headless
 * --isolated` launched as a stdio MCP server inside the agent's own process
 * tree, with a temporary profile that is deleted when the server exits.
 *
 * Three pieces:
 *   - `ensureChromeDevtoolsMcp()` — resolve (installing once if missing)
 *     the plugin-owned chrome-devtools-mcp under `~/.agentproto/chrome-mcp`.
 *     Cached per prefix and concurrency-safe: N parallel spawns share one
 *     install.
 *   - `findChrome()` / `resolveChrome()` — locate a Chrome to drive: an
 *     explicit `AGENTPROTO_CHROME_PATH`, then an installed Chrome/Chromium,
 *     then a `chrome-headless-shell` under
 *     `~/.agentproto/chrome-headless-shell` (downloaded with
 *     `@puppeteer/browsers` when `resolveChrome({ install: true })` finds
 *     nothing else — the Linux-box / CI case).
 *   - `buildHeadlessBrowserMcpEntry()` — the stdio `mcpServers` entry.
 *
 * Sandbox findings (macOS Seatbelt, validated 2026-09-26 with Chrome 154 and
 * chrome-devtools-mcp 1.0.1 + 1.10.1; full matrix in the README, "Headless
 * mode"):
 *   - `commandSandbox: "workspace"`: Chrome's own sandbox cannot initialise
 *     inside the outer Seatbelt profile (`sandbox initialization failed:
 *     Operation not permitted`; helpers crash-loop and `navigate_page` times
 *     out). `--no-sandbox` (`chromeSandbox: false`) fixes it; the outer
 *     profile still confines the whole tree.
 *   - `"strict"`: system Chrome still fails, because `deny network*` also
 *     blocks its ProcessSingleton unix socket
 *     (`$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`); puppeteer then
 *     reports a misleading "browser is already running".
 *     `chrome-headless-shell` has no ProcessSingleton and works under the
 *     unmodified strict profile with `--no-sandbox`: `file://` pages load,
 *     `https://` fails with `net::ERR_NAME_NOT_RESOLVED`. Hence
 *     `sources: ["env", "headless-shell"]` for strict spawns.
 */

import { spawn } from "node:child_process"
import { existsSync, promises as fs, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { DEFAULT_CHROME_MCP_PREFIX, installChromeMcp } from "./install.js"

/** chrome-devtools-mcp version installed on a fresh machine. An existing
 *  install under the prefix is reused whatever its version. */
export const CHROME_DEVTOOLS_MCP_VERSION = "1.10.1"

/** Default viewport for a headless session browser. */
export const DEFAULT_HEADLESS_VIEWPORT = "1440x900"

/** MCP server name the headless browser is mounted under — its tools reach
 *  the agent as `mcp__browser__<tool>` (claude-code naming). */
export const HEADLESS_BROWSER_MCP_NAME = "browser"

/** Env var that pins the Chrome binary, overriding every lookup. */
export const CHROME_PATH_ENV = "AGENTPROTO_CHROME_PATH"

export const DEFAULT_CHROME_HEADLESS_SHELL_DIR = (home: string = homedir()): string =>
  join(home, ".agentproto", "chrome-headless-shell")

export interface ChromeDevtoolsMcp {
  /** The install prefix (`~/.agentproto/chrome-mcp`). */
  prefix: string
  /** `<prefix>/node_modules/.bin/chrome-devtools-mcp`. */
  binPath: string
  /** The JS entry the bin points at. Launched as `node <entryScript>` so the
   *  MCP server never depends on the agent's PATH containing `node`. */
  entryScript: string
  /** Installed version, or `"(unknown)"`. */
  version: string
  /** True when this call ran the install (first use on this machine). */
  installed: boolean
}

export interface EnsureChromeDevtoolsMcpOptions {
  prefix?: string
  /** npm spec used only when nothing is installed yet. */
  version?: string
  npm?: string
  onProgress?: (line: string) => void
}

const ensureCache = new Map<string, Promise<ChromeDevtoolsMcp>>()

/**
 * Resolve the plugin-owned chrome-devtools-mcp, installing it on first use.
 * Cached per prefix; concurrent callers share the in-flight promise. A
 * failed install is evicted so the next call retries.
 */
export function ensureChromeDevtoolsMcp(
  opts: EnsureChromeDevtoolsMcpOptions = {},
): Promise<ChromeDevtoolsMcp> {
  const prefix = resolve(opts.prefix ?? DEFAULT_CHROME_MCP_PREFIX())
  const cached = ensureCache.get(prefix)
  if (cached) return cached
  const pending = (async () => {
    const existing = await readChromeDevtoolsMcp(prefix)
    if (existing) return existing
    await installChromeMcp({
      prefix,
      version: opts.version ?? CHROME_DEVTOOLS_MCP_VERSION,
      ...(opts.npm ? { npm: opts.npm } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
    const installed = await readChromeDevtoolsMcp(prefix)
    if (!installed) {
      throw new Error(
        `ensureChromeDevtoolsMcp: install into ${prefix} finished but no ` +
          `chrome-devtools-mcp entry script was found.`,
      )
    }
    return { ...installed, installed: true }
  })()
  ensureCache.set(prefix, pending)
  pending.catch(() => ensureCache.delete(prefix))
  return pending
}

/** Test hook: forget cached resolutions. */
export function resetChromeDevtoolsMcpCache(): void {
  ensureCache.clear()
}

/** Read an existing install's entry script from its package.json `bin`. */
export async function readChromeDevtoolsMcp(prefix: string): Promise<ChromeDevtoolsMcp | null> {
  const pkgDir = join(prefix, "node_modules", "chrome-devtools-mcp")
  let pkg: { version?: unknown; bin?: unknown }
  try {
    pkg = JSON.parse(await fs.readFile(join(pkgDir, "package.json"), "utf8")) as typeof pkg
  } catch {
    return null
  }
  const bin = pkg.bin
  const rel =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin as Record<string, unknown>)["chrome-devtools-mcp"]
        : undefined
  if (typeof rel !== "string") return null
  const entryScript = join(pkgDir, rel)
  try {
    await fs.access(entryScript)
  } catch {
    return null
  }
  return {
    prefix,
    binPath: join(prefix, "node_modules", ".bin", "chrome-devtools-mcp"),
    entryScript,
    version: typeof pkg.version === "string" ? pkg.version : "(unknown)",
    installed: false,
  }
}

// ── Chrome lookup ─────────────────────────────────────────────────────

export type ChromeSource = "env" | "system" | "headless-shell"

export interface ChromeExecutable {
  path: string
  source: ChromeSource
}

export interface FindChromeOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  /** Where `chrome-headless-shell` downloads live. */
  headlessShellDir?: string
  /** Injected for tests. */
  exists?: (path: string) => boolean
  /** Injected for tests: list a directory's entries (`[]` when missing). */
  readdir?: (path: string) => string[]
  /** Lookup order restriction. Default all three. `["env",
   *  "headless-shell"]` skips system Chrome (needed under a no-network
   *  sandbox, see the module doc). */
  sources?: readonly ChromeSource[]
}

/** Well-known Chrome/Chromium locations per platform, most preferred first. */
export function systemChromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
    ]
    return apps.flatMap(a => [join("/Applications", a), join(home, "Applications", a)])
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    )
    return roots.map(r => join(r, "Google", "Chrome", "Application", "chrome.exe"))
  }
  const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean)
  return [
    ...names.flatMap(n => pathDirs.map(d => join(d, n))),
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
  ]
}

/**
 * `@puppeteer/browsers` ids for chrome-headless-shell: `cache` names the
 * `<cache>-<buildId>` directory, `archive` the unpacked
 * `chrome-headless-shell-<archive>` folder inside it.
 */
function headlessShellPlatform(
  platform: NodeJS.Platform,
  arch: string,
): { cache: string; archive: string } | null {
  if (platform === "darwin") {
    return arch === "arm64" ? { cache: "mac_arm", archive: "mac-arm64" } : { cache: "mac", archive: "mac-x64" }
  }
  if (platform === "linux") return { cache: "linux", archive: "linux64" }
  if (platform === "win32") {
    return arch === "ia32" ? { cache: "win32", archive: "win32" } : { cache: "win64", archive: "win64" }
  }
  return null
}

/**
 * Newest `chrome-headless-shell` already downloaded under `dir`
 * (`@puppeteer/browsers` layout: `chrome-headless-shell/<cache>-<build>/
 * chrome-headless-shell-<archive>/chrome-headless-shell[.exe]`, e.g.
 * `mac_arm-154.0.8037.57/chrome-headless-shell-mac-arm64/`).
 */
export function findHeadlessShell(
  dir: string,
  opts: Pick<FindChromeOptions, "platform" | "arch" | "exists" | "readdir"> = {},
): string | null {
  const platform = opts.platform ?? process.platform
  const plat = headlessShellPlatform(platform, opts.arch ?? process.arch)
  if (!plat) return null
  const exists = opts.exists ?? existsSync
  const readdir = opts.readdir ?? defaultReaddir
  const root = join(dir, "chrome-headless-shell")
  const builds = readdir(root)
    .filter(d => d.startsWith(`${plat.cache}-`))
    .sort(compareBuildDirs)
    .reverse()
  const exe = platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"
  for (const build of builds) {
    const candidate = join(root, build, `chrome-headless-shell-${plat.archive}`, exe)
    if (exists(candidate)) return candidate
  }
  return null
}

function compareBuildDirs(a: string, b: string): number {
  const va = (a.split("-").pop() ?? "").split(".").map(Number)
  const vb = (b.split("-").pop() ?? "").split(".").map(Number)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function defaultReaddir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Locate a Chrome without installing anything: `AGENTPROTO_CHROME_PATH` →
 * installed Chrome/Chromium → a previously downloaded chrome-headless-shell.
 */
export function findChrome(opts: FindChromeOptions = {}): ChromeExecutable | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const sources = opts.sources ?? ["env", "system", "headless-shell"]
  const override = env[CHROME_PATH_ENV]
  if (override && sources.includes("env")) {
    return exists(override) ? { path: override, source: "env" } : null
  }
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  if (sources.includes("system")) {
    for (const candidate of systemChromeCandidates(platform, env, home)) {
      if (exists(candidate)) return { path: candidate, source: "system" }
    }
  }
  if (!sources.includes("headless-shell")) return null
  const shell = findHeadlessShell(opts.headlessShellDir ?? DEFAULT_CHROME_HEADLESS_SHELL_DIR(home), {
    platform,
    ...(opts.arch ? { arch: opts.arch } : {}),
    exists,
    ...(opts.readdir ? { readdir: opts.readdir } : {}),
  })
  return shell ? { path: shell, source: "headless-shell" } : null
}

export interface ResolveChromeOptions extends FindChromeOptions {
  /** Download chrome-headless-shell when no Chrome is found. Default true. */
  install?: boolean
  npm?: string
  onProgress?: (line: string) => void
}

/**
 * `findChrome()`, falling back to downloading `chrome-headless-shell@stable`
 * with `@puppeteer/browsers` into `~/.agentproto/chrome-headless-shell`.
 * Throws when nothing is found and the download fails or is disabled.
 */
export async function resolveChrome(opts: ResolveChromeOptions = {}): Promise<ChromeExecutable> {
  const found = findChrome(opts)
  if (found) return found
  const env = opts.env ?? process.env
  if (env[CHROME_PATH_ENV] && (opts.sources ?? ["env"]).includes("env")) {
    throw new Error(`${CHROME_PATH_ENV}=${env[CHROME_PATH_ENV]} does not exist.`)
  }
  if (opts.install === false || (opts.sources && !opts.sources.includes("headless-shell"))) {
    throw new Error(
      `No Chrome found. Install Google Chrome, set ${CHROME_PATH_ENV}, or allow ` +
        `the chrome-headless-shell download.`,
    )
  }
  const dir = opts.headlessShellDir ?? DEFAULT_CHROME_HEADLESS_SHELL_DIR(opts.home ?? homedir())
  await installHeadlessShell(dir, opts)
  const shell = findHeadlessShell(dir, {
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.arch ? { arch: opts.arch } : {}),
    ...(opts.exists ? { exists: opts.exists } : {}),
    ...(opts.readdir ? { readdir: opts.readdir } : {}),
  })
  if (!shell) throw new Error(`chrome-headless-shell download into ${dir} left no executable.`)
  return { path: shell, source: "headless-shell" }
}

async function installHeadlessShell(dir: string, opts: ResolveChromeOptions): Promise<void> {
  // `@puppeteer/browsers` is installed into the same dir (like chrome-mcp,
  // resolved by absolute path — never through npx) and then asked to fetch
  // the browser next to itself.
  const { prefix } = await installChromeMcp({
    prefix: dir,
    ...(opts.npm ? { npm: opts.npm } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    pkg: "@puppeteer/browsers",
    binName: "browsers",
  })
  await run(
    process.execPath,
    [
      join(prefix, "node_modules", ".bin", "browsers"),
      "install",
      "chrome-headless-shell@stable",
      "--path",
      dir,
    ],
    dir,
    opts.onProgress,
  )
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false })
    let tail = ""
    const onData = (d: Buffer): void => {
      const s = d.toString("utf8")
      tail = (tail + s).slice(-1000)
      if (s.trim()) onProgress?.(s.trim())
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", reject)
    child.on("close", code =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${args.slice(1, 3).join(" ")} exited ${code}:\n${tail}`)),
    )
  })
}

// ── mcpServers entry ──────────────────────────────────────────────────

/** Structurally an `@agentproto/acp` `AcpMcpServer` stdio entry. */
export interface HeadlessBrowserMcpEntry {
  name: string
  transport: "stdio"
  ref: string
  args: string[]
  env: Record<string, string>
}

export interface BuildHeadlessBrowserMcpEntryOptions {
  /** From `ensureChromeDevtoolsMcp()`. */
  mcp: Pick<ChromeDevtoolsMcp, "entryScript">
  /** Node binary used to run the entry script. Default `process.execPath`. */
  node?: string
  /** Chrome binary; omitted ⇒ chrome-devtools-mcp picks installed stable. */
  executablePath?: string
  /** `WIDTHxHEIGHT`. Default `1440x900`. */
  viewport?: string
  /** Server name. Default `browser`. */
  name?: string
  /**
   * `false` ⇒ launch Chrome with `--no-sandbox`. Required when the agent's
   * process tree already runs under an OS sandbox (Seatbelt refuses a
   * nested `sandbox_init`); the outer sandbox is then the confinement.
   * Default true.
   */
  chromeSandbox?: boolean
  /** Extra Chrome flags (each becomes `--chromeArg=<flag>`). */
  chromeArgs?: string[]
  /** chrome-devtools-mcp debug log file. */
  logFile?: string
  /**
   * Explicit Chrome profile dir, used instead of `--isolated`. `--isolated`
   * only deletes its temp profile on a graceful `browser.close()`; when the
   * MCP server dies with its agent, Chrome exits on the broken pipe and the
   * profile is left behind. A caller-owned dir can always be deleted on
   * session exit.
   */
  userDataDir?: string
  /**
   * Directories the file-writing tools (`take_screenshot({ filePath })`, …)
   * may write to (`--workspace`, chrome-devtools-mcp ≥1.10). Omitted ⇒ its
   * default, the OS temp dir. Older versions ignore the flag.
   */
  filesystemRoots?: string[]
}

const VIEWPORT_RE = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/

/**
 * Build the stdio `mcpServers` entry for an isolated headless browser:
 * `node <chrome-devtools-mcp> --headless --isolated --viewport WxH …`.
 * The performance-trace tools are left out (large schemas, rarely useful
 * to a coding agent) and usage statistics / update checks are off.
 * `--no-page-id-routing` because the browser belongs to one session: with
 * routing on (the ≥1.10 default) every page tool demands a `pageId` the
 * agent first has to look up, and a single agent gains nothing from it.
 */
export function buildHeadlessBrowserMcpEntry(
  opts: BuildHeadlessBrowserMcpEntryOptions,
): HeadlessBrowserMcpEntry {
  const viewport = opts.viewport ?? DEFAULT_HEADLESS_VIEWPORT
  if (!VIEWPORT_RE.test(viewport)) {
    throw new Error(`buildHeadlessBrowserMcpEntry: viewport must be WIDTHxHEIGHT, got "${viewport}"`)
  }
  const chromeArgs = [
    ...(opts.chromeSandbox === false ? ["--no-sandbox"] : []),
    ...(opts.chromeArgs ?? []),
  ]
  return {
    name: opts.name ?? HEADLESS_BROWSER_MCP_NAME,
    transport: "stdio",
    ref: opts.node ?? process.execPath,
    args: [
      opts.mcp.entryScript,
      "--headless",
      ...(opts.userDataDir ? ["--userDataDir", opts.userDataDir] : ["--isolated"]),
      "--viewport",
      viewport,
      "--no-category-performance",
      "--no-performance-crux",
      "--no-usage-statistics",
      "--no-page-id-routing",
      ...(opts.filesystemRoots ?? []).flatMap(r => ["--workspace", r]),
      ...(opts.executablePath ? ["--executablePath", opts.executablePath] : []),
      ...chromeArgs.map(a => `--chromeArg=${a}`),
      ...(opts.logFile ? ["--logFile", opts.logFile] : []),
    ],
    env: {
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    },
  }
}

/**
 * Filesystem roots a confined agent needs READ access to for this browser:
 * the chrome-devtools-mcp install and the Chrome app bundle / install dir.
 */
export function headlessBrowserReadPaths(
  mcp: Pick<ChromeDevtoolsMcp, "prefix">,
  chrome?: Pick<ChromeExecutable, "path">,
): string[] {
  const paths = [mcp.prefix]
  if (chrome) {
    const app = chrome.path.match(/^(.*?\.app)\//)
    paths.push(app?.[1] ?? dirname(chrome.path))
  }
  return paths
}
