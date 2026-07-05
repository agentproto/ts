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
import { appendCommandLogEntry, tailCommandLog } from "./command-log.js"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const ALLOWLIST_REL = ".agentproto/allowed-commands.json"

export interface RegisterCommandToolsOptions {
  workspace: string
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
    },
    async ({ command, args, cwd, stdin, timeoutMs }) => {
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
      const resolvedCwd = anchorCwd(cwd)
      const limit = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const result = await runCommand({
        command,
        args: args ?? [],
        cwd: resolvedCwd,
        stdin,
        timeoutMs: limit,
      })
      // Fire-and-forget: the audit log must never delay or fail the
      // caller's actual result. appendCommandLogEntry swallows its own
      // errors (console.warn on failure).
      void appendCommandLogEntry(
        opts.workspace,
        { command, args: args ?? [], cwd: resolvedCwd },
        result,
      )
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      }
    },
  )

  server.tool(
    "command_log_tail",
    "Read back recent command_execute (and cron `command` job) invocations logged for this workspace, newest last. Backed by the day-bucketed JSONL audit log at `.agentproto/command-log/<YYYY-MM-DD>.jsonl` — includes the full ExecuteResult (stdout/stderr/exitCode/durationMs) for each call, not just a status line.",
    {
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max entries to return. Default 50, max 500."),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "Only scan day-files at or after this YYYY-MM-DD date. Omit to scan backwards from today until `lastN` is filled.",
        ),
    },
    async ({ lastN, since }) => {
      const entries = await tailCommandLog(opts.workspace, { lastN, since })
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
