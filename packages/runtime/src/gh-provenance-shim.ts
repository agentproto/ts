/**
 * Opt-in `gh` provenance PATH shim — the LOCAL-session counterpart to the
 * cloud runner's `@agentproto-bot` footer.
 *
 * The problem: a PR opened by a CLOUD bot gets a runner-stamped
 * `🤖 @agentproto-bot` footer (`pr-provenance.ts` / the agentflow scripts),
 * but a PR opened by a LOCAL agent session — `gh pr create` run by the agent
 * itself, or by an adapter subprocess shelling out (claude-code, codex, …) —
 * carries zero provenance. Same principle applies: the TOOL stamps, never the
 * model. Commit messages stay untouched (the repo's hygiene-check forbids
 * attribution there); the footer goes in the PR BODY only.
 *
 * Why a PATH shim, not an interception at the daemon's command-tools layer:
 * adapter CLIs spawn `gh` themselves from their OWN shells, which never pass
 * through `command-tools.ts`. A PATH shim is the one seam that catches every
 * `gh` invocation regardless of who spawned it. When
 * `provenance.wrapGh` is enabled, `session-spawn.ts` prepends
 * {@link ensureGhShimDir}'s directory to the spawned session's PATH and
 * injects the footer's provenance via env vars ({@link buildGhShimEnv}).
 *
 * The shim script itself ({@link renderGhShimScript}) is a self-contained
 * CommonJS program with NO imports beyond node built-ins — it runs in an
 * arbitrary user shell, so it can't import this package. It deliberately does
 * NOT touch `--body`/`--body-file` args: it runs the real `gh pr create`
 * verbatim, parses the printed PR URL, and appends the footer via a follow-up
 * `gh api` PATCH. Stamping is COSMETIC — any failure in the footer step is
 * swallowed and the wrapper always exits with the real `gh`'s exit code. If no
 * real `gh` is on PATH, the shim behaves exactly like the absence would.
 *
 * A body REWRITE gets the same treatment: `gh pr edit --body/-b/--body-file/-F`
 * and `gh api -X PATCH repos/…/(pulls|issues)/<n>` replace the whole body, so
 * an agent rewriting its own PR description silently dropped the footer the
 * runner had stamped, and Hygiene went red on the next push (agentproto/ts#2442).
 * The shim reads the body BEFORE the rewrite, runs the agent's command verbatim
 * (same args, stdio, exit code), and only when the old body carried a rendered
 * footer and the new one doesn't, PATCHes that exact footer back on. Never adds
 * a footer that wasn't there, never stacks a second one.
 *
 * This module owns the PURE, testable pieces (script generation, PATH
 * assembly, env assembly, the opt-in resolver); the shim's own runtime logic
 * (URL parse, exit-code passthrough) is exercised by generating the script and
 * driving it against a FAKE `gh` — no real `gh` required (see the tests).
 */

import { mkdir, writeFile, chmod } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import { homedir } from "node:os"

import { MARKER } from "./pr-provenance.js"
import { SESSION_ID_ENV, WORKSPACE_SLUG_ENV } from "./sessions.js"

/** Env override for the opt-in policy — highest precedence, ahead of the
 *  `provenance.wrapGh` config field. See {@link loadProvenanceWrapGh}. */
export const PROVENANCE_WRAP_GH_ENV = "AGENTPROTO_PROVENANCE_WRAP_GH"

/** The default when nothing is configured. OFF — provenance stamping is an
 *  opt-in feature, never applied to a session that didn't ask for it. */
export const DEFAULT_WRAP_GH = false

/** Flag the daemon sets so the shim knows it was intentionally installed
 *  (belt-and-braces; the shim's presence on PATH is the real signal). */
export const GH_PROVENANCE_ENABLE_ENV = "AGENTPROTO_GH_PROVENANCE"

/** Adapter/harness slug the footer renders — reuses the same value the
 *  descriptor records (`input.harness ?? input.adapter`). */
export const GH_PROVENANCE_ADAPTER_ENV = "AGENTPROTO_ADAPTER"

/** Resolved model id the footer renders. Absent when the spawn named none and
 *  the adapter declared no default. */
export const GH_PROVENANCE_MODEL_ENV = "AGENTPROTO_MODEL"

/** Parse a raw string into a boolean opt-in, or `undefined` when it isn't a
 *  recognised truthy/falsy token (so a lower-precedence source can decide). */
export function parseWrapGh(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true
  if (v === "0" || v === "false" || v === "no" || v === "off") return false
  return undefined
}

/**
 * Resolve the effective opt-in: env > config field > default. Mirrors
 * `loadSpawnAttach`'s precedence exactly. Never throws — an unreadable config
 * falls through to {@link DEFAULT_WRAP_GH}.
 */
export async function loadProvenanceWrapGh(
  loadCfg: () => Promise<{ provenance?: { wrapGh?: boolean } }> = defaultLoadConfig,
): Promise<boolean> {
  const fromEnv = parseWrapGh(process.env[PROVENANCE_WRAP_GH_ENV])
  if (fromEnv !== undefined) return fromEnv
  try {
    const cfg = await loadCfg()
    if (typeof cfg.provenance?.wrapGh === "boolean") return cfg.provenance.wrapGh
  } catch {
    // fall through to default
  }
  return DEFAULT_WRAP_GH
}

// Lazy import to avoid a config.ts <-> here import cycle at module load, and to
// keep this module importable by the tests without pulling the config reader.
async function defaultLoadConfig(): Promise<{ provenance?: { wrapGh?: boolean } }> {
  const { loadConfig } = await import("./config.js")
  return loadConfig()
}

/**
 * Prepend `shimDir` to `basePath` so the shim's `gh` shadows the real one.
 * Deduplicates a `shimDir` that already leads `basePath` (idempotent across a
 * re-spawn that inherited an already-shimmed PATH), and tolerates an empty
 * base. Pure — the PATH-assembly half the tests pin directly.
 */
export function assembleShimPath(
  shimDir: string,
  basePath: string,
  sep: string = delimiter,
): string {
  const base = basePath ?? ""
  const entries = base.length > 0 ? base.split(sep) : []
  if (entries[0] === shimDir) return base
  return [shimDir, ...entries].join(sep)
}

export interface GhShimEnvInput {
  /** Directory holding the shim `gh` executable ({@link ensureGhShimDir}). */
  shimDir: string
  /** The base PATH to prepend onto — the daemon's own `process.env.PATH`. */
  basePath: string
  /** Adapter/harness slug for the footer. */
  adapter?: string
  /** Resolved model id for the footer, when known. */
  model?: string
  sep?: string
}

/**
 * The env patch `session-spawn.ts` merges into a spawned session's env when
 * `provenance.wrapGh` is on: the shimmed PATH plus the footer's provenance the
 * shim reads back (session id + workspace slug already ride the daemon's own
 * identity vars, so only adapter/model are added here). Pure and testable.
 */
export function buildGhShimEnv(input: GhShimEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: assembleShimPath(input.shimDir, input.basePath, input.sep),
    [GH_PROVENANCE_ENABLE_ENV]: "1",
  }
  if (input.adapter) env[GH_PROVENANCE_ADAPTER_ENV] = input.adapter
  if (input.model) env[GH_PROVENANCE_MODEL_ENV] = input.model
  return env
}

/**
 * Render the self-contained shim `gh` program. CommonJS on purpose: the file
 * is named bare `gh` (no extension) and lives in a directory with no
 * `package.json`, so node treats it as CommonJS — no ESM ambiguity. `nodePath`
 * becomes the shebang so the shim runs even under a launchd-minimal PATH that
 * may not carry `node` (same reasoning as the daemon resolving `node` to
 * `process.execPath`). The footer builder is inlined (a small, self-contained
 * copy) rather than importing `pr-provenance.ts` — but the visible {@link
 * MARKER} and `<sub>…</sub>` shape are kept identical so local and cloud
 * footers render the same family.
 */
export function renderGhShimScript(opts: { nodePath: string }): string {
  // The MARKER is threaded in from the canonical source so the two can never
  // drift; everything else is literal to keep the shim import-free.
  return `#!${opts.nodePath}
"use strict"
// GENERATED by @agentproto/runtime (gh-provenance-shim.ts). Do not edit by
// hand — the daemon rewrites this on boot. See that module for the rationale.
const { spawnSync } = require("node:child_process")
const { statSync, realpathSync } = require("node:fs")
const path = require("node:path")
const os = require("node:os")

// The real filesystem location of this shim, so we can skip it while scanning
// PATH — compared by realpath so a symlinked temp/home dir (macOS /var ->
// /private/var) can't fool the equality check into an infinite recursion.
function realOf(p) {
  try { return realpathSync(p) } catch { return p }
}

const MARKER = ${JSON.stringify(MARKER)}
const SESSION_ID_ENV = ${JSON.stringify(SESSION_ID_ENV)}
const WORKSPACE_SLUG_ENV = ${JSON.stringify(WORKSPACE_SLUG_ENV)}
const ADAPTER_ENV = ${JSON.stringify(GH_PROVENANCE_ADAPTER_ENV)}
const MODEL_ENV = ${JSON.stringify(GH_PROVENANCE_MODEL_ENV)}

// A RENDERED footer line, not a prose mention of the marker.
const FOOTER_RE = new RegExp("<sub>[^\\n]*" + MARKER + "[^\\n]*</sub>")
const PR_ENDPOINT_RE = /^\\/?repos\\/[^\\/\\s]+\\/[^\\/\\s]+\\/(pulls|issues)\\/\\d+\\/?$/
// Side reads/writes never touch stdin (a \`--body-file -\` edit owns it), never
// print, and never hang the agent's command.
const SIDE_OPTS = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }

const args = process.argv.slice(2)
const shimDir = __dirname

// Resolve the REAL gh: the first executable \`gh\` on PATH that is NOT this
// shim's own directory (guarding against infinite recursion).
function findRealGh() {
  const selfReal = realOf(shimDir)
  const dirs = (process.env.PATH || "").split(path.delimiter)
  for (const d of dirs) {
    if (!d) continue
    const candidate = path.join(d, "gh")
    try { if (!statSync(candidate).isFile()) continue } catch { continue }
    if (realOf(d) === selfReal) continue
    return candidate
  }
  return null
}

const realGh = findRealGh()
if (!realGh) {
  // No real gh anywhere — behave exactly as its absence would: not found.
  process.stderr.write("agentproto gh-provenance shim: real 'gh' not found on PATH\\n")
  process.exit(127)
}

// Targeted: \`gh pr create\` (stamp a footer) and a PR body rewrite (keep the
// footer it already had). Everything else passes straight through to the real
// gh, exit code and all.
const positionals = args.filter(a => !a.startsWith("-"))
const isPrCreate = positionals[0] === "pr" && positionals[1] === "create"
let rewrite = null
try { rewrite = isPrCreate ? null : bodyRewriteTarget(args) } catch { rewrite = null }

function exitFrom(result) {
  if (result.error) {
    process.stderr.write(String(result.error && result.error.message) + "\\n")
    return 127
  }
  return typeof result.status === "number" ? result.status : 1
}

if (rewrite) {
  // Read the footer BEFORE the rewrite (afterwards it's gone), run the agent's
  // command verbatim, then put that exact footer back if the new body lost it.
  // COSMETIC like the create path: no failure here may touch the exit code.
  let kept = null
  try { kept = readFooter(rewrite) } catch { kept = null }
  const edit = spawnSync(realGh, args, { stdio: "inherit" })
  const editExit = exitFrom(edit)
  try {
    if (editExit === 0 && kept) restoreFooter(kept)
  } catch { /* swallow: keeping the footer never fails the underlying gh */ }
  process.exit(editExit)
}

if (!isPrCreate) {
  const passthrough = spawnSync(realGh, args, { stdio: "inherit" })
  process.exit(exitFrom(passthrough))
}

// Targeted: run the real create, capture stdout while echoing it through so
// the user still sees gh's own output (it prints the PR URL there).
const run = spawnSync(realGh, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })
const stdout = run.stdout || ""
if (stdout) process.stdout.write(stdout)
const exitCode = exitFrom(run)

// Footer step is COSMETIC: any failure here must never change the exit code.
try {
  if (exitCode === 0) {
    const parsed = parsePrUrl(stdout)
    if (parsed) stampFooter(parsed)
  }
} catch { /* swallow — stamping never fails the underlying gh */ }
process.exit(exitCode)

// --- pure-ish helpers (mirrors pr-provenance.ts's parseGhPrCreate/buildFooter) ---

function parsePrUrl(text) {
  // Take the LAST match so an advisory "Warning: …/pull/…" can't shadow the
  // real URL gh prints on its own line.
  const re = /https?:\\/\\/([^\\/\\s]+)\\/([^\\/\\s]+)\\/([^\\/\\s]+)\\/pull\\/(\\d+)/g
  let m
  let last = null
  while ((m = re.exec(text)) !== null) {
    last = { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]), url: m[0] }
  }
  return last
}

function cwdLabel(cwd, ws) {
  const leaf = path.basename(cwd)
  if (!ws || ws === leaf) return ws || leaf
  return ws + "/" + leaf
}

function buildFooter() {
  const parts = ["🤖 **" + MARKER + "** — PR"]
  const sid = process.env[SESSION_ID_ENV]
  if (sid) parts.push("session \`" + sid + "\`")
  const adapter = process.env[ADAPTER_ENV]
  if (adapter) parts.push(adapter)
  const model = process.env[MODEL_ENV]
  if (model) parts.push("model \`" + model + "\`")
  const host = os.hostname()
  if (host) parts.push("host \`" + host + "\`")
  parts.push("cwd \`" + cwdLabel(process.cwd(), process.env[WORKSPACE_SLUG_ENV]) + "\`")
  return "\\n\\n---\\n<sub>" + parts.join(" · ") + "</sub>"
}

function stampFooter(parsed) {
  // Read the current body via the real gh; append the footer once (idempotent
  // by MARKER, so a retry never stacks a second one).
  const view = spawnSync(realGh, ["pr", "view", parsed.url, "--json", "body", "-q", ".body"], { encoding: "utf8" })
  if (view.status !== 0) return
  let body = typeof view.stdout === "string" ? view.stdout : ""
  if (body.endsWith("\\n")) body = body.slice(0, -1)
  if (body.includes(MARKER)) return
  const newBody = body + buildFooter()
  // Post-create PATCH via \`gh api\` — never touches the create's own args.
  const apiPath = "repos/" + parsed.owner + "/" + parsed.repo + "/pulls/" + parsed.number
  const apiArgs = ["api"]
  if (parsed.host && parsed.host !== "github.com") apiArgs.push("--hostname", parsed.host)
  apiArgs.push(apiPath, "-X", "PATCH", "-f", "body=" + newBody)
  spawnSync(realGh, apiArgs, { stdio: "ignore" })
}

// --- body rewrite: keep the footer (mirrors pr-provenance.ts's hasProvenanceFooter) ---

// Split one argv token into its flag name and inline value: \`--body=x\`,
// \`-bx\`, or a bare \`--body\` / \`-b\` (value is the next token).
function splitFlag(a) {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=")
    return eq >= 0 ? { name: a.slice(0, eq), inline: a.slice(eq + 1) } : { name: a, inline: null }
  }
  return a.length > 2 ? { name: a.slice(0, 2), inline: a.slice(2) } : { name: a, inline: null }
}

// Which PR a body rewrite targets, or null when \`argv\` is not one:
//   gh pr edit [<number|url|branch>] (--body|-b|--body-file|-F) ... [-R repo]
//   gh api -X PATCH repos/<owner>/<repo>/(pulls|issues)/<n> with a body= field or --input
function bodyRewriteTarget(argv) {
  if (argv[0] === "pr" && argv[1] === "edit") {
    let selector = null
    let repo = null
    let body = false
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]
      if (a === "--") { if (selector === null && i + 1 < argv.length) selector = argv[i + 1]; break }
      if (!a.startsWith("-") || a === "-") { if (selector === null) selector = a; continue }
      const f = splitFlag(a)
      if (f.name === "-h" || f.name === "--help") return null
      let value = f.inline
      // Every \`gh pr edit\` flag takes a value except this boolean.
      if (value === null && f.name !== "--remove-milestone") value = argv[++i]
      if (f.name === "--body" || f.name === "-b" || f.name === "--body-file" || f.name === "-F") body = true
      if (f.name === "--repo" || f.name === "-R") repo = value
    }
    return body ? { kind: "pr", selector, repo } : null
  }
  if (argv[0] === "api") {
    let method = null
    let endpoint = null
    let hostname = null
    let body = false
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]
      if (!a.startsWith("-")) { if (endpoint === null && PR_ENDPOINT_RE.test(a)) endpoint = a; continue }
      const f = splitFlag(a)
      const value = f.inline !== null ? f.inline : argv[i + 1]
      if (f.name === "-X" || f.name === "--method") method = String(value || "").toUpperCase()
      else if (f.name === "--hostname") hostname = value
      else if (f.name === "-f" || f.name === "-F" || f.name === "--field" || f.name === "--raw-field") {
        if (String(value || "").startsWith("body=")) body = true
      } else if (f.name === "--input") body = true
      else continue
      if (f.inline === null) i++
    }
    return method === "PATCH" && endpoint && body ? { kind: "api", endpoint, hostname } : null
  }
  return null
}

// The rendered footer the PR carries right now, plus where to PATCH it back;
// null when the body has none (nothing to keep) or the read fails.
function readFooter(target) {
  let apiPath
  let host
  let body
  if (target.kind === "pr") {
    const viewArgs = ["pr", "view"]
    if (target.selector !== null) viewArgs.push(target.selector)
    if (target.repo) viewArgs.push("-R", target.repo)
    viewArgs.push("--json", "url,body")
    const view = spawnSync(realGh, viewArgs, SIDE_OPTS)
    if (view.status !== 0) return null
    const pr = JSON.parse(view.stdout)
    const loc = parsePrUrl(String(pr.url || ""))
    if (!loc) return null
    apiPath = "repos/" + loc.owner + "/" + loc.repo + "/pulls/" + loc.number
    host = loc.host && loc.host !== "github.com" ? ["--hostname", loc.host] : []
    body = pr.body
  } else {
    // The same endpoint string the agent used, so gh resolves any
    // {owner}/{repo} placeholder exactly as it does for the rewrite itself.
    apiPath = target.endpoint
    host = target.hostname ? ["--hostname", target.hostname] : []
    const get = spawnSync(realGh, ["api", ...host, apiPath], SIDE_OPTS)
    if (get.status !== 0) return null
    body = JSON.parse(get.stdout).body
  }
  const m = typeof body === "string" ? FOOTER_RE.exec(body) : null
  return m ? { footer: m[0], apiPath, host } : null
}

// After a successful rewrite: if the new body lost the footer, append that
// exact footer back (the shape buildFooter emits) with one PATCH.
function restoreFooter(kept) {
  const get = spawnSync(realGh, ["api", ...kept.host, kept.apiPath], SIDE_OPTS)
  if (get.status !== 0) return
  const raw = JSON.parse(get.stdout).body
  const body = typeof raw === "string" ? raw : ""
  if (FOOTER_RE.test(body)) return
  const newBody = body.replace(/\\n+$/, "") + "\\n\\n---\\n" + kept.footer
  spawnSync(realGh, ["api", ...kept.host, kept.apiPath, "-X", "PATCH", "-f", "body=" + newBody], { ...SIDE_OPTS, stdio: "ignore" })
}
`
}

/** Where the shim directory lives by default — a sibling of the other
 *  `~/.agentproto/` runtime dirs. */
export function defaultGhShimBaseDir(): string {
  return join(homedir(), ".agentproto", "shims")
}

// Memoize per (baseDir, nodePath) so repeated spawns don't rewrite the file.
const shimDirCache = new Map<string, Promise<string>>()

/**
 * Ensure the shim directory exists with an up-to-date, executable `gh`, and
 * return its absolute path. Idempotent and memoized per process — the script
 * only depends on the current node path, which is constant for a daemon's
 * lifetime. `baseDir`/`nodePath` are injectable for tests.
 */
export function ensureGhShimDir(opts: {
  baseDir?: string
  nodePath?: string
} = {}): Promise<string> {
  const baseDir = opts.baseDir ?? defaultGhShimBaseDir()
  const nodePath = opts.nodePath ?? process.execPath
  const key = `${baseDir} ${nodePath}`
  const cached = shimDirCache.get(key)
  if (cached) return cached
  const task = (async () => {
    await mkdir(baseDir, { recursive: true })
    const shimPath = join(baseDir, "gh")
    await writeFile(shimPath, renderGhShimScript({ nodePath }), "utf8")
    await chmod(shimPath, 0o755)
    return resolve(baseDir)
  })()
  shimDirCache.set(key, task)
  // Drop a failed attempt from the cache so a later spawn retries rather than
  // replaying the same rejection forever.
  task.catch(() => shimDirCache.delete(key))
  return task
}
