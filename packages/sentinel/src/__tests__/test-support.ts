/**
 * Test fakes for the sentinel platform ports.
 *
 * This file is both a normal helper module and the package's vitest setup
 * entry: importing it installs an in-memory/fs fake for every port so tests
 * never depend on `@agentproto/runtime` implementations. Production sentinel
 * code has no such defaults; it throws until the runtime configures the
 * platform.
 */

import { createHmac } from "node:crypto"
import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  promises as fsp,
} from "node:fs"
import { dirname } from "node:path"

import {
  configureSentinelPlatform,
  PrLookupError,
  sentinelPlatform,
  type DurableRowFile,
  type DurableRowFileOptions,
  type McpEventEnvelope,
  type WriteFileDurableOptions,
} from "../platform.js"
import type { SessionEvent, SessionEventBus } from "../local-types.js"

// ── Durable fs fakes (same crash-durable tmp -> fsync -> rename contract) ──

let tmpSeq = 0
const tmpPathFor = (filePath: string): string => `${filePath}.tmp.${process.pid}.${++tmpSeq}`

function isDirSyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP"
}

export async function writeFileDurable(filePath: string, data: string, opts: WriteFileDurableOptions = {}): Promise<void> {
  const mode = opts.mode ?? 0o600
  const dir = dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = tmpPathFor(filePath)
  try {
    const fh = await fsp.open(tmp, "w", mode)
    try {
      await fh.writeFile(data)
      await fh.chmod(mode)
      await fh.sync()
    } finally {
      await fh.close()
    }
    if (opts.commitIf && !opts.commitIf()) {
      await fsp.unlink(tmp).catch(() => undefined)
      return
    }
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined)
    throw err
  }
  try {
    const dh = await fsp.open(dir, "r")
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err
  }
}

function writeFileDurableSync(filePath: string, data: string, mode = 0o600): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = tmpPathFor(filePath)
  try {
    const fd = openSync(tmp, "w", mode)
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp may not exist
    }
    throw err
  }
  try {
    const dfd = openSync(dir, "r")
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err
  }
}

function appendLineDurableSync(filePath: string, line: string, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const existed = (() => {
    try {
      closeSync(openSync(filePath, "r"))
      return true
    } catch {
      return false
    }
  })()
  const fd = openSync(filePath, "a", mode)
  try {
    appendFileSync(fd, line.endsWith("\n") ? line : `${line}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (!existed) {
    try {
      const dfd = openSync(dirname(filePath), "r")
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch (err) {
      if (!isDirSyncUnsupported(err)) throw err
    }
  }
}

function oldestTerminalKey<Row>(
  rows: ReadonlyMap<string, Row>,
  isTerminal: (row: Row) => boolean,
  terminalAt: (row: Row) => number,
): string | undefined {
  const oldest = [...rows.entries()]
    .filter(([, row]) => isTerminal(row))
    .sort(([, a], [, b]) => terminalAt(a) - terminalAt(b))
    .at(0)
  return oldest ? oldest[0] : undefined
}

function createDurableRowFile<Row>(opts: DurableRowFileOptions<Row>): DurableRowFile<Row> {
  const { filePath, persist, debounceMs, log, logPrefix } = opts

  const load = (): Map<string, Row> => {
    const out = new Map<string, Row>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`${logPrefix} read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`)
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const value of Object.values(parsed)) {
        const accepted = opts.acceptLoaded(value)
        if (accepted) out.set(accepted[0], accepted[1])
      }
    } catch (err) {
      log(`${logPrefix} corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`)
    }
    return out
  }

  const rows = load()

  const snapshot = (): Record<string, Row> => {
    const out: Record<string, Row> = {}
    for (const [key, row] of rows.entries()) out[key] = row
    return out
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let writeTail: Promise<void> = Promise.resolve()
  let syncGeneration = 0

  const persistNow = (): Promise<void> => {
    if (!persist) return Promise.resolve()
    const run = async (): Promise<void> => {
      const generation = syncGeneration
      const body = JSON.stringify(snapshot(), null, 2) + "\n"
      await writeFileDurable(filePath, body, { commitIf: () => generation === syncGeneration })
    }
    const next = writeTail.then(run, run)
    writeTail = next.catch(() => undefined)
    return next
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow().catch(err => {
        log(`${logPrefix} persist failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    syncGeneration++
    try {
      writeFileDurableSync(filePath, JSON.stringify(snapshot(), null, 2) + "\n")
    } catch {
      // best-effort, never throw in the shutdown path
    }
  }

  const settled = (): Promise<void> => writeTail

  const insertDurable = async (
    key: string,
    row: Row,
    retention: { cap: number; oldestTerminalKey: () => string | undefined },
  ): Promise<void> => {
    let evicted: [string, Row] | undefined
    if (rows.size >= retention.cap) {
      const oldest = retention.oldestTerminalKey()
      const evictedRow = oldest ? rows.get(oldest) : undefined
      if (oldest && evictedRow !== undefined) {
        evicted = [oldest, evictedRow]
        rows.delete(oldest)
      }
    }

    rows.set(key, row)
    try {
      await persistNow()
    } catch (err) {
      if (rows.get(key) === row) rows.delete(key)
      if (evicted && !rows.has(evicted[0])) rows.set(evicted[0], evicted[1])
      throw err
    }
  }

  return { rows, persistNow, schedulePersist, settled, flushSync, insertDurable }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export const callbackHost = (url: string): string => sentinelPlatform().webhookDelivery.callbackHost(url)
export const redactUrls = (text: string): string => sentinelPlatform().webhookDelivery.redactUrls(text)
export const serializeEnvelope = (event: McpEventEnvelope): Uint8Array =>
  sentinelPlatform().webhookDelivery.serializeEnvelope(event)

export function createSessionEventBus(): SessionEventBus {
  const handlers = new Set<(ev: SessionEvent) => void>()
  return {
    emit(ev) {
      for (const handler of handlers) handler(ev)
    },
    onAny(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

export class SessionNotAliveError extends Error {
  readonly sessionId: string
  readonly status: string
  constructor(sessionId: string, status = "exited", caller = "test") {
    super(`${caller}: session "${sessionId}" is not alive (status=${status})`)
    this.name = "SessionNotAliveError"
    this.sessionId = sessionId
    this.status = status
  }
}

export function signWebhook(input: {
  msgId: string
  timestamp: number
  payload: Uint8Array
  secrets: readonly string[]
}): { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string } {
  const prefix = Buffer.from(`${input.msgId}.${input.timestamp}.`, "utf8")
  const payload = Buffer.from(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength)
  const segments = input.secrets.map((secret) => {
    const key = Buffer.from(secret.slice("whsec_".length), "base64")
    const mac = createHmac("sha256", key).update(prefix).update(payload).digest()
    return `v1,${mac.toString("base64")}`
  })
  return {
    "webhook-id": input.msgId,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": segments.join(" "),
  }
}

// ── Fake platform ─────────────────────────────────────────────────────────

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === "string") return value
    if (value && value.length > 0) return value[0]
  }
  return undefined
}

function fakeVerifyInboundSignature(
  provider: "agentpush" | "sentinel",
  input: { rawBody: string; headers: Record<string, string | string[] | undefined>; secret: string; nowMs: number },
): { ok: true } | { ok: false; reason: string } {
  const headerName = provider === "agentpush" ? "x-agentpush-signature" : "x-hub-signature-256"
  const header = headerValue(input.headers, headerName)
  if (!header) return { ok: false, reason: `missing ${headerName}` }
  const prefix = "sha256="
  if (!header.startsWith(prefix)) return { ok: false, reason: `bad ${headerName} format` }
  const hex = header.slice(prefix.length)
  if (!/^[0-9a-fA-F]+$/.test(hex)) return { ok: false, reason: `bad ${headerName} hex` }
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest()
  const provided = Buffer.from(hex, "hex")
  if (provided.length !== expected.length || !provided.equals(expected)) {
    return { ok: false, reason: `bad ${headerName}` }
  }
  return { ok: true }
}

async function ghJson<T>(gh: (args: readonly string[]) => Promise<string>, path: string): Promise<T> {
  const out = await gh(["api", "-H", "Accept: application/vnd.github+json", path])
  return JSON.parse(out) as T
}

interface GhPull {
  number: number
  html_url?: string
  state: "open" | "closed"
  merged_at?: string | null
  head?: { sha?: string; ref?: string }
}

async function fakeFetchPrStatus(
  gh: (args: readonly string[]) => Promise<string>,
  pr: { repo: string; number: number },
  now: () => Date = () => new Date(),
) {
  const pull = await ghJson<GhPull>(gh, `repos/${pr.repo}/pulls/${pr.number}`)
  const rawReviews = await ghJson<Array<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>>(
    gh,
    `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
  )
  let checks: Array<{ name: string; conclusion: string | null }> | undefined
  if (pull.head?.sha) {
    try {
      const runs = await ghJson<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(
        gh,
        `repos/${pr.repo}/commits/${pull.head.sha}/check-runs?per_page=100`,
      )
      checks = (runs.check_runs ?? []).map((c) => ({ name: String(c.name ?? ""), conclusion: c.conclusion ?? null }))
    } catch {
      checks = undefined
    }
  }
  return {
    fetchedAt: now().toISOString(),
    state: (pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed") as "open" | "merged" | "closed",
    reviews: (Array.isArray(rawReviews) ? rawReviews : []).map((r) => ({
      login: r.user?.login ?? "",
      state: r.state ?? "",
      submittedAt: r.submitted_at ?? "",
    })),
    ...(checks ? { checks } : {}),
    ...(pull.head?.sha ? { headSha: pull.head.sha } : {}),
    ...(pull.head?.ref ? { headRefName: pull.head.ref } : {}),
  }
}

const DELIBERATE_END_REASONS: ReadonlySet<string> = new Set([
  "operator-completed",
  "operator-stopped",
  "steward-completed",
  "steward-abandoned",
  "restarted",
])

const MESSAGE_URGENCIES = ["fyi", "next-turn", "steer", "interrupt"] as const

configureSentinelPlatform({
  github: {
    execGh: async () => {
      throw new Error("sentinel test gh runner is not configured")
    },
    prRef: (repo, number) => ({ provider: "github", repo, number, url: `https://github.com/${repo}/pull/${number}` }),
    fetchPrStatus: fakeFetchPrStatus,
    parsePrUrl: (url) => {
      const m = url.trim().match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/)
      return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
    },
    PrLookupError,
  },
  discovery: {
    discover: async () => [],
    probe: async () => null,
  },
  mcpImports: {
    loadImportedMcps: async () => ({ imports: [] }),
  },
  webhookDelivery: {
    deliverEventEnvelope: async () => {
      throw new Error("sentinel test delivery port is not configured")
    },
    serializeEnvelope: (event) => new TextEncoder().encode(JSON.stringify(event)),
    callbackHost: (url) => {
      try {
        return new URL(url).host
      } catch {
        return "invalid-url"
      }
    },
    redactUrls: (text) =>
      text.replace(/https?:\/\/[^\s'"<>)]+/gi, (m) => {
        try {
          const u = new URL(m)
          return `${u.protocol}//${u.host}`
        } catch {
          return "<url>"
        }
      }),
    verifyInboundSignature: fakeVerifyInboundSignature,
  },
  durable: {
    writeFileDurable,
    writeFileDurableSync,
    appendLineDurableSync,
    createDurableRowFile,
    oldestTerminalKey,
  },
  messages: {
    createSessionMessage: (input) => {
      const id = `msg_${Math.random().toString(36).slice(2, 10)}`
      return {
        id,
        ts: new Date().toISOString(),
        to: input.to,
        from: input.from,
        kind: input.kind ?? "report",
        urgency: input.urgency ?? "next-turn",
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        correlationId: input.correlationId ?? input.replyTo ?? id,
        text: input.text,
        ...(input.data !== undefined ? { data: input.data } : {}),
      }
    },
    maxMessageDataBytes: 16 * 1024,
    isSessionNotAlive: (err) => err instanceof SessionNotAliveError,
    urgencies: MESSAGE_URGENCIES,
  },
  ids: {
    ulid: (nowMs = Date.now()) => `${nowMs.toString(32).padStart(10, "0")}${randomBytes(8).toString("hex")}`.toUpperCase(),
  },
  lifecycle: {
    isRetired: (desc) =>
      desc.archived === true ||
      desc.continuedTo !== undefined ||
      desc.retiredAt !== undefined ||
      (desc.endedReason !== undefined && DELIBERATE_END_REASONS.has(desc.endedReason)),
    DELIBERATE_END_REASONS,
    normalizeExpiresAt: (value) => {
      if (typeof value !== "string" || value.length === 0) return undefined
      return Number.isNaN(Date.parse(value)) ? undefined : value
    },
    isExpiresAtReached: (expiresAt, nowMs) => {
      if (expiresAt === undefined) return false
      const ms = Date.parse(expiresAt)
      return Number.isNaN(ms) || ms <= nowMs
    },
  },
})
