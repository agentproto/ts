/**
 * Build an installed app's UI bundle on demand, per APP.md's declared
 * `ui.build` (`@agentproto/app-kit`'s `AppUiBuildConfig`) — the piece that
 * lets a repo declare "how to build the UI" instead of committing the
 * generated `.agentproto/ui/index.html`.
 *
 * `ensureAppUiBuilt` is the one entry point, called from every path that's
 * about to serve or install an app's UI (`app_install` in app-tools.ts,
 * `GET /apps/:appId/ui` in http-server.ts, the MCP panel cache in
 * app-ui-apps.ts, and the CLI's `agentproto app serve`): if the declared
 * `uiPath` is missing, or older than the newest file matching `ui.build`'s
 * `sources` globs (default `["src/**"]`, resolved against `ui.build.cwd` —
 * default the app dir), it runs `ui.build.command` once, captures output to
 * `~/.agentproto/logs/app-ui-build/` (see `appUiBuildLogPath`), and returns a result the caller turns
 * into either a served page or a readable error. Concurrent callers for the
 * same `uiPath` share one in-flight build (single-flight, keyed on the
 * absolute `uiPath` — an app's bundle lives at one path regardless of which
 * route is asking).
 *
 * Staleness is two-tier. The mtime comparison above is only the fast path:
 * when it says "stale", the sources' CONTENT is hashed and compared with the
 * hash recorded after the last successful build (`appUiBuildStampPath`, under
 * the daemon state dir). A matching hash means nothing that feeds the bundle
 * actually changed — a `git checkout`/`stash`/hook that rewrote files with
 * identical bytes only bumped their mtimes — so no build runs. Test files
 * (`DEFAULT_SOURCE_EXCLUDES`) never count as sources, and a `!pattern` entry
 * in `sources` excludes more.
 *
 * Page renders go through `resolveAppUiBuildState`, which never makes a user
 * wait on a REbuild: when a bundle already exists it is served as-is while
 * the rebuild runs in the background (stale-while-revalidate), and a failed
 * background rebuild keeps serving it, without retrying until the sources
 * change again. Only a MISSING bundle shows the "building" placeholder.
 *
 * An app with no `ui.build` declared keeps today's behavior exactly: the
 * bundle must already exist on disk, and a missing one is a clear error
 * naming the path rather than a bare 404.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { Dirent, Stats } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AppUiBuildConfig } from "@agentproto/app-kit"

/**
 * Deliberately NOT `command-tools.ts`'s `runCommand` — that pulls in
 * `sessions.ts` (session identity, spawn bookkeeping — thousands of lines
 * unrelated to running a build), which would drag the whole session
 * subsystem into this module's own `tsup` entry (`./app-ui-build`,
 * `tsup.config.ts`), a lean subpath the CLI imports on its own (same
 * pattern as `app-ui-delivery.ts`, which only imports node builtins). A
 * one-shot build command doesn't need `runCommand`'s process-group
 * bookkeeping either — it has no long-lived subtree to reap beyond its own
 * (possibly shell-spawned) child.
 */
interface RunResult {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout?.on("data", d => {
      stdout += d.toString("utf8")
    })
    child.stderr?.on("data", d => {
      stderr += d.toString("utf8")
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref()
    }, timeoutMs)
    timer.unref()
    child.on("error", err => {
      clearTimeout(timer)
      resolvePromise({ exitCode: -1, timedOut, stdout, stderr: stderr + (err as Error).message })
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? -1, timedOut, stdout, stderr })
    })
  })
}

function resolveAgainst(dir: string, path: string): string {
  return isAbsolute(path) ? path : join(dir, path)
}

/** Turn one glob SEGMENT (no `/`) into a regex — `*` matches any run of
 *  characters within the segment, everything else is literal. */
function segmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

/**
 * Resolve one glob pattern (already split into path segments, relative to
 * `baseDir`) to the absolute paths of every FILE it matches. Supports `**`
 * (zero or more path segments, so `"src/**"` matches every file anywhere
 * under `src/`, including `src/` itself) and `*` within a single segment —
 * not full glob syntax (no brace expansion, no negation, no `?`). That
 * subset covers the documented default (`src/**`) and the common overrides
 * (`package.json`, `public/**`, `*.html`) without pulling in a glob
 * dependency for a staleness check.
 */
async function collectGlobFiles(baseDir: string, segments: readonly string[]): Promise<string[]> {
  if (segments.length === 0) {
    try {
      const st = await stat(baseDir)
      return st.isFile() ? [baseDir] : []
    } catch {
      return []
    }
  }
  const [head, ...rest] = segments
  if (head === "**") {
    const results: string[] = [...(await collectGlobFiles(baseDir, rest))]
    let entries: Dirent[]
    try {
      entries = await readdir(baseDir, { withFileTypes: true })
    } catch {
      return results
    }
    for (const entry of entries) {
      const full = join(baseDir, entry.name)
      if (entry.isDirectory()) {
        results.push(...(await collectGlobFiles(full, segments)))
      } else if (rest.length === 0) {
        results.push(full)
      }
    }
    return results
  }
  const regex = segmentToRegex(head!)
  let entries: Dirent[]
  try {
    entries = await readdir(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (!regex.test(entry.name)) continue
    results.push(...(await collectGlobFiles(join(baseDir, entry.name), rest)))
  }
  return results
}

/** Whole-path glob → regex, for EXCLUDE patterns matched against a source's
 *  `/`-separated path relative to `cwd`: `**` spans any number of segments
 *  (a leading or trailing `**` segment also matches zero), `*` stays within
 *  one segment. */
function pathGlobToRegex(pattern: string): RegExp {
  let out = ""
  let i = 0
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?"
      i += 3
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      out += "(?:/.*)?"
      i += 3
    } else if (pattern.startsWith("**", i)) {
      out += ".*"
      i += 2
    } else if (pattern[i] === "*") {
      out += "[^/]*"
      i += 1
    } else {
      out += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      i += 1
    }
  }
  return new RegExp(`^${out}$`)
}

/** Never sources, whatever `ui.build.sources` says: tests don't feed a UI
 *  bundle, so editing one must not trigger a multi-second rebuild. */
export const DEFAULT_SOURCE_EXCLUDES: readonly string[] = ["**/__tests__/**", "**/*.test.*", "**/*.spec.*"]

/**
 * Every file matched by `patterns` (relative to `cwd`), minus
 * {@link DEFAULT_SOURCE_EXCLUDES} and any `!pattern` entry in `patterns`.
 * Returned sorted by relative path, deduped (two patterns can match the same
 * file), as `{ abs, rel }` with `rel` always `/`-separated.
 */
export async function collectSourceFiles(
  cwd: string,
  patterns: readonly string[],
): Promise<{ readonly abs: string; readonly rel: string }[]> {
  const normalize = (p: string) => p.replace(/^\.\//, "")
  const excludes = [
    ...DEFAULT_SOURCE_EXCLUDES,
    ...patterns.filter(p => p.startsWith("!")).map(p => normalize(p.slice(1))),
  ].map(pathGlobToRegex)
  const byRel = new Map<string, string>()
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue
    const segments = normalize(pattern).split("/").filter(s => s.length > 0)
    if (segments.length === 0) continue
    for (const abs of await collectGlobFiles(cwd, segments)) {
      const rel = relative(cwd, abs).split(sep).join("/")
      if (excludes.some(re => re.test(rel))) continue
      byRel.set(rel, abs)
    }
  }
  return [...byRel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, abs]) => ({ abs, rel }))
}

/** Newest mtime (ms) among every source file `patterns` selects (relative
 *  to `cwd`, see {@link collectSourceFiles}), or `undefined` if none. */
export async function newestSourceMtime(
  cwd: string,
  patterns: readonly string[],
): Promise<number | undefined> {
  let max: number | undefined
  for (const { abs } of await collectSourceFiles(cwd, patterns)) {
    try {
      const st = await stat(abs)
      if (max === undefined || st.mtimeMs > max) max = st.mtimeMs
    } catch {
      // Vanished between listing and stat — ignore.
    }
  }
  return max
}

/** Last content hash computed per `uiPath`, with the stat signature
 *  (path + mtime + size of every source) it was computed under — so a page
 *  re-rendered while mtimes still read "stale" re-stats the sources but
 *  doesn't re-read every one of them. */
const hashMemo = new Map<string, { readonly signature: string; readonly hash: string }>()

/**
 * Content hash of everything that decides what `build` produces: the
 * selected source files (relative path + bytes, in sorted order) and the
 * build command itself. Identical inputs hash identically whatever their
 * mtimes — the point of the second staleness tier.
 */
export async function hashAppUiSources(
  uiPath: string,
  cwd: string,
  build: AppUiBuildConfig,
): Promise<string> {
  const files = await collectSourceFiles(cwd, build.sources ?? DEFAULT_SOURCE_GLOBS)
  const sig = createHash("sha1").update(`${cwd}\0${build.command}`)
  const present: { readonly abs: string; readonly rel: string }[] = []
  for (const file of files) {
    try {
      const st = await stat(file.abs)
      sig.update(`\0${file.rel}\0${st.mtimeMs}\0${st.size}`)
      present.push(file)
    } catch {
      // Vanished between listing and stat — not a source anymore.
    }
  }
  const signature = sig.digest("hex")
  const memo = hashMemo.get(uiPath)
  if (memo && memo.signature === signature) return memo.hash

  const content = createHash("sha256").update(`command\0${build.command}\0`)
  for (const file of present) {
    let bytes: Buffer
    try {
      bytes = await readFile(file.abs)
    } catch {
      continue
    }
    content.update(`file\0${file.rel}\0${bytes.length}\0`).update(bytes)
  }
  const hash = content.digest("hex")
  hashMemo.set(uiPath, { signature, hash })
  return hash
}

/** What the last successful build recorded: the source hash it was built
 *  from, and the bundle it produced (mtime + size) — the stamp only vouches
 *  for THAT bundle, so a bundle replaced behind our back (a checkout of an
 *  older committed one) doesn't inherit it. */
interface AppUiBuildStamp {
  readonly sourcesHash: string
  readonly bundleMtimeMs: number
  readonly bundleSize: number
}

/** Where the build stamp for `uiPath` lives — the daemon state dir, never
 *  the app dir (same reasoning as {@link appUiBuildLogPath}); `<hash>` is
 *  over the absolute `uiPath`, the same key single-flight uses. */
export function appUiBuildStampPath(uiPath: string): string {
  const abs = resolve(uiPath)
  const home = process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
  const name = basename(dirname(dirname(dirname(abs)))).replace(/[^A-Za-z0-9._-]+/g, "-") || "app"
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 12)
  return join(home, "state", "app-ui-build", `${name}-${hash}.json`)
}

async function readStamp(uiPath: string): Promise<AppUiBuildStamp | undefined> {
  try {
    const raw = JSON.parse(await readFile(appUiBuildStampPath(uiPath), "utf8")) as Partial<AppUiBuildStamp>
    if (
      typeof raw.sourcesHash === "string" &&
      typeof raw.bundleMtimeMs === "number" &&
      typeof raw.bundleSize === "number"
    ) {
      return { sourcesHash: raw.sourcesHash, bundleMtimeMs: raw.bundleMtimeMs, bundleSize: raw.bundleSize }
    }
  } catch {
    // Missing or unreadable — no stamp, so mtime alone decides.
  }
  return undefined
}

async function writeStamp(uiPath: string, stamp: AppUiBuildStamp): Promise<void> {
  const path = appUiBuildStampPath(uiPath)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(stamp), "utf8")
  } catch {
    // Best-effort — without a stamp the next mtime-stale check just rebuilds.
  }
}

const DEFAULT_BUILD_TIMEOUT_MS = 120_000
const DEFAULT_SOURCE_GLOBS = ["src/**"]
const LOG_TAIL_LINES = 40

/** Where a `ui.build` run's captured output lands — read this on a build
 *  failure for the full log; the returned error carries only a tail.
 *  Lives under the daemon state dir
 *  (`$AGENTPROTO_HOME|~/.agentproto/logs/app-ui-build/<name>-<hash>.log`),
 *  never inside the app dir: an installed app's dir is replaceable code
 *  (swapped on reinstall, packed into `.agentapp`s), not a place for
 *  runtime output. `<hash>` is over the absolute app dir, so two apps with
 *  the same folder name never share a log. */
export function appUiBuildLogPath(appDir: string): string {
  const abs = resolve(appDir)
  const home = process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
  const name = basename(abs).replace(/[^A-Za-z0-9._-]+/g, "-") || "app"
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 12)
  return join(home, "logs", "app-ui-build", `${name}-${hash}.log`)
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n")
  return lines.slice(-n).join("\n")
}

/** A built single-file bundle should never reference `./assets/…` — the
 *  daemon serves `ui.path` standalone (no adjacent static server for a
 *  split build's chunks outside the one `assets/` convention `GET
 *  /apps/:appId/ui/assets/:file` already covers for a *committed* bundle).
 *  A build step that emits a split bundle anyway gets a loud warning, not a
 *  failure — the app may still work if its bundler also copied the chunks
 *  next to `ui.path`. */
const ASSET_REFERENCE_RE = /(?:src|href)\s*=\s*["'](?:\.{0,2}\/)?assets\//i

async function warnIfNotSingleFile(uiPath: string): Promise<void> {
  let html: string
  try {
    html = await readFile(uiPath, "utf8")
  } catch {
    return
  }
  if (ASSET_REFERENCE_RE.test(html)) {
    console.warn(
      `[app-ui-build] "${uiPath}" references "./assets" after a ui.build run. ` +
        "The daemon expects a single-file bundle here — a split build (separate " +
        "JS/CSS chunks under an assets/ dir) may 404 those chunks unless the " +
        "app's bundler inlines everything into one file.",
    )
  }
}

export interface EnsureAppUiBuiltInput {
  /** Absolute app directory — anchors a relative `build.cwd` and the build
   *  log's location. */
  readonly dir: string
  /** Absolute path to the ui bundle's entry file (APP.md's `ui.path`,
   *  already resolved absolute). Also the single-flight key. */
  readonly uiPath: string
  readonly build?: AppUiBuildConfig
  /** Hard timeout for the build command. Defaults to 120s. */
  readonly timeoutMs?: number
  /** Return the previous build's failure, without re-running the command,
   *  when the sources hash to what that failed build saw. Set by page
   *  renders (`resolveAppUiBuildState`), which would otherwise re-run a
   *  broken build on every panel open; left off for explicit callers
   *  (`app_install`, `app serve`), where re-running IS the retry. */
  readonly reuseFailure?: boolean
}

export type EnsureAppUiBuiltResult =
  | { readonly ok: true; readonly built: boolean }
  | { readonly ok: false; readonly error: string }

/** The last failed build per `uiPath` and the source hash it ran on —
 *  see {@link EnsureAppUiBuiltInput.reuseFailure}. Cleared by a success. */
const lastFailure = new Map<string, { readonly sourcesHash: string; readonly result: EnsureAppUiBuiltResult }>()

/** In-flight builds keyed on the absolute `uiPath` — an app's bundle lives
 *  at one path regardless of which route (app_install, GET .../ui, the MCP
 *  panel cache, `app serve`) asked for it, so keying here (rather than on
 *  appId, which isn't always known yet — see app-tools.ts's `performInstall`
 *  calling this BEFORE the app has an id) still dedupes every caller. */
const inFlight = new Map<string, Promise<EnsureAppUiBuiltResult>>()

/** When the CURRENTLY in-flight build (if any) actually started running its
 *  `build.command` — set right before `runShellCommand`, read by a
 *  non-blocking caller (`resolveAppUiBuildState` below) to render "building
 *  for Ns" without itself timing anything. Not set for a call that resolves
 *  from `existing`/freshness alone (no command ever ran). */
const buildStartedAt = new Map<string, number>()

/** Peek whether `uiPath` has a build running right now without starting one
 *  — a non-blocking caller (`resolveAppUiBuildState`) uses this to join an
 *  ALREADY-showing build instead of racing a fresh `ensureAppUiBuilt` call
 *  (which would itself re-do the cheap stat/freshness check every time). */
export function peekInFlightBuild(uiPath: string): Promise<EnsureAppUiBuiltResult> | undefined {
  return inFlight.get(uiPath)
}

/** Paired with {@link peekInFlightBuild}: when that returns a promise, this
 *  is the wall-clock time (`Date.now()`) its build command actually started
 *  — `undefined` if the in-flight promise hasn't reached `runShellCommand`
 *  yet (a handful of stat calls out), in which case "now" is as good a
 *  start time as any. */
export function peekBuildStartedAt(uiPath: string): number | undefined {
  return buildStartedAt.get(uiPath)
}

async function runEnsure(input: EnsureAppUiBuiltInput): Promise<EnsureAppUiBuiltResult> {
  const { dir, uiPath, build } = input

  let existing: Stats | undefined
  try {
    existing = await stat(uiPath)
  } catch {
    existing = undefined
  }

  if (!build) {
    if (existing) return { ok: true, built: false }
    return {
      ok: false,
      error:
        `app ui bundle "${uiPath}" is missing and the app declares no \`ui.build\` — ` +
        "either commit the built bundle, or add a `ui.build` step to APP.md's `ui` " +
        "frontmatter (`ui.build.command`, run with cwd `ui.build.cwd` or the app dir).",
    }
  }

  const buildCwd = build.cwd ? resolveAgainst(dir, build.cwd) : dir
  const sources = build.sources ?? DEFAULT_SOURCE_GLOBS

  if (existing) {
    const newest = await newestSourceMtime(buildCwd, sources)
    if (newest === undefined || newest <= existing.mtimeMs) {
      return { ok: true, built: false }
    }
  }

  // mtime says stale (or there's no bundle): hash the inputs. A hash equal
  // to the one the CURRENT bundle was built from means only mtimes moved.
  const sourcesHash = await hashAppUiSources(uiPath, buildCwd, build)
  if (existing) {
    const stamp = await readStamp(uiPath)
    if (
      stamp &&
      stamp.sourcesHash === sourcesHash &&
      stamp.bundleMtimeMs === existing.mtimeMs &&
      stamp.bundleSize === existing.size
    ) {
      return { ok: true, built: false }
    }
  }
  if (input.reuseFailure) {
    const failed = lastFailure.get(uiPath)
    if (failed && failed.sourcesHash === sourcesHash) return failed.result
  }

  const logPath = appUiBuildLogPath(dir)
  const startedAt = new Date().toISOString()
  buildStartedAt.set(uiPath, Date.now())
  const result = await runShellCommand(build.command, buildCwd, input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS)

  const logBody =
    `[${startedAt}] ui.build: ${build.command}\n` +
    `cwd: ${buildCwd}\n` +
    `exit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await writeFile(logPath, logBody, "utf8")
  } catch {
    // Best-effort — a log write failure must not hide a build failure.
  }

  if (result.exitCode !== 0) {
    const failed: EnsureAppUiBuiltResult = {
      ok: false,
      error:
        `ui.build command "${build.command}" failed (exit ${result.exitCode}` +
        `${result.timedOut ? ", timed out" : ""}). See "${logPath}" for full output. ` +
        `Last lines:\n${tailLines(result.stderr || result.stdout, LOG_TAIL_LINES)}`,
    }
    lastFailure.set(uiPath, { sourcesHash, result: failed })
    return failed
  }

  let rebuilt: Stats | undefined
  try {
    rebuilt = await stat(uiPath)
  } catch {
    rebuilt = undefined
  }
  if (!rebuilt) {
    return {
      ok: false,
      error:
        `ui.build command "${build.command}" exited 0 but "${uiPath}" is still missing — ` +
        `check the command actually writes its output there. See "${logPath}" for full output.`,
    }
  }

  await warnIfNotSingleFile(uiPath)

  lastFailure.delete(uiPath)
  await writeStamp(uiPath, { sourcesHash, bundleMtimeMs: rebuilt.mtimeMs, bundleSize: rebuilt.size })
  return { ok: true, built: true }
}

/**
 * Ensure `uiPath` exists and is at least as new as its declared sources,
 * building it first if not. Single-flight per `uiPath`: a second call for
 * the same path while a build is running awaits the same result instead of
 * starting a second build.
 */
export async function ensureAppUiBuilt(
  input: EnsureAppUiBuiltInput,
): Promise<EnsureAppUiBuiltResult> {
  const key = input.uiPath
  const inflight = inFlight.get(key)
  if (inflight) return inflight
  const promise = runEnsure(input).finally(() => {
    inFlight.delete(key)
    buildStartedAt.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

const RESOLVE_FAST_PATH_MS = 300
const READABLE_LOG_TAIL_LINES = 20
const RESOLVE_TIMEOUT = Symbol("app-ui-build-resolve-timeout")

async function readLogTailSafe(dir: string, n: number): Promise<string | undefined> {
  try {
    const text = await readFile(appUiBuildLogPath(dir), "utf8")
    const lines = text.split("\n").filter(line => line.length > 0)
    const tail = lines.slice(-n).join("\n")
    return tail.length > 0 ? tail : undefined
  } catch {
    return undefined
  }
}

export type AppUiBuildState =
  /** Serve `uiPath`. `stale` is set when the bundle on disk is NOT the
   *  current sources' build — `"rebuilding"` (a background build is running;
   *  the next render picks up its output) or `"build-failed"` (the last
   *  rebuild failed; see the build log) — but is still the best page there
   *  is. */
  | { readonly kind: "ready"; readonly stale?: "rebuilding" | "build-failed" }
  | { readonly kind: "building"; readonly startedAt: number; readonly logTail?: string }
  | { readonly kind: "error"; readonly message: string; readonly logPath: string; readonly logTail?: string }

/**
 * Non-blocking status check for `ensureAppUiBuilt`'s outcome — the piece
 * that lets a PAGE render (the `ui://app_ui_<id>/view` MCP resource in
 * app-ui-apps.ts, `GET /apps/:appId/ui` in http-server.ts) never stall on a
 * multi-second `ui.build` run. Joins an already-running build via
 * {@link peekInFlightBuild} (or starts one — still single-flight, since
 * `ensureAppUiBuilt` itself owns `inFlight`) and waits only up to
 * `RESOLVE_FAST_PATH_MS`: long enough that the common "already built and
 * fresh" case (a handful of `stat` calls) resolves as `"ready"` without ever
 * showing a placeholder, short enough that a real build never blocks the
 * caller — it keeps running in the background regardless, and the NEXT call
 * (after the page's own reload) picks up wherever that build landed.
 *
 * Stale-while-revalidate: when a bundle already exists, a REbuild never
 * shows the "building" placeholder or a failure page — the existing bundle
 * is served (`ready` + `stale`) while the build runs, and after it fails.
 * A failed rebuild isn't re-run on each render until its sources change
 * (`reuseFailure`). Only a missing bundle yields `building`/`error`, and that
 * case always retries, since there's nothing else to serve.
 */
export async function resolveAppUiBuildState(input: EnsureAppUiBuiltInput): Promise<AppUiBuildState> {
  const { dir, uiPath } = input
  let hasBundle: boolean
  try {
    hasBundle = (await stat(uiPath)).isFile()
  } catch {
    hasBundle = false
  }
  const pending = peekInFlightBuild(uiPath) ?? ensureAppUiBuilt({ ...input, reuseFailure: hasBundle })

  const timeout = new Promise<typeof RESOLVE_TIMEOUT>(resolve => {
    const timer = setTimeout(() => resolve(RESOLVE_TIMEOUT), RESOLVE_FAST_PATH_MS)
    timer.unref()
  })
  const raced = await Promise.race([pending, timeout])

  if (raced === RESOLVE_TIMEOUT) {
    if (hasBundle) return { kind: "ready", stale: "rebuilding" }
    const startedAt = peekBuildStartedAt(uiPath) ?? Date.now()
    return { kind: "building", startedAt, logTail: await readLogTailSafe(dir, READABLE_LOG_TAIL_LINES) }
  }
  const result = raced as EnsureAppUiBuiltResult
  if (!result.ok) {
    if (hasBundle) return { kind: "ready", stale: "build-failed" }
    return {
      kind: "error",
      message: result.error,
      logPath: appUiBuildLogPath(dir),
      logTail: await readLogTailSafe(dir, READABLE_LOG_TAIL_LINES),
    }
  }
  return { kind: "ready" }
}
