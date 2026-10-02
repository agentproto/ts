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
 * An app with no `ui.build` declared keeps today's behavior exactly: the
 * bundle must already exist on disk, and a missing one is a clear error
 * naming the path rather than a bare 404.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { Dirent, Stats } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
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

/** Newest mtime (ms) among every file matched by `patterns` (relative to
 *  `cwd`), or `undefined` if nothing matched any pattern. */
export async function newestSourceMtime(
  cwd: string,
  patterns: readonly string[],
): Promise<number | undefined> {
  let max: number | undefined
  for (const pattern of patterns) {
    const segments = pattern.replace(/^\.\//, "").split("/").filter(s => s.length > 0)
    if (segments.length === 0) continue
    for (const file of await collectGlobFiles(cwd, segments)) {
      try {
        const st = await stat(file)
        if (max === undefined || st.mtimeMs > max) max = st.mtimeMs
      } catch {
        // Vanished between listing and stat — ignore.
      }
    }
  }
  return max
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
}

export type EnsureAppUiBuiltResult =
  | { readonly ok: true; readonly built: boolean }
  | { readonly ok: false; readonly error: string }

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
    return {
      ok: false,
      error:
        `ui.build command "${build.command}" failed (exit ${result.exitCode}` +
        `${result.timedOut ? ", timed out" : ""}). See "${logPath}" for full output. ` +
        `Last lines:\n${tailLines(result.stderr || result.stdout, LOG_TAIL_LINES)}`,
    }
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
  | { readonly kind: "ready" }
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
 */
export async function resolveAppUiBuildState(input: EnsureAppUiBuiltInput): Promise<AppUiBuildState> {
  const { dir, uiPath } = input
  const pending = peekInFlightBuild(uiPath) ?? ensureAppUiBuilt(input)

  const timeout = new Promise<typeof RESOLVE_TIMEOUT>(resolve => {
    const timer = setTimeout(() => resolve(RESOLVE_TIMEOUT), RESOLVE_FAST_PATH_MS)
    timer.unref()
  })
  const raced = await Promise.race([pending, timeout])

  if (raced === RESOLVE_TIMEOUT) {
    const startedAt = peekBuildStartedAt(uiPath) ?? Date.now()
    return { kind: "building", startedAt, logTail: await readLogTailSafe(dir, READABLE_LOG_TAIL_LINES) }
  }
  const result = raced as EnsureAppUiBuiltResult
  if (!result.ok) {
    return {
      kind: "error",
      message: result.error,
      logPath: appUiBuildLogPath(dir),
      logTail: await readLogTailSafe(dir, READABLE_LOG_TAIL_LINES),
    }
  }
  return { kind: "ready" }
}
