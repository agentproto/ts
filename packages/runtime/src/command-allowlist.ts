/**
 * Pure, dependency-light workspace command-allowlist logic, shared by the
 * daemon's `command_execute` MCP tool (`command-tools.ts`) and any other
 * host that needs to gate shell execution against the same
 * `<workspace>/.agentproto/allowed-commands.json` file — e.g. the
 * `mastra-agent` adapter's own `command_execute` workspace tool, which runs
 * out-of-process from the daemon and has no other way to reach this logic.
 *
 * Kept free of daemon-only concerns (session recording, PR provenance,
 * OS-level sandboxing) so it stays cheap to import from a spawned child
 * process — no `SessionsRegistry`, no `@agentproto/command-sandbox`.
 *
 * Allowlist file shape — each entry in `commands` is either a plain
 * basename string (unconstrained args) or an object constraining the argv
 * prefix:
 *   {
 *     "version": 1,
 *     "commands": [
 *       "claude",
 *       "node",
 *       { "command": "git", "args": ["status"] }
 *     ]
 *   }
 *
 * Match is by command BASENAME. A plain string entry allows that basename
 * with ANY args. An object entry with `args` only allows invocations whose
 * argv starts with exactly that token sequence (a prefix match). When a
 * basename has BOTH a plain entry and constrained entries, the plain entry
 * wins.
 */

import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

export const ALLOWLIST_REL = ".agentproto/allowed-commands.json"

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
      `[command-allowlist] failed to load ${ALLOWLIST_REL} (will deny all):`,
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
