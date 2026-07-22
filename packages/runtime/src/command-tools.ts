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
 * stat; cached for 1s) for the list of allowed command basenames.
 * Missing / empty file ⇒ no commands run. The error message points the
 * user at the file path so they know exactly where to opt in.
 *
 * Allowlist file shape:
 *   { "version": 1, "commands": ["claude", "gh", "pnpm", "node"] }
 *
 * Match is by command BASENAME (`/usr/local/bin/claude` → `claude`)
 * to keep the allowlist short and not break when users have multiple
 * binaries on their PATH.
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
 * confinement (Seatbelt/Landlock) is the real fix — planned as
 * `command-sandbox` (see `.plans/agentproto-daemon-network-hardening`).
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
import { loadSandboxConfig, resolveCommandSandbox } from "./command-sandbox.js"

/** Warn at most once per process when a sandbox mode is configured but no
 *  backend exists for this platform — so we never silently pretend to confine. */
let warnedNoSandboxBackend = false

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
}

interface AllowlistFile {
  version?: number
  commands?: string[]
}

interface AllowlistCacheEntry {
  mtimeMs: number
  commands: Set<string>
}

let allowlistCache: { path: string; entry: AllowlistCacheEntry } | null = null

export async function loadAllowlist(workspace: string): Promise<Set<string>> {
  const path = resolve(workspace, ALLOWLIST_REL)
  if (!existsSync(path)) {
    allowlistCache = null
    return new Set()
  }
  try {
    const s = await stat(path)
    if (
      allowlistCache &&
      allowlistCache.path === path &&
      allowlistCache.entry.mtimeMs === s.mtimeMs
    ) {
      return allowlistCache.entry.commands
    }
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as AllowlistFile
    const list = Array.isArray(parsed.commands) ? parsed.commands : []
    const commands = new Set(
      list
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .map(x => x.trim()),
    )
    allowlistCache = { path, entry: { mtimeMs: s.mtimeMs, commands } }
    return commands
  } catch (err) {
    // Bad JSON / unreadable file ⇒ deny all and surface in the error
    // the next caller gets. Don't poison the cache.
    console.error(
      `[runtime] failed to load ${ALLOWLIST_REL} (will deny all):`,
      err,
    )
    allowlistCache = null
    return new Set()
  }
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
      const allowlist = await loadAllowlist(opts.workspace)
      const baseName = basename(command)
      if (!allowlist.has(baseName)) {
        const allowed = [...allowlist].sort().join(", ") || "(empty)"
        throw new Error(
          `command '${baseName}' is not in the allowlist. ` +
            `Add it to ${join(opts.workspace, ALLOWLIST_REL)} ` +
            `under "commands": [...]. Currently allowed: ${allowed}.`,
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
      // OS-level confinement — opt-in via `.agentproto/command-sandbox.json`.
      // Default mode "off" ⇒ argv unchanged (today's behavior). When enabled
      // and a backend exists for this platform, wrap so even an allowlisted
      // interpreter can't read outside the workspace / (strict) reach the
      // network. The original `command`/`args` are still what's recorded and
      // provenance-stamped below; only the SPAWNED argv is wrapped.
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
        } else if (!warnedNoSandboxBackend) {
          warnedNoSandboxBackend = true
          console.error(
            `[command_execute] ⚠ command-sandbox mode="${sandboxCfg.mode}" is ` +
              `configured but no sandbox backend is available on ` +
              `${process.platform}; commands run UNconfined.`,
          )
        }
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
        // name when the caller didn't pass one. No `callerSessionId` here:
        // `registerCommandTools` mounts once, daemon-wide (not per-caller
        // scoped like session-tools.ts's `callerScope`), so this tool has
        // no way to resolve which session actually invoked it. Fabricating
        // one would be worse than leaving it absent.
        origin: origin ?? "command_execute",
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
