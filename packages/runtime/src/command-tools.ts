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

import { spawn, type ChildProcess } from "node:child_process"
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
import { SESSION_ID_ENV, WORKSPACE_SLUG_ENV, mintSessionId, type SessionsRegistry } from "./sessions.js"
import { stampPrProvenance } from "./pr-provenance-stamp.js"
import type { ToolCallRecord } from "./tool-call-record.js"
import {
  COMMAND_SANDBOX_MODE_ENV,
  loadSandboxConfig,
  resolveCommandSandbox,
} from "@agentproto/command-sandbox"
import {
  ALLOWLIST_REL,
  INTERPRETER_BASENAMES,
  interpreterExecWarning,
  isCommandAllowed,
  isInterpreterBasename,
  loadAllowlistEntries,
  type AllowlistEntry,
} from "./command-allowlist.js"

export {
  ALLOWLIST_REL,
  INTERPRETER_BASENAMES,
  interpreterExecWarning,
  isCommandAllowed,
  isInterpreterBasename,
  loadAllowlist,
  loadAllowlistEntries,
  type AllowlistEntry,
} from "./command-allowlist.js"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000

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
  /**
   * `true` iff the run was killed by the `timeoutMs` cap (as opposed to
   * exiting on its own, or dying to some other signal). A machine-readable
   * companion to the human note appended to `stderr` and the legacy
   * `signal:"SIGTERM-timeout"` marker — a caller shouldn't have to string-
   * match a signal to tell a timeout apart from any other SIGTERM.
   */
  timedOut?: boolean
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
    "Run a shell command on the host running the runtime. The command basename must be in `<workspace>/.agentproto/allowed-commands.json`; default-deny otherwise. Captures stdout / stderr / exit code and returns them as JSON. Use this to drive local CLIs (Claude Code, gh, pnpm, …) from a remote agent. This is for SHORT synchronous commands: the subprocess is bound to this RPC and hard-killed at the `timeoutMs` cap, so long-running work (a build, a test gate, a `claude -p` run) belongs in a persistent session that outlives the call — the terminal_start / agent_start MCP tools, or `agentproto sessions start` on the CLI.",
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
      // Minted BEFORE the spawn (not left to `recordCommand`'s own default)
      // so it can be injected as AGENTPROTO_SESSION_ID into the command's
      // own env — the same id `recordCommand` below then stamps onto the
      // session it records, rather than a second, different one.
      const commandSessionId = mintSessionId()
      const commandWorkspaceSlug = opts.workspaceSlug ?? "default"
      const result = await runCommand({
        command: execCommand,
        args: execArgs,
        cwd: resolvedCwd,
        stdin,
        timeoutMs: limit,
        env: {
          [SESSION_ID_ENV]: commandSessionId,
          [WORKSPACE_SLUG_ENV]: commandWorkspaceSlug,
        },
      })
      // Mint a kind:"command" session for this completed run — synchronous,
      // so the id is available immediately. The JSONL body write is
      // fire-and-forget internally (recordCommand never delays or fails
      // the caller's actual result).
      const desc = opts.registry.recordCommand({
        id: commandSessionId,
        workspaceSlug: commandWorkspaceSlug,
        cwd: resolvedCwd,
        command,
        args: args ?? [],
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
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
        // Same per-request identity as `callerSessionId` recorded on the
        // command session above — the authoritative attribution when present,
        // see `StampPrInput.callerSessionId`.
        ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
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
            text: JSON.stringify({ entries }),
          },
        ],
      }
    },
  )

  // --- tool_calls_list shaping helpers (additive, PR-4) -------------------
  // Both helpers are no-ops for the default call (no `fields`, no explicit
  // `full: false`), so default output stays byte-identical to the
  // pre-pagination tool. The `result`-text preview is DISABLED by default
  // and only arms when a caller explicitly passes `full: false`; the
  // default flips in the PR-10 posture change.

  /** Enriched record shape `tool_calls_list` returns (ToolCallRecord joined
   *  with the owning session's descriptor provenance). */
  type EnrichedToolCallRecord = ToolCallRecord & {
    harness?: string
    origin?: string
    callerSessionId?: string
  }

  const RESULT_PREVIEW_CHARS = 500

  const previewResultText = (text: string): string =>
    text.length > RESULT_PREVIEW_CHARS
      ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…`
      : text

  /**
   * Project/preview records for `tool_calls_list` output. With neither
   * param supplied this is the identity map (same key order, same JSON);
   * `fields` keeps only the requested keys per record; `full: false`
   * additionally truncates any long string `result` field (~500 chars).
   */
  const shapeToolCallRecords = (
    records: readonly EnrichedToolCallRecord[],
    fields: readonly string[] | undefined,
    full: boolean | undefined,
  ): Array<Record<string, string | number | boolean | string[] | undefined>> =>
    records.map(record => {
      let entries = Object.entries(record)
      if (fields !== undefined) {
        entries = entries.filter(([key]) => fields.includes(key))
      }
      if (full === false) {
        entries = entries.map(([key, value]) =>
          key === "result" && typeof value === "string"
            ? [key, previewResultText(value)]
            : [key, value],
        )
      }
      return Object.fromEntries(entries)
    })

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
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Explicit field projection — keep only these keys per record. " +
            "Absent: full records (current default).",
        ),
      full: z
        .boolean()
        .optional()
        .describe(
          "Legacy escape hatch. `full: true` is today's behaviour (full " +
            "records, no preview). `full: false` opts into the future " +
            "`result`-preview posture early — long result text truncated " +
            "to ~500 chars. Default (absent): full records.",
        ),
    },
    async ({ sessionId, lastN, fields, full }) => {
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
            {
              type: "text" as const,
              text: JSON.stringify(
                { records: shapeToolCallRecords(records.slice(-limit), fields, full) },
                null,
                2,
              ),
            },
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
          {
            type: "text" as const,
            text: JSON.stringify(
              { records: shapeToolCallRecords(collected.slice(-limit), fields, full) },
              null,
              2,
            ),
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
  /** Extra env for the spawned command — today only the daemon's own
   *  session-identity vars (see {@link SESSION_ID_ENV}), merged on top of
   *  `process.env`/`withSanePath`. Not caller-exposed by `command_execute`'s
   *  tool schema, so there's no forgery surface here yet — merged plainly. */
  env?: Record<string, string>
}

const STREAM_BUFFER_CAP = 1_048_576 // 1 MiB per stream

/**
 * Standard system / package-manager bin dirs a spawned command's PATH should
 * always resolve through. A launchd plist's `EnvironmentVariables.PATH` is
 * captured ONCE, at `agentproto daemon install` time, from whatever shell ran
 * the install (`packages/cli/src/commands/daemon.ts`'s `renderPlist`) — if
 * that shell's own PATH was narrow (a non-interactive install context, a
 * profile that doesn't source Homebrew's `/opt/homebrew/bin`, …), the daemon
 * carries that narrow PATH for its entire lifetime, and every subprocess it
 * spawns (`command_execute`, a cron `kind:"command"` action) inherits it —
 * `spawn git ENOENT` even though `git` is really installed. Appended AFTER
 * whatever's already on `PATH`, so nothing already resolvable changes.
 */
const DEFAULT_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]

/**
 * `env` with `DEFAULT_PATH_DIRS` appended onto `PATH` for every entry not
 * already present — order-preserving, so an existing PATH entry always wins
 * a name collision; this only fills gaps a narrow inherited PATH left open.
 * Returns `env` unchanged (same reference) when there's nothing to add.
 */
export function withSanePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = (env.PATH ?? "").split(":").filter(Boolean)
  const existingSet = new Set(existing)
  const missing = DEFAULT_PATH_DIRS.filter(dir => !existingSet.has(dir))
  if (missing.length === 0) return env
  return { ...env, PATH: [...existing, ...missing].join(":") }
}

/**
 * Signal the child's whole process group, falling back to the direct child.
 *
 * On POSIX we spawn `detached`, so the child leads a new process group whose
 * id equals its pid; `process.kill(-pid, sig)` signals every member — the
 * grandchildren a `bash -c "pnpm test"` fans out (pnpm → turbo → vitest) that
 * a plain `child.kill()` would SIGTERM `bash` and orphan. The negative-pid
 * form throws where there's no group to hit (Windows has no process groups;
 * ESRCH once the group is already reaped), so we fall back to killing just the
 * direct child — same behavior as before this function existed.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      /* fall through: no group (non-POSIX) or already gone */
    }
  }
  try {
    child.kill(signal)
  } catch {
    /* noop — the child is already gone */
  }
}

export async function runCommand(input: RunCommandInput): Promise<ExecuteResult> {
  return new Promise<ExecuteResult>(resolvePromise => {
    const startedAt = Date.now()
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      // Inherit user env so PATH lookups for `claude`, `gh`, etc. work —
      // merged with a sane default PATH (`withSanePath`) so a narrow
      // inherited PATH can't ENOENT common tools like `git`. See
      // `DEFAULT_PATH_DIRS`'s doc for why the inherited PATH alone isn't
      // always enough.
      env: withSanePath({ ...process.env, ...(input.env ?? {}) }),
      stdio: ["pipe", "pipe", "pipe"],
      // Lead a new process group on POSIX so a timeout can reap the whole
      // subtree, not just the direct child — see `killProcessGroup`. Piped
      // stdio keeps the parent attached despite `detached`, and we never
      // `unref()` the child, so its lifetime still bounds this RPC exactly as
      // before. No-op on Windows (no process groups).
      detached: process.platform !== "win32",
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
      // SIGTERM the whole group first (not just the direct child — see
      // `killProcessGroup`); the close handler resolves either way.
      killProcessGroup(child, "SIGTERM")
      // Hard kill the group 2s later if it hasn't exited.
      setTimeout(() => {
        killProcessGroup(child, "SIGKILL")
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
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      // On a timeout, tell the caller — in the human-readable stderr — exactly
      // what killed the run and where long-running work actually belongs. A
      // bare `signal:"SIGTERM-timeout"` (kept for back-compat) is opaque; this
      // names the effective cap and steers them to a persistent session.
      const timeoutNote = timedOut
        ? (stderr ? "\n" : "") +
          `[command_execute] killed after ${input.timeoutMs}ms (timeoutMs ` +
          `cap, max ${MAX_TIMEOUT_MS}). command_execute is for SHORT ` +
          `synchronous commands — for long-running work use a persistent ` +
          `session that outlives the RPC: the terminal_start / agent_start ` +
          "MCP tools, or `agentproto sessions start` on the CLI."
        : ""
      resolvePromise({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal ?? (timedOut ? "SIGTERM-timeout" : null),
        stdout,
        stderr: stderr + timeoutNote,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}
