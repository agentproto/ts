/**
 * WP3 — `agent_start.sandbox` + `appServe`: serve an agentproto app's UI
 * from INSIDE a booted sandbox box and hand back its public URL.
 *
 * The sandbox spawn path (`session-spawn.ts`'s `bootSandboxAgentSession`)
 * boots a box whose own agentproto daemon is reachable at `BootedSandbox
 * .mcpUrl`. That daemon already registers every tool the plain `/mcp`
 * gateway mounts — notably `app_install` (app-tools.ts), `file_read` /
 * `file_write` (fs-tools.ts, anchored to the box workspace) and
 * `command_execute` (command-tools.ts, allowlist-gated). This module
 * drives exactly those three, in order:
 *
 *   1. `app_install { dir }`        — install the app (dir is a path INSIDE
 *                                     the box; on the workstation image the
 *                                     daemon workspace is `/home/user`, so a
 *                                     pulled app lives at
 *                                     `/home/user/apps/<slug>`).
 *   2. allowlist seed               — `command_execute` is default-deny
 *                                     against the box workspace's
 *                                     `.agentproto/allowed-commands.json`.
 *                                     The launcher below needs `sh` (the
 *                                     detached backgrounding shell) and
 *                                     `agentproto` (the CLI that runs the
 *                                     server). Both are merged into the
 *                                     existing allowlist via `file_read` +
 *                                     `file_write` — additive only, so an
 *                                     operator-seeded allowlist is preserved.
 *   3. `command_execute`            — launch `agentproto app serve <dir>
 *                                     --host 0.0.0.0 --port <port>` DETACHED
 *                                     (`sh -c 'nohup … &'`): the sh wrapper
 *                                     exits immediately, so the RPC returns
 *                                     while the orphaned server lives as
 *                                     long as the box does. A direct
 *                                     (non-backgrounded) call would be
 *                                     hard-killed at `command_execute`'s
 *                                     timeoutMs cap — the server must
 *                                     outlive the RPC.
 *
 * The caller resolves the PUBLIC URL from the provider (a port declared in
 * `SandboxSpec.extraPorts` comes back pre-resolved in `BootedSandbox.ports`;
 * otherwise `BootedSandbox.expose(port)` works for any port on providers
 * that support it) and passes it in — readiness is probed against it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SandboxExecOpts } from "@agentproto/sandbox"
import type { SandboxExec } from "./sandbox-workspace-remote.js"
import { workspaceFromMarkdownText } from "@agentproto/app"
import {
  createGithubWorkspaceSync,
  type AsyncGitRunner,
  type GithubStorageConfig,
} from "@agentproto/storage-github"
import { declaredGithubWorkspace } from "./app-workspace.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import type { SyncTree } from "@agentproto/storage-github"

/** Default port `appServe` serves on when the caller doesn't pin one. */
export const DEFAULT_APP_SERVE_PORT = 3210

/** Workspace-relative allowlist file the box daemon's `command_execute`
 *  gates on (`ALLOWLIST_REL` in command-allowlist.ts — mirrored here as a
 *  literal so this module stays import-light). */
export const BOX_ALLOWLIST_REL = ".agentproto/allowed-commands.json"

/** Basenames the launcher needs allowlisted in the box workspace. */
const REQUIRED_ALLOWLIST_BASENAMES = ["sh", "agentproto"] as const

/** The `appServe` request carried on `agent_start` — an in-box app dir plus
 *  the port to serve its UI on. */
export interface SandboxAppServeSpec {
  /** Absolute path to the app's directory INSIDE the box (e.g.
   *  `/home/user/apps/<slug>`). Must not contain a single quote — the
   *  launcher shell-quotes it. */
  dir: string
  /** Port `agentproto app serve` binds inside the box. Must also be exposed
   *  by the provider (the spawn path appends it to `extraPorts` so a
   *  boot-time exposure exists on providers that pre-resolve). Defaults to
   *  `DEFAULT_APP_SERVE_PORT` when omitted. */
  port?: number
}

/** What a served app records on the session descriptor and echoes in the
 *  spawn result — non-secret, caller-visible. */
export interface SessionAppServeInfo {
  /** App id the box's `app_install` registered. */
  appId: string
  /** The in-box app dir that was installed + served. */
  dir: string
  /** Port the UI binds inside the box. */
  port: number
  /** Provider-resolved public URL for the served UI. */
  url: string
  /** True when a probe against `url` answered OK within the readiness
   *  window. False means the URL is the right address but the server had
   *  not answered yet — retry the fetch rather than re-spawning. */
  ready: boolean
  /** Error text from the in-box serve log when `ready` is false (e.g. the
   *  server exited immediately because the UI root is missing). Absent when
   *  the log holds no recognizable error or could not be read. */
  message?: string
}

/** The wire shape a daemon MCP tool reply carries — the subset this module
 *  reads. Tool results come back as `content: [{ type: "text", text }]`. */
export interface ToolTextResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** Minimal typed client over the BOX daemon's `/mcp` endpoint. Narrowed so
 *  tests can inject a fake without the MCP SDK. */
export interface BoxToolClient {
  callTool(
    name: string,
    args: Record<string, string | number | string[]>,
  ): Promise<ToolTextResult>
  close(): Promise<void>
}

/** The SDK's `callTool` reply is effectively index-signature-typed
 *  (`{ [key: string]: unknown }`), so the wrapper round-trips it through
 *  the guarded JSON parser below — no casts, and a malformed reply fails
 *  loudly instead of smuggling untyped data through. */
export async function connectBoxToolClient(mcpUrl: string): Promise<BoxToolClient> {
  const client = new Client(
    { name: "agentproto-sandbox-app-serve", version: "0.1.0" },
    { capabilities: {} },
  )
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  await client.connect(transport)
  return {
    async callTool(name, args): Promise<ToolTextResult> {
      const raw = await client.callTool({ name, arguments: args })
      const reply = parseJsonRecordText(JSON.stringify(raw))
      if (!reply) {
        throw new Error(`box tool "${name}" returned an unreadable reply`)
      }
      const content = textBlocks(reply.content)
      if (reply.isError === true) {
        const text = content.find(c => c.type === "text")?.text
        throw new Error(
          `box tool "${name}" failed${text ? `: ${text}` : ""}`,
        )
      }
      return { content }
    },
    async close(): Promise<void> {
      await client.close()
    },
  }
}

/** Normalize a parsed reply's `content` value into the block shape this
 *  module reads, dropping anything that isn't a `{ type, text? }` record. */
function textBlocks(value: JsonValue | undefined): ToolTextResult["content"] {
  if (!Array.isArray(value)) return []
  const blocks: Array<{ type: string; text?: string }> = []
  for (const item of value) {
    if (!isJsonRecord(item)) continue
    blocks.push({
      type: typeof item.type === "string" ? item.type : "",
      ...(typeof item.text === "string" ? { text: item.text } : {}),
    })
  }
  return blocks
}

/** First text block of a tool result, or undefined when there is none. */
function firstText(res: ToolTextResult): string | undefined {
  const block = res.content.find(c => c.type === "text")
  return block?.text
}

// ── JSON parsing without casts ─────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord
export interface JsonRecord {
  [key: string]: JsonValue
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse a text payload as a JSON object. Returns undefined when the text is
 *  empty or is not a JSON object — never throws. */
export function parseJsonRecordText(text: string): JsonRecord | undefined {
  if (text.length === 0) return undefined
  const parsed: JsonValue = JSON.parse(text)
  return isJsonRecord(parsed) ? parsed : undefined
}

/** Parse a tool result's text payload as a JSON object. Returns undefined
 *  when the payload is missing or is not a JSON object — never throws. */
export function parseToolJson(res: ToolTextResult): JsonRecord | undefined {
  const text = firstText(res)
  if (text === undefined) return undefined
  return parseJsonRecordText(text)
}

// ── pure helpers (unit-tested without any I/O) ─────────────────────────────

/**
 * Build the `sh -c` script that launches `agentproto app serve` detached
 * inside the box: `nohup … &` backgrounds the server (the orphaned process
 * survives the RPC that spawned it) and `echo $!` prints the server's PID so
 * the caller's result records it. Throws on a `dir` containing a single
 * quote — the shell quoting below would otherwise turn it into an injection.
 */
export function buildServeLaunchScript(dir: string, port: number): string {
  if (dir.includes("'")) {
    throw new Error(
      `sandbox app serve: app dir must not contain a single quote: "${dir}"`,
    )
  }
  const log = `${dir.replace(/\/+$/, "")}/.agentproto/app-serve.log`
  return `nohup agentproto app serve '${dir}' --host 0.0.0.0 --port ${port} >> '${log}' 2>&1 & echo $!`
}

/** Merge the basenames the launcher needs into an allowlist file's text.
 *  Additive only — every existing entry is preserved verbatim (a plain
 *  string or a `{command, args}` object). Returns the new file body as
 *  pretty-printed JSON. Accepts `null` (file absent / unreadable) and
 *  returns a minimal allowlist containing just the required basenames. */
export function mergeAllowlistForAppServe(existing: string | null): string {
  const commands: Array<string | JsonRecord> = []
  if (existing !== null) {
    const parsed: JsonValue = JSON.parse(existing)
    if (isJsonRecord(parsed) && Array.isArray(parsed.commands)) {
      for (const entry of parsed.commands) {
        if (typeof entry === "string") {
          commands.push(entry)
        } else if (isJsonRecord(entry) && typeof entry.command === "string") {
          commands.push(entry)
        }
      }
    }
  }
  for (const name of REQUIRED_ALLOWLIST_BASENAMES) {
    if (!commands.some(c => typeof c === "string" && c === name)) {
      commands.push(name)
    }
  }
  return `${JSON.stringify({ version: 1, commands }, null, 2)}\n`
}

// ── github workspace sync (A2) ─────────────────────────────────────────────

/** The app's declared `storage: github` `pull-push` workspace, validated —
 *  read from the app's in-box WORKSPACE.md and shaped for `SyncTree` /
 *  `WorkspaceSync` reuse (never re-implemented git). */
export interface AppGithubWorkspaceSync {
  /** Absolute path INSIDE the box of the workspace clone (mount_path). */
  dir: string
  config: GithubStorageConfig
  /** Env var names that may hold the GitHub token, in priority order. */
  tokenEnv: readonly string[]
}

/** The serve-time github workspace outcome, returned to the spawn path so
 *  the close hook can re-attach. Non-secret: named env vars, no values. */
export interface AppGithubWorkspaceAtServe {
  sync: AppGithubWorkspaceSync
  ok: boolean
  reason?: string
}

/** Token lookup for the sync — mirrors `app-workspace`'s default: the first
 *  set env var among the declared names, against an EXPLICIT env map.
 *  Standalone/test helper: the spawn path resolves through the daemon's
 *  secrets broker ({@link resolveGithubWorkspaceTokenFromBroker}), never
 *  ambient `process.env`. */
export function resolveGithubWorkspaceToken(
  envNames: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of envNames) {
    const v = env[name]
    if (v) return v
  }
  return undefined
}

/** Resolve a declared github-workspace token through the daemon's secrets
 *  broker (`mcp-credential-deps`), matching the spawn path's posture — the
 *  ambient `process.env` is never read here. Returns the first declared env
 *  name the broker can resolve, or `undefined`. Never throws. */
export async function resolveGithubWorkspaceTokenFromBroker(
  envNames: readonly string[],
): Promise<string | undefined> {
  const { resolveSandboxSecret } = getMcpCredentialDeps()
  if (!resolveSandboxSecret) return undefined
  for (const name of envNames) {
    try {
      const v = await resolveSandboxSecret(name)
      if (v) return v
    } catch {
      // Unresolvable name → try the next declared one; a genuinely missing
      // token surfaces as the caller's "no GitHub token" warning.
    }
  }
  return undefined
}

/** A declared-token resolver. Async so the broker-backed default fits; a
 *  sync resolver is assignable too. */
export type GithubWorkspaceTokenResolver = (
  envNames: readonly string[],
) => string | undefined | Promise<string | undefined>

/** Shell-quote one argument for an in-box `SandboxExec` command string. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** An `AsyncGitRunner` over one in-box exec round-trip per git call. The
 *  token rides `opts.env` (→ `SandboxExecOpts.env`, the provider SDK's
 *  per-command merge) — never the command line; transport/timeout failures
 *  collapse to a failed `GitResult` so the sync's own surfaces them. */
export function boxGitRunner(exec: SandboxExec, timeoutMs = 120_000): AsyncGitRunner {
  return async (args, opts) => {
    const command = `git ${args.map(shQuote).join(" ")}`
    try {
      const res = await exec({
        command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        timeoutMs,
      })
      return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, status: res.exitCode }
    } catch (err) {
      return {
        ok: false,
        stdout: "",
        stderr: `box exec failed: ${err instanceof Error ? err.message : String(err)}`,
        status: null,
      }
    }
  }
}

/** A `SyncTree` over the box's filesystem through the same exec seam. Only
 *  `walk` is meaningful to the sync (`pull`/`push` use it to detect an
 *  empty/populated tree and count files); the read methods exist so the
 *  tree satisfies the surface. `.git` collapses to a `.git/HEAD` entry —
 *  what the github sync's populated check looks for. */
export function boxSyncTree(exec: SandboxExec, dir: string): SyncTree {
  return {
    async exists(path) {
      const res = await exec({ command: `test -e ${shQuote(`${dir}/${path}`)}` })
      return res.exitCode === 0
    },
    async readFile(path) {
      const res = await exec({ command: `cat ${shQuote(`${dir}/${path}`)}` })
      if (res.exitCode !== 0) throw new Error(`cannot read "${path}" in the box: ${res.stderr.trim()}`)
      return res.stdout
    },
    async writeFile() {
      throw new Error("boxSyncTree does not write files — git does the writing")
    },
    async walk() {
      const res = await exec({
        command: `cd ${shQuote(dir)} && find . -mindepth 1 | grep -v '^\\./\\.git/' | head -1000`,
      })
      if (res.exitCode !== 0) return []
      return res.stdout
        .split("\n")
        .filter(Boolean)
        .map((entry: string) => entry.replace(/^\.\//, ""))
        .map((entry: string) => (entry === ".git" ? ".git/HEAD" : entry))
    },
  }
}

/** Read the app's WORKSPACE.md from the box and resolve its github sync
 *  declaration. `undefined` (no declaration / unparsable / unreadable /
 *  `dir` unusable) means no sync — the serve keeps going, exactly like a
 *  non-github app. */
export async function readAppGithubWorkspaceSync(
  exec: SandboxExec,
  dir: string,
): Promise<AppGithubWorkspaceSync | undefined> {
  if (dir.includes("'")) return undefined
  const res = await exec({
    command: `cat ${shQuote(`${dir.endsWith("/") ? dir.slice(0, -1) : dir}/WORKSPACE.md`)}`,
  }).catch(() => undefined)
  if (res === undefined || res.exitCode !== 0) return undefined
  const decl = declaredGithubWorkspace(workspaceFromMarkdownText(res.stdout))
  if (!decl || decl.dir.includes("'")) return undefined
  return { dir: decl.dir, config: decl.config, tokenEnv: decl.tokenEnv }
}

export interface AppGithubWorkspacePullOpts {
  /** Token lookup over the declared env names. Defaults to the daemon's
   *  secrets broker ({@link resolveGithubWorkspaceTokenFromBroker}) — never
   *  ambient `process.env`. */
  resolveToken?: GithubWorkspaceTokenResolver
  /** Overrides the clone/fetch URL (local origin in tests). Never read
   *  from the manifest: the token must only ever reach the validated
   *  github.com `repoUrl`. */
  cloneUrl?: string
}

export type AppGithubWorkspacePullResult =
  | { ok: true; dir: string; message: string }
  | { ok: false; reason: string }

/**
 * Pull the app's github workspace inside the box through
 * `createGithubWorkspaceSync`'s pull contract: an empty/missing mount dir is
 * cloned, an existing checkout is fetched + merged (`--ff-only` — a diverged
 * local branch fails the pull rather than being clobbered). Git runs IN the
 * box — the sync is driven by {@link boxGitRunner} over the per-command exec
 * seam, never the host's `spawnSync` against an in-box path — with
 * `persistAuth: false` so the token never lands on the box's command line
 * nor in `.git/config`. Never throws: a failed pull is reported and the
 * serve continues.
 */
export async function pullAppGithubWorkspace(
  exec: SandboxExec,
  sync: AppGithubWorkspaceSync,
  opts: AppGithubWorkspacePullOpts = {},
): Promise<AppGithubWorkspacePullResult> {
  const token = await (opts.resolveToken ?? resolveGithubWorkspaceTokenFromBroker)(sync.tokenEnv)
  if (!token) {
    return { ok: false, reason: `no GitHub token (set one of ${sync.tokenEnv.join(", ")})` }
  }
  const config: GithubStorageConfig = {
    ...sync.config,
    ...(opts.cloneUrl !== undefined ? { cloneUrl: opts.cloneUrl } : {}),
  }
  // `boxGitRunner` is the WHOLE point: the sync's git calls must round-trip
  // through the box, not run host-side against a path that only exists in it.
  const syncer = createGithubWorkspaceSync(
    config,
    { workspaceDir: sync.dir, token },
    { gitRunner: boxGitRunner(exec), persistAuth: false },
  )
  try {
    await exec({ command: `mkdir -p ${shQuote(sync.dir)}` })
    const res = await syncer.pull(boxSyncTree(exec, sync.dir))
    // Real discriminant: `ok === false` is a failed clone or fetch/merge,
    // whatever `seeded`; a healthy refresh of an existing checkout is
    // `seeded: false, ok: true`.
    if (res.ok === false) return { ok: false, reason: res.message }
    return { ok: true, dir: sync.dir, message: res.message }
  } catch (err) {
    return {
      ok: false,
      reason: `github workspace pull failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * The opt-in push hook for session close. Returns `undefined` unless the
 * declaration explicitly opts in: a `sync.push` with BOTH a non-`main`
 * `branch_policy` and a non-`none` `pr_policy` — a declaration that stays
 * silent (or asks for `main`) never pushes, and the base branch is never
 * pushed directly (branch + PR only, per the plan). The hook itself swallows
 * everything: a push that can't run (no token, box gone) is warned about in
 * the serve log, never blocks the teardown it precedes.
 */
export function createGithubWorkspacePushAtClose(input: {
  sync: AppGithubWorkspaceSync
  exec?: SandboxExec
  /** Conversation id for a `per-conversation` branch policy — the spawning
   *  session's id when known; `agentproto/<now>` when not. */
  sessionId?: string
  /** Token lookup; defaults to the daemon's secrets broker — never ambient
   *  `process.env`. */
  resolveToken?: GithubWorkspaceTokenResolver
  cloneUrl?: string
}): (() => Promise<void>) | undefined {
  const { sync } = input
  const { branchPolicy, prPolicy } = sync.config
  // No exec seam → nothing can push, so don't return a hook that always
  // silently no-ops: `undefined` reads as "not opted in".
  if (!input.exec) return undefined
  const optsOut =
    branchPolicy === undefined ||
    prPolicy === undefined ||
    branchPolicy === "main" ||
    prPolicy === "none"
  if (optsOut) return undefined
  return async () => {
    const exec = input.exec
    if (!exec) return
    try {
      const token = await (input.resolveToken ?? resolveGithubWorkspaceTokenFromBroker)(sync.tokenEnv)
      if (!token) {
        console.warn(
          `[app-serve] github workspace push skipped: no GitHub token ` +
            `(set one of ${sync.tokenEnv.join(", ")})`,
        )
        return
      }
      const syncer = createGithubWorkspaceSync(
        {
          ...sync.config,
          ...(input.cloneUrl !== undefined ? { cloneUrl: input.cloneUrl } : {}),
        },
        {
          workspaceDir: sync.dir,
          token,
          ...(input.sessionId !== undefined ? { conversationId: input.sessionId } : {}),
        },
        // Runs IN the box (per-command exec seam) and never writes the token
        // to `.git/config` — every git call injects it via env only.
        { gitRunner: boxGitRunner(exec), persistAuth: false },
      )
      const res = await syncer.push(boxSyncTree(exec, sync.dir), {
        summary: `agentproto app-workspace sync (session ${input.sessionId ?? "close"})`,
      })
      if (res.kind !== "pushed" && res.kind !== "no_changes") {
        console.warn(`[app-serve] github workspace push failed: ${res.message}`)
      }
    } catch (err) {
      console.warn(
        `[app-serve] github workspace push failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/** Compose the proxy's single `onBeforeTeardown` slot from up to two
 *  hooks: the delivery hook first (deadline-budgeted, box-critical), then
 *  the github workspace push. Each swallows its own failures; `undefined`
 *  slices drop out. */
export function composeTeardownHooks(
  ...hooks: Array<(() => Promise<void>) | undefined>
): (() => Promise<void>) | undefined {
  const present = hooks.filter(x => x !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]!
  return async () => {
    for (const hook of present) await hook()
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

/** The slice of a booted sandbox host the serve bootstrap needs — the shape
 *  `SandboxAgentSessionHost` already satisfies. */
export interface SandboxServeHost {
  mcpUrl: string
  ports?: Record<number, string>
  expose?(port: number): Promise<{ url: string }>
  /** Per-command execution inside the box — `BootedSandbox.exec`. Present
   *  when the provider can shell into the box. The github workspace sync
   *  rides this seam: git never runs host-side against an in-box path, and
   *  the token reaches each command through `SandboxExecOpts.env` (the
   *  provider SDK's per-command env merge — never the command line). */
  exec?: SandboxExec
}

export type StartSandboxAppServeResult =
  | {
      ok: true
      appServe: SessionAppServeInfo
      /** The app's declared github workspace pull outcome — present only
       *  when the app declares a `storage: github` `pull-push` workspace. */
      githubWorkspace?: AppGithubWorkspaceAtServe
    }
  | { ok: false; message: string }

/** Readiness probe: fetch the served URL and report whether it answered OK.
 *  Injectable for tests; the default is a plain fetch with a per-attempt
 *  timeout. */
export type ServeReadinessProbe = (url: string) => Promise<boolean>

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

/** Poll the probe until it answers true or the window elapses. */
export async function pollServeReady(
  url: string,
  opts?: { probe?: ServeReadinessProbe; timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const probe = opts?.probe ?? defaultProbe
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const intervalMs = opts?.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe(url)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

async function seedAllowlist(client: BoxToolClient): Promise<void> {
  let existing: string | null = null
  try {
    const read = await client.callTool("file_read", { path: BOX_ALLOWLIST_REL })
    const text = firstText(read)
    if (text !== undefined) existing = text
  } catch {
    // Absent / unreadable → start from the minimal allowlist below.
  }
  const merged = mergeAllowlistForAppServe(existing)
  if (existing !== null && merged === existing) return
  await client.callTool("file_write", { path: BOX_ALLOWLIST_REL, content: merged })
}

/** Install the app on the box and return its registered appId. */
async function installApp(client: BoxToolClient, dir: string): Promise<string> {
  const res = await client.callTool("app_install", { dir })
  const record = parseToolJson(res)
  const appId = record?.appId
  if (typeof appId !== "string" || appId.length === 0) {
    throw new Error(
      `box app_install returned no appId for dir "${dir}" — ` +
        `${JSON.stringify(firstText(res) ?? "")}`,
    )
  }
  return appId
}

/** The log `app serve` appends to inside the box (mirrors the path the
 *  launcher script redirects to: `<dir>/.agentproto/app-serve.log`). */
export function serveLogPath(dir: string): string {
  return `${dir.replace(/\/+$/, "")}/.agentproto/app-serve.log`
}

/** Read the in-box serve log and pull out the `agentproto app serve:` error
 *  line(s), if any. Returns undefined when the log is absent/unreadable or
 *  holds no error line — never throws. */
export function extractServeError(logText: string): string | undefined {
  const lines = logText
    .split("\n")
    .map(l => l.trimEnd())
    .filter(l => l.includes("agentproto app serve:") && !l.includes("serving "))
  if (lines.length === 0) return undefined
  return lines[lines.length - 1]
}

async function readServeError(client: BoxToolClient, dir: string): Promise<string | undefined> {
  try {
    const res = await client.callTool("file_read", { path: serveLogPath(dir) })
    const text = firstText(res)
    if (text === undefined) return undefined
    return extractServeError(text)
  } catch {
    return undefined
  }
}

/** Launch `agentproto app serve` detached inside the box via the box
 *  daemon's `command_execute` (sh -c + nohup backgrounding — see module
 *  docs). Throws when the launcher itself fails (non-zero sh exit). */
async function launchServeProcess(
  client: BoxToolClient,
  dir: string,
  port: number,
): Promise<string> {
  const script = buildServeLaunchScript(dir, port)
  const res = await client.callTool("command_execute", {
    command: "sh",
    args: ["-c", script],
    cwd: dir,
    timeoutMs: 30_000,
  })
  const result = parseToolJson(res)
  const exitCode = typeof result?.exitCode === "number" ? result.exitCode : -1
  if (exitCode !== 0) {
    const stderr = typeof result?.stderr === "string" ? result.stderr : ""
    throw new Error(
      `box command_execute failed to launch the app server (exit ${exitCode})` +
        `${stderr ? `: ${stderr.trim()}` : ""}`,
    )
  }
  return typeof result?.stdout === "string" ? result.stdout.trim() : ""
}

/**
 * Run the whole in-box bootstrap against a booted sandbox host: resolve the
 * public URL, connect to the box daemon, install the app, seed the
 * allowlist, launch the detached server, and probe readiness. Every failure
 * returns `{ ok: false, message }` — never throws — so the spawn path can
 * surface a clean `sandbox_app_serve_failed` code.
 */
export async function startSandboxAppServe(
  host: SandboxServeHost,
  req: SandboxAppServeSpec,
  opts?: {
    probe?: ServeReadinessProbe
    /** Readiness window forwarded to `pollServeReady`. Default 15s. */
    timeoutMs?: number
    intervalMs?: number
    /** Client factory — injectable for tests; defaults to a real MCP
     *  connection against `host.mcpUrl`. */
    connect?: (mcpUrl: string) => Promise<BoxToolClient>
    /** Github workspace sync injection. The spawn path supplies the
     *  daemon's broker-backed resolver; the default is the same broker
     *  ({@link resolveGithubWorkspaceTokenFromBroker}) — ambient
     *  `process.env` is never the source. */
    github?: {
      resolveToken?: GithubWorkspaceTokenResolver
      cloneUrl?: string
    }
  },
): Promise<StartSandboxAppServeResult> {
  const port = req.port ?? DEFAULT_APP_SERVE_PORT
  let url: string | undefined = host.ports?.[port]
  if (url === undefined) {
    if (!host.expose) {
      return {
        ok: false,
        message:
          `sandbox app serve: port ${port} has no public URL — the sandbox ` +
          "provider resolved no extraPorts entry and has no expose() to expose it lazily.",
      }
    }
    try {
      url = (await host.expose(port)).url
    } catch (err) {
      return {
        ok: false,
        message:
          `sandbox app serve: exposing port ${port} failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  let client: BoxToolClient
  try {
    client = await (opts?.connect ?? connectBoxToolClient)(host.mcpUrl)
  } catch (err) {
    return {
      ok: false,
      message:
        `sandbox app serve: could not connect to the box daemon at ${host.mcpUrl} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    const appId = await installApp(client, req.dir)
    // A2 — the app's github workspace: ensure it is present and up to date
    // AFTER app_install and BEFORE the UI server launches. Best-effort: an
    // invalid or unparsable declaration, a missing token, or a failed pull
    // only warns — never breaks the serve. (The exec seam is absent for a
    // provider that cannot shell into the box: the sync is skipped.)
    let githubWorkspace: AppGithubWorkspaceAtServe | undefined
    if (host.exec) {
      try {
        const sync = await readAppGithubWorkspaceSync(host.exec, req.dir)
        if (sync) {
          const pulled = await pullAppGithubWorkspace(host.exec, sync, {
            ...(opts?.github ? { resolveToken: opts.github.resolveToken } : {}),
            ...(opts?.github?.cloneUrl !== undefined ? { cloneUrl: opts.github.cloneUrl } : {}),
          })
          githubWorkspace = {
            sync,
            ok: pulled.ok,
            ...(pulled.ok ? {} : { reason: pulled.reason }),
          }
          if (!pulled.ok) {
            console.warn(`[app-serve] github workspace not synced: ${pulled.reason}`)
          }
        }
      } catch (err) {
        console.warn(
          `[app-serve] github workspace not synced: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await seedAllowlist(client)
    await launchServeProcess(client, req.dir, port)
    const ready = await pollServeReady(url, {
      ...(opts?.probe ? { probe: opts.probe } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    })
    let message: string | undefined
    if (!ready) {
      // The launcher backgrounds `app serve`, so a server that dies
      // immediately (e.g. the resolved UI root is missing) surfaces nowhere
      // on its own — pull the error out of the serve log and carry it on
      // the result so the caller sees WHY the URL is dead, not just a
      // bare ready:false.
      message = await readServeError(client, req.dir)
    }
    return {
      ok: true,
      appServe: { appId, dir: req.dir, port, url, ready, ...(message !== undefined ? { message } : {}) },
      ...(githubWorkspace ? { githubWorkspace } : {}),
    }
  } catch (err) {
    return {
      ok: false,
      message:
        `sandbox app serve: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}
