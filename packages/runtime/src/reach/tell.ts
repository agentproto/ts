/**
 * `reach_send`'s engine: a session (or the host) tells the owner something.
 *
 * One message (`intent: "tell"`, no `ask`) walks the route like an approval
 * does, with no approval behind it. Every attempt is one line of
 * `<home>/reach/tells.jsonl` (key, session, adapter, kind, status, reason,
 * at): never the summary, never a link. That file is also the memory of the
 * two guards: an acknowledged tell with the same stored key in the last 24 h
 * is answered `deduped` without sending, and a session may have at most
 * {@link REACH_TELL_DAILY_LIMIT} acknowledged tells in a rolling 24 h.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isAcknowledged, type ReachAdapter, type ReachMessage, type ReachReceipt } from "@agentproto/reach"

import { sendThroughRoute } from "./router.js"

export const REACH_TELL_DAILY_LIMIT = 20
export const REACH_TELL_WINDOW_MS = 24 * 60 * 60 * 1000
export const REACH_TELL_MAX_SUMMARY = 1000
export const REACH_TELL_MAX_LINKS = 3

export interface ReachTellInput {
  summary: string
  links?: { url: string; label?: string }[]
  dedupeKey: string
  via?: string
  urgency?: "normal" | "digest" | "now"
  /** The calling session, absent for a host call. */
  source: { sessionId?: string; label?: string }
}

export type ReachTellAttempt = { adapterId: string; status: string; reason?: string }

export type ReachTellResult =
  | { status: string; adapterId?: string; reason?: string; attempts: ReachTellAttempt[] }
  | { error: "reach_rate_limited" | "urgency_now_refused" | "invalid_input"; message?: string }

export interface ReachTeller {
  send(input: ReachTellInput): Promise<ReachTellResult>
}

export interface ReachTellerOptions {
  /** The route for tells, read at send time. */
  route: () => readonly ReachAdapter[]
  /** `<agentproto home>/reach`. */
  dir: string
  log?: (line: string) => void
  now?: () => number
}

interface TellLine {
  key: string
  sessionId: string
  adapterId: string
  kind: string
  status: string
  reason?: string
  at: string
}

export function tellStoredKey(sessionId: string | undefined, dedupeKey: string): string {
  return `tell:${sessionId ?? "host"}:${dedupeKey}`
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

export function createReachTeller(opts: ReachTellerOptions): ReachTeller {
  const log = opts.log ?? (line => console.warn(line))
  const now = opts.now ?? Date.now
  const file = join(opts.dir, "tells.jsonl")
  /** Acknowledged tells only, the two guards' index. */
  let index: TellLine[] | undefined
  const inflight = new Map<string, Promise<ReachTellResult>>()

  /** Drop what is older than the window, so memory stays bounded by 24 h. */
  function prune(lines: TellLine[]): void {
    const since = now() - REACH_TELL_WINDOW_MS
    let keep = 0
    for (const l of lines) if (Date.parse(l.at) > since) lines[keep++] = l
    lines.length = keep
  }

  function load(): TellLine[] {
    if (index) return index
    index = []
    if (!existsSync(file)) return index
    try {
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        if (!raw.trim()) continue
        try {
          const line = JSON.parse(raw) as TellLine
          if (typeof line.key === "string" && isAcknowledged({ status: line.status } as ReachReceipt)) index.push(line)
        } catch {
          // A torn line is skipped.
        }
      }
    } catch (err) {
      log(`reach: could not read tells: ${err instanceof Error ? err.message : String(err)}`)
    }
    prune(index)
    return index
  }

  function record(key: string, sessionId: string, receipt: ReachReceipt, adapter: ReachAdapter): void {
    const line: TellLine = {
      key,
      sessionId,
      adapterId: adapter.id,
      kind: adapter.kind,
      status: receipt.status,
      ...(receipt.status === "undelivered" || receipt.status === "failed" ? { reason: receipt.reason } : {}),
      at: receipt.at,
    }
    if (isAcknowledged(receipt)) {
      const lines = load()
      lines.push(line)
      prune(lines)
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(line) + "\n")
    } catch (err) {
      log(`reach: could not write a tell receipt: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function run(input: ReachTellInput, key: string, sessionId: string): Promise<ReachTellResult> {
    const since = now() - REACH_TELL_WINDOW_MS
    const recent = load().filter(l => Date.parse(l.at) > since)
    if (recent.some(l => l.key === key)) return { status: "deduped", attempts: [] }
    if (recent.filter(l => l.sessionId === sessionId).length >= REACH_TELL_DAILY_LIMIT) {
      log(`reach: rate-limited ${sessionId}`)
      return { error: "reach_rate_limited" }
    }
    const route = opts.route()
    if (route.length === 0) return { status: "undelivered", reason: "no-route", attempts: [] }
    const message: ReachMessage = {
      summary: input.summary,
      ...(input.links?.length ? { links: input.links.map(l => ({ label: l.label ?? l.url, url: l.url })) } : {}),
      intent: "tell",
      to: "owner",
      urgency: input.urgency === "digest" ? "digest" : "normal",
      dedupeKey: key,
      source: input.source.sessionId
        ? {
            kind: "session",
            sessionId: input.source.sessionId,
            ...(input.source.label ? { label: input.source.label } : {}),
          }
        : { kind: "host" },
    }
    const receipts = await sendThroughRoute(route, message, {
      ...(input.via !== undefined ? { via: input.via } : {}),
      onReceipt: (receipt, adapter) => record(key, sessionId, receipt, adapter),
    })
    const attempts: ReachTellAttempt[] = receipts.map(r => ({
      adapterId: r.adapterId,
      status: r.status,
      ...(r.status === "undelivered" || r.status === "failed" ? { reason: r.reason } : {}),
    }))
    const last = receipts[receipts.length - 1]
    if (last && isAcknowledged(last)) return { status: last.status, adapterId: last.adapterId, attempts }
    log(`reach: undelivered tell ${sessionId}`)
    return { status: "undelivered", attempts }
  }

  return {
    async send(input) {
      if (input.urgency === "now") {
        return { error: "urgency_now_refused", message: "urgency now is not available to a tell" }
      }
      const summary = input.summary
      if (typeof summary !== "string" || summary.length < 1 || summary.length > REACH_TELL_MAX_SUMMARY) {
        return { error: "invalid_input", message: `summary must be 1 to ${REACH_TELL_MAX_SUMMARY} characters` }
      }
      if (input.dedupeKey.length < 1 || input.dedupeKey.length > 200) {
        return { error: "invalid_input", message: "dedupeKey must be 1 to 200 characters" }
      }
      const links = input.links ?? []
      if (links.length > REACH_TELL_MAX_LINKS || links.some(l => !isHttps(l.url))) {
        return { error: "invalid_input", message: `links: at most ${REACH_TELL_MAX_LINKS}, https only` }
      }
      const sessionId = input.source.sessionId ?? "host"
      const key = tellStoredKey(input.source.sessionId, input.dedupeKey)
      const running = inflight.get(key)
      if (running) return running
      const p = run(input, key, sessionId).finally(() => inflight.delete(key))
      inflight.set(key, p)
      return p
    },
  }
}
