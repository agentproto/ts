/**
 * Shell-execution MCP tools for the runtime.
 *
 * The runtime is a remote shell as far as cloud agents are concerned —
 * the workspace lives on the user's machine, so the only place a
 * `claude -p`, `gh pr view`, `pnpm test` etc. can actually run *is*
 * the user's machine. This module exposes one MCP tool,
 * `command_execute`, that any MCP client (cloud Guilde Blake,
 * Claude Code as a sub-agent, …) can call to spawn a subprocess.
 *
 * ## Allowlist
 *
 * Default-deny. The runtime reads
 * `<workspace>/.agentproto/allowed-commands.json` on every call (cheap
 * stat; cached for 1s) for the list of allowed commands. Missing / empty
 * file ⇒ no commands run. The error message points the user at the file
 * path so they know exactly where to opt in.
 *
 * Allowlist file shape — each entry in `commands` is either a plain
 * basename string (unconstrained args, today's behavior) or an object
 * constraining the argv prefix:
 *   {
 *     "version": 1,
 *     "commands": [
 *       "claude",
 *       "node",
 *       { "command": "git", "args": ["status"] },
 *       { "command": "git", "args": ["log"] }
 *     ]
 *   }
 *
 * Match is by command BASENAME (`/usr/local/bin/claude` → `claude`) to
 * keep the allowlist short and not break when users have multiple
 * binaries on their PATH. A plain string entry allows that basename with
 * ANY args — same as before. An object entry with `args` only allows
 * invocations whose argv starts with exactly that token sequence (a
 * prefix match, so `{ "command": "git", "args": ["status"] }` also
 * allows `git status --short`), letting an operator express "allow `git
 * status`, block `git push`" without allowing the whole binary. When a
 * basename has BOTH a plain entry and constrained entries, the plain
 * entry wins (any args allowed) — constraints only bite when every entry
 * for that basename is constrained.
 *
 * ## Safety notes
 *
 * - We use `spawn()` with `shell: false` so arguments are passed
 *   verbatim — no shell interpolation surprises.
 * - `cwd` is anchored to the workspace root via the same path-escape
 *   guard used by `fs-tools.ts`. Callers can't run a subprocess in
 *   `/etc` unless they also bind-mounted it inside the workspace.
 * - Every spawn has a `timeoutMs` cap (default 60s, max 600s). Hung
 *   subprocesses can't pin the runtime forever.
 *
 * ## Interpreter caveat (allowlist footgun)
 *
 * The allowlist is by BASENAME and the cwd anchor only bounds the
 * subprocess's *working directory* — not what it may open. So allowlisting
 * an interpreter (`bash`, `node`, `python3`, …) effectively grants arbitrary
 * host code execution and unrestricted filesystem read: `python3 -c 'open(
 * "~/.ssh/id_rsa")'` runs despite the workspace anchor. Prefer allowlisting
 * specific tools (`gh`, `pnpm test`-style flows via a wrapper) over raw
 * interpreters. When one IS allowlisted, `command_execute` surfaces a
 * one-time warning (log + a `warning` field on the result). OS-level
 * confinement (Seatbelt/Linux bubblewrap) is the real fix and is built —
 * see `command-sandbox.ts` — opt in per workspace via
 * `.agentproto/command-sandbox.json` (`{"mode":"workspace"}`) or
 * `AGENTPROTO_COMMAND_SANDBOX_MODE=workspace`. It defaults to `off` (real,
 * currently-relied-on `gh`/`pnpm` flows through this tool break under
 * `workspace` mode's home-dir denial — see command-sandbox.ts for the
 * empirical evidence), so every call runs unconfined by default and now
 * warns loudly about it every time; opting in makes a missing backend on
 * the host FAIL the call closed rather than run it unconfined.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import { stampPrProvenance } from "./pr-provenance-stamp.js"
import type { ToolCallRecord } from "./tool-call-record.js"
import {
  COMMAND_SANDBOX_MODE_ENV,
  loadSandboxConfig,
  resolveCommandSandbox,
} from "@agentproto/command-sandbox"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const ALLOWLIST_REL = ".agentproto/allowed-commands.json"

/**
 * Command basenames that execute arbitrary code and read the filesystem
 * unrestricted. Allowlisting one grants a caller full host code execution +
 * FS read — the workspace cwd-anchor bounds only the working directory, not
 * what the interpreter itself opens. Used to surface a one-time warning
 * (see `isInterpreterBasename` / `interpreterExecWarning`) until an OS-level
 * command sandbox lands.
 */
export const INTERPRETER_BASENAMES: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish",
  "node", "deno", "bun", "tsx", "ts-node",
  "python", "python2", "python3", "ruby", "perl", "php", "rscript", "osascript",
  "env", "xargs", "make", "npx", "uv", "uvx", "pipx",
])

/** True when `name` (a command basename) is a code interpreter. Case-insensitive
 *  so `Rscript`/`RSCRIPT` match. */
export function isInterpreterBasename(name: string): boolean {
  return INTERPRETER_BASENAMES.has(name.toLowerCase())
}

/** Human-readable warning for allowlisting/running an interpreter. */
export function interpreterExecWarning(baseName: string): string {
  return (
    `command_execute ran the interpreter '${baseName}', which executes ` +
    `arbitrary code and can read files outside the workspace — the cwd anchor ` +
    `does not confine it. Allowlisting interpreters grants full host code ` +
    `execution; prefer allowlisting specific tools. An OS-level command ` +
    `sandbox is planned as the real confinement.`
  )
}

/** Dedup set so the interpreter warning is logged at most once per basename
 *  per daemon process — high signal, no per-call spam. */
const warnedInterpreters = new Set<string>()

export interface RegisterCommandToolsOptions {
  workspace: string
  /** Registry used to mint a `kind:"command"` session for every
   *  `command_execute` call (see `SessionsRegistry.recordCommand`) so
   *  invocations show up in `command_list`/`session_list` and their full
   *  result is durably persisted, not just returned to the caller. */
  registry: SessionsRegistry
  /** Slug recorded on the minted command session's descriptor. Defaults
   *  to "default", matching the fallback cron-scheduler.ts already uses
   *  for its own agent-action spawns. */
  workspaceSlug?: string
  /** Session id of the MCP caller that invoked this specific `/mcp`
   *  registration, when known — recorded on every `command_execute` call's
   *  minted command session as `callerSessionId` (PR 7 / Gap 7 provenance).
   *  `registerCommandTools` still mounts once per `/mcp` POST (not a
   *  persistent per-caller server), so this is per-REQUEST: the daemon
   *  resolves it from that request's `?callerSessionId=` query param (see
   *  `index.ts`'s `mcpServerFactory` / `http-server.ts`'s `handleMcp`) —
   *  present only when the caller is an agent session spawned with the
   *  daemon's own self-ref `mcpServers` entry (`session-spawn.ts`). Absent
   *  for the plain daemon-wide `/mcp` mount with no such query param —
   *  fabricating one there would be worse than leaving it absent. */
  callerSessionId?: string
}

/** One normalized allowlist entry — a basename with an optional argv-prefix
 *  constraint. `args` absent ⇒ unconstrained (any args), matching a plain
 *  basename-string entry in the JSON file. */
export interface AllowlistEntry {
  command: string
  args?: string[]
}

interface AllowlistFile {
  version?: number
  commands?: Array<string | { command?: unknown; args?: unknown }>
}

interface AllowlistCacheEntry {
  mtimeMs: number
  entries: AllowlistEntry[]
}

let allowlistCache: { path: string; entry: AllowlistCacheEntry } | null = null

function normalizeAllowlistEntry(
  raw: string | { command?: unknown; args?: unknown },
): AllowlistEntry | undefined {
  if (typeof raw === "string") {
    const command = raw.trim()
    return command.length > 0 ? { command } : undefined
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    return undefined
  }
  const command = raw.command.trim()
  if (raw.args === undefined) return { command }
  if (!Array.isArray(raw.args) || !raw.args.every(a => typeof a === "string")) {
    // Malformed `args` (not a string array) — drop the constraint rather
    // than silently allowlisting an unintended shape; the operator gets a
    // basename-only entry, which is at least not MORE permissive than
    // the array they wrote.
    return undefined
  }
  return { command, args: [...raw.args] }
}

/** Load the workspace's allowlist as normalized entries (basename +
 *  optional argv-prefix constraint). Cheap stat-cached, same as
 *  `loadAllowlist`; both share one cache keyed on the file's mtime. */
export async function loadAllowlistEntries(
  workspace: string,
): Promise<AllowlistEntry[]> {
  const path = resolve(workspace, ALLOWLIST_REL)
  if (!existsSync(path)) {
    allowlistCache = null
    return []
  }
  try {
    const s = await stat(path)
    if (
      allowlistCache &&
      allowlistCache.path === path &&
      allowlistCache.entry.mtimeMs === s.mtimeMs
    ) {
      return allowlistCache.entry.entries
    }
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as AllowlistFile
    const list = Array.isArray(parsed.commands) ? parsed.commands : []
    const entries = list
      .map(normalizeAllowlistEntry)
      .filter((e): e is AllowlistEntry => e !== undefined)
    allowlistCache = { path, entry: { mtimeMs: s.mtimeMs, entries } }
    return entries
  } catch (err) {
    // Bad JSON / unreadable file ⇒ deny all and surface in the error
    // the next caller gets. Don't poison the cache.
    console.error(
      `[runtime] failed to load ${ALLOWLIST_REL} (will deny all):`,
      err,
    )
    allowlistCache = null
    return []
  }
}

/** Basename-only view of the allowlist — every basename that has AT LEAST
 *  ONE entry, constrained or not. Existing callers (cron-scheduler.ts,
 *  task-ledger.ts, supervisor.ts) gate on basename alone, same as before
 *  this change; only `command_execute` itself enforces argv constraints
 *  (see `isCommandAllowed`). */
export async function loadAllowlist(workspace: string): Promise<Set<string>> {
  const entries = await loadAllowlistEntries(workspace)
  return new Set(entries.map(e => e.command))
}

/** True when `pattern` (an allowed argv prefix) matches the start of
 *  `actual` token-for-token. An empty `pattern` matches anything. */
function argsMatchPrefix(pattern: readonly string[], actual: readonly string[]): boolean {
  if (pattern.length > actual.length) return false
  return pattern.every((tok, i) => actual[i] === tok)
}

/** Argv-aware allowlist check used by `command_execute`. A basename with
 *  no matching entry ⇒ denied. A basename with any unconstrained entry
 *  (plain string, or object with no `args`) ⇒ allowed regardless of args.
 *  Otherwise every matching entry is constrained, so `args` must match
 *  one of them as a prefix. */
export function isCommandAllowed(
  entries: readonly AllowlistEntry[],
  baseName: string,
  args: readonly string[],
): boolean {
  const matching = entries.filter(e => e.command === baseName)
  if (matching.length === 0) return false
  if (matching.some(e => e.args === undefined)) return true
  return matching.some(e => argsMatchPrefix(e.args!, args))
}

export function makeCwdAnchor(workspace: string): (input: string | undefined) => string {
  const root = resolve(workspace)
  return (input?: string) => {
    if (!input || input.length === 0) return root
    const candidate = isAbsolute(input)
      ? normalize(input)
      : normalize(join(root, input))
    const rel = relative(root, candidate)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `cwd escapes the workspace: '${input}' (workspace=${root})`,
      )
    }
    return candidate
  }
}

export interface ExecuteResult {
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
  truncated?: boolean
  durationMs: number
}

/**
 * Register `command_execute` on the given MCP server. The tool returns
 * a JSON-encoded `ExecuteResult` as a single text content item — that
 * matches the response shape `@modelcontextprotocol/server-filesystem`
 * uses for `file_read` and friends, so the existing
 * `parseReadFileResponse`-style parsers in workspace-providers can
 * decode it without bespoke logic.
 */
export function registerCommandTools(
  server: McpServer,
  opts: RegisterCommandToolsOptions,
): void {
  const anchorCwd = makeCwdAnchor(opts.workspace)

  server.tool(
    "command_execute",
    "Run a shell command on the host running the runtime. The command basename must be in `<workspace>/.agentproto/allowed-commands.json`; default-deny otherwise. Captures stdout / stderr / exit code and returns them as JSON. Use this to drive local CLIs (Claude Code, gh, pnpm, …) from a remote agent.",
    {
      command: z
        .string()
        .min(1)
        .describe(
          "Executable name or absolute path. Must be allowlisted by basename in the workspace's allowed-commands.json.",
        ),
      args: z
        .array(z.string())
        .optional()
        .describe(
          "Argv array. Passed verbatim — no shell expansion (we spawn with shell:false so quoting doesn't bite).",
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory, workspace-relative or an absolute path inside the workspace. Defaults to the workspace root.",
        ),
      stdin: z
        .string()
        .optional()
        .describe("Optional input piped to the process's stdin."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Hard kill after this many ms. Defaults to ${DEFAULT_TIMEOUT_MS}; capped at ${MAX_TIMEOUT_MS}.`,
        ),
      origin: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Source label for this run — the calling channel/harness " +
            "(codex, cowork, vscode, cron, …). Descriptor-only: groups the " +
            "minted command session under a source node in the tree, same " +
            "semantics as agent_start's `origin`. Defaults to " +
            "\"command_execute\" when omitted, so every command session is " +
            "still labeled.",
        ),
    },
    async ({ command, args, cwd, stdin, timeoutMs, origin }) => {
      const allowlistEntries = await loadAllowlistEntries(opts.workspace)
      const baseName = basename(command)
      if (!isCommandAllowed(allowlistEntries, baseName, args ?? [])) {
        const allowedBasenames =
          [...new Set(allowlistEntries.map(e => e.command))].sort().join(", ") ||
          "(empty)"
        const basenameKnown = allowlistEntries.some(e => e.command === baseName)
        throw new Error(
          basenameKnown
            ? `command '${baseName}' is allowlisted but its argv doesn't match ` +
              `any allowed pattern for it. Check the "args" constraints for ` +
              `'${baseName}' in ${join(opts.workspace, ALLOWLIST_REL)}.`
            : `command '${baseName}' is not in the allowlist. ` +
              `Add it to ${join(opts.workspace, ALLOWLIST_REL)} ` +
              `under "commands": [...]. Currently allowed: ${allowedBasenames}.`,
        )
      }
      // Interpreter footgun: allowlisting bash/node/python/… grants arbitrary
      // host code execution + unrestricted FS read (the cwd anchor bounds the
      // working dir, not what the interpreter opens). Surface a one-time log
      // warning + an additive `warning` on the result so it's visible, without
      // blocking (blocking would break legit interpreter-driven flows).
      const interpreterWarning = isInterpreterBasename(baseName)
        ? interpreterExecWarning(baseName)
        : undefined
      if (interpreterWarning && !warnedInterpreters.has(baseName)) {
        warnedInterpreters.add(baseName)
        console.error(`[command_execute] ⚠ ${interpreterWarning}`)
      }
      const resolvedCwd = anchorCwd(cwd)
      const limit = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      // OS-level confinement — opt-in via `.agentproto/command-sandbox.json`
      // (or forced by `AGENTPROTO_COMMAND_SANDBOX_MODE`). Default mode "off"
      // ⇒ argv unchanged (today's behavior; see command-sandbox.ts for why
      // the default isn't `workspace` — `gh`/`pnpm` empirically break under
      // it). When a non-"off" mode IS configured and a backend exists for
      // this platform, wrap so even an allowlisted interpreter can't read
      // outside the workspace / (strict) reach the network. The original
      // `command`/`args` are still what's recorded and provenance-stamped
      // below; only the SPAWNED argv is wrapped.
      let execCommand = command
      let execArgs = args ?? []
      const sandboxCfg = await loadSandboxConfig(opts.workspace)
      if (sandboxCfg.mode !== "off") {
        const backend = resolveCommandSandbox()
        if (backend) {
          const wrapped = backend.wrap([command, ...(args ?? [])], {
            workspace: opts.workspace,
            extraReadPaths: sandboxCfg.extraReadPaths,
            network: sandboxCfg.network,
          })
          execCommand = wrapped[0] ?? command
          execArgs = wrapped.slice(1)
        } else {
          // FAIL CLOSED: the operator explicitly opted into confinement
          // (mode !== "off" is a security-relevant intent), but this
          // platform has no backend to honor it. Silently degrading to
          // unconfined execution would be worse than no sandbox at all —
          // the operator would believe they're confined and aren't. Refuse
          // the run instead; `mode:"off"` (or the env override) is the
          // explicit way to accept unconfined execution.
          throw new Error(
            `command-sandbox mode="${sandboxCfg.mode}" is configured ` +
              `(${join(opts.workspace, ".agentproto/command-sandbox.json")} or ` +
              `${COMMAND_SANDBOX_MODE_ENV}) but no sandbox backend is available ` +
              `on ${process.platform} (macOS needs sandbox-exec, Linux needs ` +
              `bwrap installed). Refusing to run '${command}' unconfined — set ` +
              `mode:"off" (or ${COMMAND_SANDBOX_MODE_ENV}=off) to explicitly ` +
              `accept unconfined execution, or install the missing backend.`,
          )
        }
      } else {
        // Confinement is OFF — this call runs UNCONFINED: an allowlisted
        // interpreter (see INTERPRETER_BASENAMES) can read/write anything the
        // daemon's host user can. Warned on EVERY call (not deduped) so the
        // gap can't fade into background noise — see command-sandbox.ts for
        // why `off` is still the default and how to opt into `workspace`.
        console.error(
          `[command_execute] ⚠ running '${baseName}' UNCONFINED — no OS-level ` +
            `sandbox is active (command-sandbox mode is "off"). Enable ` +
            `confinement via ${join(opts.workspace, ".agentproto/command-sandbox.json")} ` +
            `({"mode":"workspace"}) or ${COMMAND_SANDBOX_MODE_ENV}=workspace.`,
        )
      }
      const result = await runCommand({
        command: execCommand,
        args: execArgs,
        cwd: resolvedCwd,
        stdin,
        timeoutMs: limit,
      })
      // Mint a kind:"command" session for this completed run — synchronous,
      // so the id is available immediately. The JSONL body write is
      // fire-and-forget internally (recordCommand never delays or fails
      // the caller's actual result).
      const desc = opts.registry.recordCommand({
        workspaceSlug: opts.workspaceSlug ?? "default",
        cwd: resolvedCwd,
        command,
        args: args ?? [],
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.truncated ? { truncated: true } : {}),
        // Never leave a bare call unlabeled — default to the tool's own
        // name when the caller didn't pass one.
        origin: origin ?? "command_execute",
        // Per-request caller identity (PR 7 / Gap 7) — see this option's
        // doc on `RegisterCommandToolsOptions`. Absent unless the caller
        // was an agent session spawned with the daemon's own self-ref
        // `mcpServers` entry, same as before this field existed.
        ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
      })
      // Daemon-lane PR provenance: when this run was a successful `gh pr
      // create` issued by an executor session, stamp the `@agentproto-bot`
      // footer onto the new PR and record it. Strictly best-effort — the
      // stamper swallows every failure into its outcome and never throws, so
      // a missing/un-authed `gh` can't turn this command_execute red.
      const stamp = await stampPrProvenance({
        command,
        args: args ?? [],
        cwd: resolvedCwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        registry: opts.registry,
      })
      if (stamp.stamped) {
        console.error(
          `[command_execute] stamped PR provenance on ${stamp.url} (session ${stamp.sessionId}${stamp.alreadyStamped ? ", already present" : ""})`,
        )
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              sessionId: desc.id,
              ...(interpreterWarning ? { warning: interpreterWarning } : {}),
            }),
          },
        ],
      }
    },
  )

  server.tool(
    "command_log_tail",
    "Read back command_execute (and cron `command` job) results. Every invocation is its own `kind:\"command\"` session — the same rows `command_list`/`session_list({kind:'command'})` return — with its full stdout/stderr/exitCode/durationMs stored at that session's own record. Pass `sessionId` (e.g. from a session descriptor's `priorCommandSessionId`) to fetch one specific invocation, or omit it to list the most recent ones for this workspace.",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Fetch one specific command session's full result by id."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max invocations to return when listing (ignored with `sessionId`). Default 50, max 500."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Restrict the listing to invocations spawned with this cwd (workspace-relative or absolute). Ignored with `sessionId`.",
        ),
    },
    async ({ sessionId, lastN, cwd }) => {
      if (sessionId) {
        const entry = await opts.registry.readCommandLog(sessionId)
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ entry }) }],
        }
      }
      const limit = lastN ?? 50
      const resolvedCwd = cwd !== undefined ? anchorCwd(cwd) : undefined
      let rows = opts.registry.list().filter(d => d.kind === "command")
      if (resolvedCwd !== undefined) {
        rows = rows.filter(d => d.cwd === resolvedCwd)
      }
      // Newest last, matching agent_output's ring-buffer tail convention.
      rows.sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))
      const tail = rows.slice(-limit)
      const entries = await Promise.all(
        tail.map(async d => ({ sessionId: d.id, ...(await opts.registry.readCommandLog(d.id)) })),
      )
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ entries }, null, 2),
          },
        ],
      }
    },
  )

  server.tool(
    "tool_calls_list",
    "Read back normalized ToolCallRecord entries — ONE unified log covering " +
      "both a command_execute proxy call and an agent's own in-process tool " +
      "call (Bash, Read, Edit, ...), joined with the owning session's " +
      "harness/origin/callerSessionId provenance. Pass `sessionId` to fetch " +
      "one session's calls; omit it to list the most recent calls across " +
      "recent command + agent-cli sessions.",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Restrict to one session's tool calls (a command or agent-cli session id)."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max records to return. Default 50, max 500."),
    },
    async ({ sessionId, lastN }) => {
      const limit = lastN ?? 50
      const enrich = (sid: string, records: ToolCallRecord[]) => {
        const desc = opts.registry.get(sid)
        return records.map(r => ({
          ...r,
          ...(desc?.harness ? { harness: desc.harness } : {}),
          ...(desc?.origin ? { origin: desc.origin } : {}),
          ...(desc?.callerSessionId ? { callerSessionId: desc.callerSessionId } : {}),
        }))
      }
      if (sessionId) {
        const records = enrich(sessionId, await opts.registry.readToolCallRecords(sessionId))
        records.sort((a, b) => a.ts.localeCompare(b.ts))
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ records: records.slice(-limit) }, null, 2) },
          ],
        }
      }
      // No sessionId — walk recent command + agent-cli sessions, newest
      // first, reading each's tool-call records until `limit` is met.
      // Bounded: the loop stops issuing reads the instant enough records
      // are collected, so this never scans the whole session history.
      const rows = opts.registry
        .list()
        .filter(d => d.kind === "command" || d.kind === "agent-cli")
        .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
      const collected: ReturnType<typeof enrich> = []
      for (const d of rows) {
        if (collected.length >= limit) break
        collected.push(...enrich(d.id, await opts.registry.readToolCallRecords(d.id)))
      }
      collected.sort((a, b) => a.ts.localeCompare(b.ts))
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ records: collected.slice(-limit) }, null, 2) },
        ],
      }
    },
  )
}

export interface RunCommandInput {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  timeoutMs: number
}

const STREAM_BUFFER_CAP = 1_048_576 // 1 MiB per stream

export async function runCommand(input: RunCommandInput): Promise<ExecuteResult> {
  return new Promise<ExecuteResult>(resolvePromise => {
    const startedAt = Date.now()
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      // Inherit user env so PATH lookups for `claude`, `gh`, etc. work.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false

    function appendCapped(buf: string, chunk: Buffer): string {
      if (buf.length >= STREAM_BUFFER_CAP) {
        truncated = true
        return buf
      }
      const room = STREAM_BUFFER_CAP - buf.length
      const text = chunk.toString("utf8")
      if (text.length > room) {
        truncated = true
        return buf + text.slice(0, room)
      }
      return buf + text
    }
    child.stdout?.on("data", d => {
      stdout = appendCapped(stdout, d)
    })
    child.stderr?.on("data", d => {
      stderr = appendCapped(stderr, d)
    })

    if (input.stdin) {
      child.stdin?.write(input.stdin)
    }
    child.stdin?.end()

    const timer = setTimeout(() => {
      timedOut = true
      // SIGTERM first; the close handler resolves either way. Ignore
      // EPERM if the child is already gone.
      try {
        child.kill("SIGTERM")
      } catch {
        /* noop */
      }
      // Hard kill 2s later if it hasn't exited.
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* noop */
        }
      }, 2_000).unref()
    }, input.timeoutMs)
    timer.unref()

    child.on("error", err => {
      clearTimeout(timer)
      // spawn errors (ENOENT, EACCES) become exitCode -1 with the
      // message in stderr — the JSON shape stays consistent.
      resolvePromise({
        exitCode: -1,
        signal: null,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + (err as Error).message,
        truncated,
        durationMs: Date.now() - startedAt,
      })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolvePromise({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal ?? (timedOut ? "SIGTERM-timeout" : null),
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}
