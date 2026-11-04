/**
 * `claude-socket` wake adapter.
 *
 * An `external` session registered as `cc:<session_id>` is a Claude Code
 * session the daemon did not spawn. Until now the daemon could only park a
 * message in that session's AIP-46 inbox and wait for its next hook poll.
 * Claude Code 2.1.306 (peerProtocol 1) exposes a per-process unix socket that
 * lets the daemon wake such a session directly:
 *
 *   registration  ~/.claude/sessions/<pid>.json
 *   key           ~/.claude/sessions/<pid>.<hash>.key
 *   socket        /tmp/cc-socks/<pid>.sock  (mode 0600)
 *
 * The wire protocol is two newline-delimited JSON frames, one socket write
 * each:
 *
 *   {"type":"auth","token":"<key file contents>"}
 *   {"type":"user","msg_id":"<uuid v4>","uuid":"<uuid v4>","priority":"next","message":{"role":"user","content":"<text>"}}
 *
 * This adapter is OFF by default (`daemon.claudeSocketWake`). It only writes
 * for envelope level 2 and above (next-turn / steer). Level 1 (fyi) and level
 * 0 write nothing. A `bypassPermissions` target, a missing registration, a
 * missing socket or a missing key all fall back to the existing inbox
 * delivery and report why. The key is read at call time and is never logged
 * or persisted.
 */

import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MessageUrgency } from "./session-message.js"

export const CLAUDE_SOCKET_WAKE_DEFAULT_SOCKET_DIR = "/tmp/cc-socks"
const DEFAULT_CONNECT_TIMEOUT_MS = 1_500
const DEFAULT_WRITE_TIMEOUT_MS = 1_500

/** Envelope level per delivery tier. Level 2 and above may wake a socket. */
const URGENCY_LEVEL: Record<MessageUrgency, number> = {
  fyi: 1,
  "next-turn": 2,
  steer: 3,
  interrupt: 4,
}

export function claudeSocketWakeLevel(urgency: MessageUrgency | undefined): number {
  return urgency === undefined ? 0 : (URGENCY_LEVEL[urgency] ?? 0)
}

export function defaultClaudeSessionsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions")
}

export interface ClaudeSocketWakeConfig {
  /** The `daemon.claudeSocketWake` opt-in. Default false. */
  enabled?: boolean
  /** Claude Code's per-session registration directory. Default
   *  `$CLAUDE_CONFIG_DIR/sessions` or `~/.claude/sessions`. */
  claudeSessionsDir?: string
  /** Directory holding `<pid>.sock`. Default `/tmp/cc-socks`. */
  socketDir?: string
  connectTimeoutMs?: number
  writeTimeoutMs?: number
  /** Test seams. */
  uuid?: () => string
}

export interface ClaudeSessionRegistration {
  pid: number
  sessionId: string
  permissionMode?: string
  status?: string
  file: string
}

export type ClaudeSocketWakeReason =
  | "written"
  | "disabled"
  | "urgency"
  | "not-external"
  | "no-registration"
  | "bypass-permissions"
  | "no-socket"
  | "no-key"
  | "socket-error"

export interface ClaudeSocketWakeOutcome {
  written: boolean
  reason: ClaudeSocketWakeReason
  sessionId: string
  pid?: number
  socketPath?: string
  error?: string
}

/** The `<session_id>` part of an external `cc:<session_id>` row id. */
export function claudeSessionIdFromExternalId(sessionId: string): string | undefined {
  if (!sessionId.startsWith("cc:")) return undefined
  const id = sessionId.slice(3)
  return id.length > 0 ? id : undefined
}

function readRegistrations(dir: string): ClaudeSessionRegistration[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const found: ClaudeSessionRegistration[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const file = join(dir, entry)
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      const pid = typeof record.pid === "number" ? record.pid : Number(record.pid)
      if (!Number.isInteger(pid) || pid <= 0) continue
      if (typeof record.sessionId !== "string" || record.sessionId.length === 0) continue
      found.push({
        pid,
        sessionId: record.sessionId,
        ...(typeof record.permissionMode === "string" ? { permissionMode: record.permissionMode } : {}),
        ...(typeof record.status === "string" ? { status: record.status } : {}),
        file,
      })
    } catch {
      /* unreadable / malformed entry: try the next one */
    }
  }
  return found
}

export function findClaudeSessionRegistration(
  sessionId: string,
  claudeSessionsDir: string,
): ClaudeSessionRegistration | undefined {
  return readRegistrations(claudeSessionsDir).find(record => record.sessionId === sessionId)
}

/** `<pid>.<hash>.key` in the registration directory. Never returns contents. */
export function findClaudeKeyFile(claudeSessionsDir: string, pid: number): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(claudeSessionsDir)
  } catch {
    return undefined
  }
  const prefix = `${pid}.`
  const name = entries.find(entry => entry.startsWith(prefix) && entry.endsWith(".key"))
  return name ? join(claudeSessionsDir, name) : undefined
}

export function claudeSocketPath(socketDir: string, pid: number): string {
  return join(socketDir, `${pid}.sock`)
}

export function isBypassPermissions(registration: ClaudeSessionRegistration): boolean {
  return registration.permissionMode === "bypassPermissions" || registration.status === "bypassPermissions"
}

function writeLines(socketPath: string, lines: readonly string[], opts: {
  connectTimeoutMs: number
  writeTimeoutMs: number
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let settled = false
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let writeTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (connectTimer !== undefined) clearTimeout(connectTimer)
      if (writeTimer !== undefined) clearTimeout(writeTimer)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    const done = (): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.end()
      resolve()
    }

    socket.once("error", (error: Error) => fail(error))
    connectTimer = setTimeout(() => fail(new Error("connect timeout")), opts.connectTimeoutMs)
    connectTimer.unref?.()

    socket.once("connect", () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer)
      writeTimer = setTimeout(() => fail(new Error("write timeout")), opts.writeTimeoutMs)
      writeTimer.unref?.()
      // One write per frame, deliberately: the auth frame must be its own
      // socket write so the peer parses it before the user frame. The final
      // write callback fires once every byte has been handed to the kernel;
      // ending then is a clean half-close.
      if (lines.length === 0) {
        done()
        return
      }
      for (let i = 0; i < lines.length; i++) {
        const last = i === lines.length - 1
        socket.write(`${lines[i]}\n`, last ? () => done() : undefined)
      }
    })
  })
}

/**
 * Attempt a socket wake of an external Claude Code session.
 *
 * Returns a typed outcome for every path (including every skip / fallback),
 * so the caller can record why the inbox fallback was taken. Never throws.
 */
export async function wakeClaudeSocket(input: {
  sessionId: string
  text: string
  urgency: MessageUrgency
  config?: ClaudeSocketWakeConfig
}): Promise<ClaudeSocketWakeOutcome> {
  const { sessionId, text, urgency, config } = input
  const reason = (r: ClaudeSocketWakeReason, extra: Partial<ClaudeSocketWakeOutcome> = {}): ClaudeSocketWakeOutcome => ({
    written: false,
    reason: r,
    sessionId,
    ...extra,
  })

  if (!config?.enabled) return reason("disabled")
  const claudeSessionId = claudeSessionIdFromExternalId(sessionId)
  if (!claudeSessionId) return reason("not-external")
  if (claudeSocketWakeLevel(urgency) < 2) return reason("urgency")

  const claudeSessionsDir = config.claudeSessionsDir ?? defaultClaudeSessionsDir()
  const socketDir = config.socketDir ?? CLAUDE_SOCKET_WAKE_DEFAULT_SOCKET_DIR
  const registration = findClaudeSessionRegistration(claudeSessionId, claudeSessionsDir)
  if (!registration) return reason("no-registration")
  if (isBypassPermissions(registration)) return reason("bypass-permissions", { pid: registration.pid })

  const socketPath = claudeSocketPath(socketDir, registration.pid)
  if (!existsSync(socketPath)) return reason("no-socket", { pid: registration.pid, socketPath })

  const keyPath = findClaudeKeyFile(claudeSessionsDir, registration.pid)
  if (!keyPath) return reason("no-key", { pid: registration.pid, socketPath })

  let token: string
  try {
    token = readFileSync(keyPath, "utf8").trim()
  } catch {
    return reason("no-key", { pid: registration.pid, socketPath })
  }
  if (token.length === 0) return reason("no-key", { pid: registration.pid, socketPath })

  const uuid = config.uuid ?? randomUUID
  const auth = JSON.stringify({ type: "auth", token })
  const user = JSON.stringify({
    type: "user",
    msg_id: uuid(),
    uuid: uuid(),
    priority: "next",
    message: { role: "user", content: text },
  })

  try {
    await writeLines(socketPath, [auth, user], {
      connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      writeTimeoutMs: config.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  } catch (error) {
    return reason("socket-error", {
      pid: registration.pid,
      socketPath,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return { written: true, reason: "written", sessionId, pid: registration.pid, socketPath }
}
