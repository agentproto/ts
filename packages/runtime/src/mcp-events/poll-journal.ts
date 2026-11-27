/**
 * Durable, append-only journal behind `events/poll`.
 *
 * One journal per `(event name, arguments)` key, shared by every poller of
 * that key. It is fed by the poll lease's own provider watch (see
 * `poll-lease.ts`) and is deliberately NOT the webhook outbox: the outbox only
 * holds deliveries owed to a webhook subscriber and is purged after delivery,
 * so a journal built on it would be empty until somebody subscribed.
 *
 * File format (JSON lines, one file per key under `dir`):
 *   - line 1: `{"meta":{"journalId","createdAt","floorSeq"}}`
 *   - then   `{"seq","at","event"}` (an event) or `{"seq","at","gap":true}`.
 * `seq` is strictly increasing and never reused: a purge rewrites the file
 * with `floorSeq` set to the last dropped sequence number.
 *
 * A "gap" entry marks the start of a new watch (first lease, idle expiry,
 * daemon restart): events may have been missed before it, so a cursor that
 * crosses a gap reads as `truncated`.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { appendLineDurableSync, writeFileDurableSync } from "../durable-file.js"

export interface JournalEvent {
  eventId: string
  name: string
  timestamp: string
  data: unknown
}

export interface JournalOptions {
  dir: string
  /** How long entries are kept. Default 24 h. */
  retentionMs?: number
  /** Hard cap on retained entries per journal. Default 5000. */
  maxEntries?: number
  now?: () => number
}

export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_ENTRIES = 5000

interface Meta {
  journalId: string
  createdAt: number
  floorSeq: number
}

type Entry = { seq: number; at: number; event: JournalEvent } | { seq: number; at: number; gap: true }

interface Loaded {
  meta: Meta
  entries: Entry[]
}

export interface JournalRead {
  journalId: string
  events: Array<{ seq: number; event: JournalEvent }>
  /** Sequence number of the newest entry (the watermark). */
  headSeq: number
  /** Sequence number of the last entry returned (equals `headSeq` when nothing is left unread). */
  lastReturnedSeq: number
  hasMore: boolean
  truncated: boolean
}

export interface ReadInput {
  /** `null` = start from the head ("from now"). */
  after: { journalId: string; seq: number } | null
  maxAgeMs?: number
  maxEvents: number
}

export interface PollJournal {
  /** Append events (already filtered by the caller) to the journal of `key`. */
  append(key: string, events: readonly JournalEvent[]): void
  /** Mark the start of a new watch on `key`. */
  markGap(key: string): void
  read(key: string, input: ReadInput): JournalRead
  /** Drop entries past retention; remove empty journals no live watch feeds. Returns the number of entries dropped. */
  purge(isActive?: (key: string) => boolean): number
  /** True when a journal exists for `key`. */
  has(key: string): boolean
  /**
   * Wake `listener` after every `append` that added an entry and every `markGap` on `key` (in memory, same process).
   * Returns the unsubscribe function. Used by `events/stream` to read as soon as something lands.
   */
  subscribe(key: string, listener: () => void): () => void
  /** Number of live listeners on `key` (tests and diagnostics). */
  listenerCount(key: string): number
}

export function journalKey(name: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${name}\n${canonicalJson(args)}`).digest("hex").slice(0, 40)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function serialize(loaded: Loaded): string {
  return [JSON.stringify({ meta: loaded.meta }), ...loaded.entries.map(e => JSON.stringify(e))].join("\n") + "\n"
}

function parseFile(text: string): Loaded | null {
  const lines = text.split("\n").filter(l => l.length > 0)
  if (lines.length === 0) return null
  let meta: Meta
  try {
    const first = JSON.parse(lines[0]!) as { meta?: Meta }
    if (!first.meta || typeof first.meta.journalId !== "string") return null
    meta = first.meta
  } catch {
    return null
  }
  const entries: Entry[] = []
  for (const line of lines.slice(1)) {
    try {
      const entry = JSON.parse(line) as Entry
      if (typeof entry.seq === "number" && typeof entry.at === "number") entries.push(entry)
    } catch {
      // A torn final line (crash mid-append) is skipped; earlier entries stay valid.
    }
  }
  return { meta, entries }
}

export function createPollJournal(opts: JournalOptions): PollJournal {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = opts.now ?? Date.now
  const cache = new Map<string, Loaded>()

  const fileFor = (key: string): string => join(opts.dir, `${key}.jsonl`)
  const listeners = new Map<string, Set<() => void>>()

  function notify(key: string): void {
    const set = listeners.get(key)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener()
      } catch {
        // A listener must never break the writer.
      }
    }
  }

  function load(key: string): Loaded | null {
    const cached = cache.get(key)
    if (cached) return cached
    const file = fileFor(key)
    if (!existsSync(file)) return null
    const loaded = parseFile(readFileSync(file, "utf8"))
    if (loaded) cache.set(key, loaded)
    return loaded
  }

  function create(key: string): Loaded {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    const loaded: Loaded = {
      meta: { journalId: `jrn_${randomBytes(9).toString("base64url")}`, createdAt: now(), floorSeq: 0 },
      entries: [],
    }
    writeFileDurableSync(fileFor(key), serialize(loaded))
    cache.set(key, loaded)
    return loaded
  }

  function headSeq(loaded: Loaded): number {
    return loaded.entries.at(-1)?.seq ?? loaded.meta.floorSeq
  }

  function appendEntry(key: string, loaded: Loaded, entry: Entry): void {
    appendLineDurableSync(fileFor(key), JSON.stringify(entry))
    loaded.entries.push(entry)
  }

  /** Rewrite one journal without its expired entries; returns how many were dropped. */
  function trim(key: string, loaded: Loaded): number {
    const cutoff = now() - retentionMs
    let drop = 0
    while (drop < loaded.entries.length && loaded.entries[drop]!.at < cutoff) drop++
    drop = Math.max(drop, loaded.entries.length - maxEntries)
    if (drop <= 0) return 0
    const dropped = loaded.entries.slice(0, drop)
    loaded.meta = { ...loaded.meta, floorSeq: dropped[dropped.length - 1]!.seq }
    loaded.entries = loaded.entries.slice(drop)
    writeFileDurableSync(fileFor(key), serialize(loaded))
    return drop
  }

  return {
    has: key => load(key) !== null,

    append(key, events) {
      if (events.length === 0) return
      const loaded = load(key) ?? create(key)
      let seq = headSeq(loaded)
      // At-least-once from the provider, exactly-once in the journal: a re-served event is skipped.
      const known = new Set<string>()
      for (const entry of loaded.entries) if ("event" in entry) known.add(entry.event.eventId)
      let added = 0
      for (const event of events) {
        if (known.has(event.eventId)) continue
        known.add(event.eventId)
        appendEntry(key, loaded, { seq: ++seq, at: now(), event })
        added++
      }
      if (loaded.entries.length > maxEntries) trim(key, loaded)
      if (added > 0) notify(key)
    },

    markGap(key) {
      const loaded = load(key) ?? create(key)
      appendEntry(key, loaded, { seq: headSeq(loaded) + 1, at: now(), gap: true })
      notify(key)
    },

    subscribe(key, listener) {
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(key)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(key)
      }
    },

    listenerCount: key => listeners.get(key)?.size ?? 0,

    read(key, input) {
      const loaded = load(key) ?? create(key)
      trim(key, loaded)
      const head = headSeq(loaded)
      const { meta } = loaded
      if (input.after === null) {
        return { journalId: meta.journalId, events: [], headSeq: head, lastReturnedSeq: head, hasMore: false, truncated: false }
      }
      if (input.after.journalId !== meta.journalId) {
        // The journal this cursor came from is gone (deleted, or replaced): nothing can be replayed.
        return { journalId: meta.journalId, events: [], headSeq: head, lastReturnedSeq: head, hasMore: false, truncated: true }
      }
      const after = Math.min(input.after.seq, head)
      let truncated = after < meta.floorSeq
      const ageFloor = input.maxAgeMs === undefined ? undefined : now() - input.maxAgeMs
      const out: Array<{ seq: number; event: JournalEvent }> = []
      let lastReturned = Math.max(after, meta.floorSeq)
      let hasMore = false
      for (const entry of loaded.entries) {
        if (entry.seq <= after) continue
        if ("gap" in entry) {
          // Events may have been missed before a gap, but only when the reader started before it.
          truncated = true
          lastReturned = entry.seq
          continue
        }
        if (ageFloor !== undefined && entry.at < ageFloor) {
          truncated = true
          lastReturned = entry.seq
          continue
        }
        if (out.length >= input.maxEvents) {
          hasMore = true
          break
        }
        out.push({ seq: entry.seq, event: entry.event })
        lastReturned = entry.seq
      }
      return { journalId: meta.journalId, events: out, headSeq: head, lastReturnedSeq: hasMore ? lastReturned : head, hasMore, truncated }
    },

    purge(isActive) {
      let dropped = 0
      if (!existsSync(opts.dir)) return 0
      for (const file of readdirSync(opts.dir)) {
        if (!file.endsWith(".jsonl")) continue
        const key = file.slice(0, -".jsonl".length)
        const loaded = load(key)
        if (!loaded) continue
        dropped += trim(key, loaded)
        const newest = loaded.entries.at(-1)
        if (!newest && !(isActive?.(key) ?? false)) {
          rmSync(fileFor(key), { force: true })
          cache.delete(key)
        }
      }
      return dropped
    },
  }
}
