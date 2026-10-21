/**
 * Transcript search + read over a session's LINEAGE.
 *
 * After a restart (or a continue-fresh handoff) the conversation a session
 * is "carrying on" lives in the transcripts of its PREDECESSORS, not in
 * its own: the new row starts with an empty `events.jsonl` and the history
 * is one or more hops back in the lineage. A session that cannot look back
 * at its own history is a session that has to be re-briefed from scratch.
 *
 * This module is the shared, package-level implementation of that look-back:
 *
 *   - {@link buildTranscriptChain} walks the lineage (restart lineage
 *     `resumedFrom`, continue-fresh lineage `continuedFrom`, and the
 *     `succeeds` handover link) from a session to its oldest reachable
 *     ancestor. Cycle-safe, bounded, and deduplicated.
 *   - {@link searchTranscriptFile} scans a transcript for a query and
 *     returns DATED EXCERPTS — never the whole file.
 *   - {@link readTranscriptFile} reads bounded excerpts out of a
 *     transcript, optionally filtered by a query.
 *
 * Every read is bounded: a per-excerpt character cap, a total character
 * cap and a result cap. The tools built on top of this never return a whole
 * transcript — a 200 MB `events.jsonl` would be an answer no model (or
 * human) can use, and would cost more than the question.
 *
 * The vscode extension's `searchTranscripts` command is a UI over the
 * daemon's brain query (`GET /brain/query`), which needs an ingested
 * corpus; this module needs none — it reads the transcripts directly — so
 * the shared part lives HERE, in the runtime package, and consumers import
 * it from there instead of from the vscode package.
 */

import { openEventRecords } from "./events-jsonl-reader.js"
import { sessionEventsPath } from "./transcript-writer.js"

/** Default number of search hits returned. */
export const TRANSCRIPT_SEARCH_DEFAULT_MAX_RESULTS = 10
/** Hard ceiling on search hits. */
export const TRANSCRIPT_SEARCH_MAX_RESULTS = 50
/** Default characters per excerpt. */
export const TRANSCRIPT_EXCERPT_DEFAULT_CHARS = 600
/** Hard ceiling on the characters of ONE excerpt. */
export const TRANSCRIPT_EXCERPT_MAX_CHARS = 4_000
/** Default total characters returned by one call. */
export const TRANSCRIPT_TOTAL_DEFAULT_CHARS = 20_000
/** Hard ceiling on the total characters returned by one call. */
export const TRANSCRIPT_TOTAL_MAX_CHARS = 100_000
/** Hard ceiling on the number of lineage hops walked. */
export const TRANSCRIPT_CHAIN_MAX_DEPTH = 20

/** How one session is linked to the previous one in the chain. */
export type TranscriptChainLink = "resumedFrom" | "continuedFrom" | "succeeds"

/** One node of the lineage chain. */
export interface TranscriptChainNode {
  sessionId: string
  /** The link that led here (absent on the starting session). */
  via?: TranscriptChainLink
  /** 0 for the starting session, 1 for its predecessor, and so on. */
  depth: number
}

/** The lineage fields this module reads off a session descriptor. */
export interface TranscriptLineage {
  id: string
  /** Restart lineage: the row this one was restarted from. */
  resumedFrom?: string
  /** Continue-fresh lineage: the row this one continued. */
  continuedFrom?: string
  /** Handover lineage: the row this one took over from. */
  succeeds?: string
}

/** The links out of one session, in the order they are walked. */
export function predecessorLinks(desc: TranscriptLineage): { via: TranscriptChainLink; id: string }[] {
  const links: { via: TranscriptChainLink; id: string }[] = []
  if (desc.resumedFrom) links.push({ via: "resumedFrom", id: desc.resumedFrom })
  if (desc.continuedFrom) links.push({ via: "continuedFrom", id: desc.continuedFrom })
  if (desc.succeeds) links.push({ via: "succeeds", id: desc.succeeds })
  return links
}

/**
 * Walk the lineage from `startId` towards its oldest reachable ancestor.
 *
 * The walk is breadth-first over the predecessor links, deduplicated (a
 * session reached twice is visited once), cycle-safe (a lineage that loops
 * back on itself terminates) and bounded by {@link TRANSCRIPT_CHAIN_MAX_DEPTH}.
 * A predecessor whose DESCRIPTOR is missing (forgotten, archived away,
 * never persisted) stays in the chain as a leaf — its transcript may still
 * be on disk — but nothing is walked beyond it. That is not an error.
 */
export function buildTranscriptChain(
  startId: string,
  lookup: (id: string) => TranscriptLineage | undefined,
  maxDepth: number = TRANSCRIPT_CHAIN_MAX_DEPTH,
): TranscriptChainNode[] {
  const chain: TranscriptChainNode[] = [{ sessionId: startId, depth: 0 }]
  const seen = new Set<string>([startId])
  let frontier: { id: string; depth: number }[] = [{ id: startId, depth: 0 }]
  while (frontier.length > 0) {
    const next: { id: string; depth: number }[] = []
    for (const node of frontier) {
      if (node.depth >= maxDepth) continue
      const desc = lookup(node.id)
      if (!desc) continue
      for (const link of predecessorLinks(desc)) {
        if (seen.has(link.id)) continue
        seen.add(link.id)
        chain.push({ sessionId: link.id, via: link.via, depth: node.depth + 1 })
        next.push({ id: link.id, depth: node.depth + 1 })
      }
    }
    frontier = next
  }
  return chain
}

/** One dated excerpt out of a transcript. */
export interface TranscriptExcerpt {
  sessionId: string
  /** The record's sequence number in the transcript. */
  seq?: number
  /** The record's timestamp (ISO 8601), when the record carries one. */
  ts?: string
  /** The record's kind (`user-prompt`, `text-delta`, `notice`, …). */
  kind: string
  /** The excerpt text — bounded, never the whole record. */
  excerpt: string
}

/** A search hit: an excerpt plus where it came from. */
export interface TranscriptHit extends TranscriptExcerpt {
  /** Offset of the match inside the excerpt. */
  matchStart: number
  /** The record's full text length (before clipping). */
  textLength: number
}

/**
 * The searchable text of a transcript record. Only the fields that carry
 * human-readable prose are considered: the model's output, the prompts, the
 * daemon's notices, a tool's result summary. Structured bookkeeping (usage
 * frames, turn markers) carries no text and is skipped.
 */
export function recordText(rec: Record<string, unknown>): string | undefined {
  const kind = typeof rec.kind === "string" ? rec.kind : ""
  switch (kind) {
    case "user-prompt":
    case "agent-prompt":
    case "text-delta":
    case "thought":
    case "notice":
    case "plan":
    case "system-prompt": {
      const text = rec.text
      return typeof text === "string" && text.trim() ? text : undefined
    }
    case "error": {
      const err = rec.error as { message?: unknown } | undefined
      return typeof err?.message === "string" && err.message.trim() ? err.message : undefined
    }
    case "tool-result": {
      const result = rec.result
      if (typeof result === "string" && result.trim()) return result
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Clip `text` around the first occurrence of `query` (case-insensitive),
 * bounded to `maxChars`. The excerpt keeps the match in the middle so the
 * surrounding context is readable, and marks a clipped edge with an
 * ellipsis.
 */
export function excerptAround(
  text: string,
  query: string,
  maxChars: number,
): { excerpt: string; matchStart: number } {
  const cap = Math.max(1, Math.min(maxChars, TRANSCRIPT_EXCERPT_MAX_CHARS))
  const needle = query.trim().toLowerCase()
  const haystack = text.toLowerCase()
  const at = needle ? haystack.indexOf(needle) : -1
  if (text.length <= cap) return { excerpt: text, matchStart: at < 0 ? 0 : at }
  if (at < 0) {
    return { excerpt: `${text.slice(0, cap)}…`, matchStart: 0 }
  }
  // Half the budget before the match, half after it.
  const before = Math.floor(cap / 2)
  let start = Math.max(0, at - before)
  const end = Math.min(text.length, start + cap)
  start = Math.max(0, end - cap)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return {
    excerpt: `${prefix}${text.slice(start, end)}${suffix}`,
    matchStart: at - start + prefix.length,
  }
}

/** Clamp a caller-supplied result count. */
export function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return TRANSCRIPT_SEARCH_DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(Math.round(value), TRANSCRIPT_SEARCH_MAX_RESULTS))
}

/** Clamp a caller-supplied per-excerpt character cap. */
export function clampExcerptChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return TRANSCRIPT_EXCERPT_DEFAULT_CHARS
  return Math.max(80, Math.min(Math.round(value), TRANSCRIPT_EXCERPT_MAX_CHARS))
}

/** Clamp a caller-supplied total character budget. */
export function clampTotalChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return TRANSCRIPT_TOTAL_DEFAULT_CHARS
  return Math.max(200, Math.min(Math.round(value), TRANSCRIPT_TOTAL_MAX_CHARS))
}

/** Options for {@link searchTranscriptFile}. */
export interface SearchTranscriptOptions {
  query: string
  maxResults?: number
  excerptChars?: number
  totalChars?: number
}

/**
 * Scan one transcript for `query` and return dated excerpts.
 *
 * The file is streamed (never slurped): the read stops as soon as the
 * result or the character budget is exhausted, so a huge transcript costs
 * only what the caller asked for.
 */
export async function searchTranscriptFile(
  path: string,
  sessionId: string,
  opts: SearchTranscriptOptions,
): Promise<{ hits: TranscriptHit[]; truncated: boolean }> {
  const hits: TranscriptHit[] = []
  const maxResults = clampMaxResults(opts.maxResults)
  const excerptChars = clampExcerptChars(opts.excerptChars)
  const totalChars = clampTotalChars(opts.totalChars)
  const needle = opts.query.trim().toLowerCase()
  let spent = 0
  let truncated = false
  if (!needle) return { hits, truncated }
  let records: AsyncGenerator<Record<string, unknown>, void, undefined>
  try {
    records = await openEventRecords(path, 0)
  } catch {
    // A missing transcript is an empty result, not a crash.
    return { hits, truncated }
  }
  for await (const rec of records) {
    const text = recordText(rec)
    if (!text) continue
    if (!text.toLowerCase().includes(needle)) continue
    const { excerpt, matchStart } = excerptAround(text, needle, excerptChars)
    if (spent + excerpt.length > totalChars) {
      truncated = true
      break
    }
    spent += excerpt.length
    hits.push({
      sessionId,
      ...(typeof rec.seq === "number" ? { seq: rec.seq } : {}),
      ...(typeof rec.ts === "string" ? { ts: rec.ts } : {}),
      kind: typeof rec.kind === "string" ? rec.kind : "unknown",
      excerpt,
      matchStart,
      textLength: text.length,
    })
    if (hits.length >= maxResults) {
      truncated = true
      break
    }
  }
  return { hits, truncated }
}

/** Options for {@link readTranscriptFile}. */
export interface ReadTranscriptOptions {
  /** Only records whose text contains this query (case-insensitive). */
  query?: string
  /** Only records with a sequence number above this cursor. */
  since?: number
  /** Maximum number of excerpts. */
  maxRecords?: number
  /** Maximum characters per excerpt. */
  excerptChars?: number
  /** Maximum characters in total. */
  totalChars?: number
}

/**
 * Read bounded, dated excerpts out of one transcript. Never a whole file:
 * the read stops at the record cap or the character budget.
 */
export async function readTranscriptFile(
  path: string,
  sessionId: string,
  opts: ReadTranscriptOptions = {},
): Promise<{ excerpts: TranscriptExcerpt[]; truncated: boolean }> {
  const excerpts: TranscriptExcerpt[] = []
  const maxRecords = clampMaxResults(opts.maxRecords)
  const excerptChars = clampExcerptChars(opts.excerptChars)
  const totalChars = clampTotalChars(opts.totalChars)
  const needle = opts.query?.trim().toLowerCase()
  let spent = 0
  let truncated = false
  let records: AsyncGenerator<Record<string, unknown>, void, undefined>
  try {
    records = await openEventRecords(path, opts.since ?? 0)
  } catch {
    return { excerpts, truncated }
  }
  for await (const rec of records) {
    const text = recordText(rec)
    if (!text) continue
    if (needle && !text.toLowerCase().includes(needle)) continue
    const { excerpt } = excerptAround(text, needle ?? "", excerptChars)
    if (spent + excerpt.length > totalChars) {
      truncated = true
      break
    }
    spent += excerpt.length
    excerpts.push({
      sessionId,
      ...(typeof rec.seq === "number" ? { seq: rec.seq } : {}),
      ...(typeof rec.ts === "string" ? { ts: rec.ts } : {}),
      kind: typeof rec.kind === "string" ? rec.kind : "unknown",
      excerpt,
    })
    if (excerpts.length >= maxRecords) {
      truncated = true
      break
    }
  }
  return { excerpts, truncated }
}

/** The transcript path of one session id, under the given base dir. */
export function transcriptPathFor(sessionId: string, baseDir?: string): string {
  return sessionEventsPath(sessionId, baseDir)
}
