/**
 * `agentproto hook install --host claude-desktop [--session <id>]
 * [--settings <path>] [--port <n>] [--dry-run]`
 *
 * Merges what a Claude Desktop (Claude Code) session needs to receive daemon
 * events into its settings file: `env.AGENTPROTO_SESSION_ID` and the hooks:
 * the four `agentproto hook inbox` hooks (UserPromptSubmit, PostToolUse,
 * SessionStart, Stop) and the
 * `agentproto hook pr-stamp` PostToolUse hook (matcher Bash). Idempotent:
 * a second run changes nothing, and keys it does not own are left untouched.
 * It also prints the MCP URL that registers the session with the daemon; the
 * URL is not stored in the settings file (Claude Code keeps MCP servers in
 * its own config), so the printed `claude mcp add` line is the one manual step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { PR_STAMP_HOOK_COMMAND } from "./hook-pr-stamp.js"

export const DESKTOP_HOST = "claude-desktop"
export const DEFAULT_DESKTOP_SESSION_ID = "claude-desktop"
export const INBOX_HOOK_COMMAND = "agentproto hook inbox"
export const INBOX_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "SessionStart", "Stop"] as const
const DEFAULT_PORT = 18790
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

export function desktopMcpUrl(sessionId: string, port: number = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}/mcp?callerSessionId=${encodeURIComponent(sessionId)}&host=${DESKTOP_HOST}`
}

function hasHookCommand(entries: unknown, command: string): boolean {
  if (!Array.isArray(entries)) return false
  return entries.some(
    e => isObject(e) && Array.isArray(e.hooks) && e.hooks.some(h => isObject(h) && h.command === command),
  )
}

/** Pure merge. `sessionId` overrides an existing `AGENTPROTO_SESSION_ID` when
 *  given; otherwise an existing one is kept and the default fills a gap. */
export function mergeDesktopSettings(
  existing: Json,
  sessionId?: string,
): { settings: Json; sessionId: string; changed: boolean } {
  const settings: Json = structuredClone(existing)
  let changed = false

  const env: Json = isObject(settings.env) ? settings.env : {}
  const current = typeof env.AGENTPROTO_SESSION_ID === "string" ? env.AGENTPROTO_SESSION_ID : undefined
  const effective = sessionId ?? current ?? DEFAULT_DESKTOP_SESSION_ID
  if (current !== effective) {
    env.AGENTPROTO_SESSION_ID = effective
    settings.env = env
    changed = true
  }

  const hooks: Json = isObject(settings.hooks) ? settings.hooks : {}
  for (const event of INBOX_HOOK_EVENTS) {
    if (hasHookCommand(hooks[event], INBOX_HOOK_COMMAND)) continue
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    list.push({ hooks: [{ type: "command", command: INBOX_HOOK_COMMAND }] })
    hooks[event] = list
    changed = true
  }
  if (!hasHookCommand(hooks.PostToolUse, PR_STAMP_HOOK_COMMAND)) {
    const list = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as unknown[]) : []
    list.push({ matcher: "Bash", hooks: [{ type: "command", command: PR_STAMP_HOOK_COMMAND }] })
    hooks.PostToolUse = list
    changed = true
  }
  if (changed) settings.hooks = hooks
  return { settings, sessionId: effective, changed }
}

export function defaultDesktopSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
}

export interface HookInstallDeps {
  env?: Record<string, string | undefined>
  out?: (s: string) => void
  err?: (s: string) => void
}

export async function runHookInstall(args: readonly string[], deps: HookInstallDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s))
  const err = deps.err ?? ((s: string) => void process.stderr.write(s))
  let values: { host?: string; session?: string; settings?: string; port?: string; "dry-run"?: boolean }
  try {
    values = parseArgs({
      args: [...args],
      options: {
        host: { type: "string" },
        session: { type: "string" },
        settings: { type: "string" },
        port: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: false,
    }).values
  } catch (e) {
    err(`agentproto hook install: ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  if (values.host !== DESKTOP_HOST) {
    err(`agentproto hook install: --host ${DESKTOP_HOST} is required (the only supported host)\n`)
    return 2
  }
  if (values.session !== undefined && !SESSION_ID_RE.test(values.session)) {
    err("agentproto hook install: --session must match [A-Za-z0-9._:-]{1,128}\n")
    return 2
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err("agentproto hook install: --port must be 1-65535\n")
    return 2
  }

  const path = values.settings ?? defaultDesktopSettingsPath(deps.env ?? process.env)
  let existing: Json = {}
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isObject(parsed)) throw new Error("not a JSON object")
      existing = parsed
    } catch (e) {
      err(`agentproto hook install: cannot parse ${path} (${e instanceof Error ? e.message : String(e)}); left untouched\n`)
      return 1
    }
  }

  const merged = mergeDesktopSettings(existing, values.session)
  const url = desktopMcpUrl(merged.sessionId, port)
  if (values["dry-run"]) {
    out(JSON.stringify(merged.settings, null, 2) + "\n")
    err(`# would ${merged.changed ? "update" : "leave unchanged"} ${path}\n# MCP URL: ${url}\n`)
    return 0
  }
  if (merged.changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(merged.settings, null, 2) + "\n")
  }
  out(
    `${merged.changed ? "Updated" : "Already up to date:"} ${path}\n` +
      `Session id: ${merged.sessionId}\n` +
      `Register the session with the daemon (once):\n` +
      `  claude mcp add --transport http --scope user agentproto-desktop "${url}"\n`,
  )
  return 0
}
