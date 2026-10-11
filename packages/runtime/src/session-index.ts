/**
 * Per-session index sidecar — a compact `<sessionsDir>/<id>/index.json`
 * projection of every session dir under the sessions store, maintained
 * best-effort on every write-path event (create/rename/turn-end/exit) and
 * backfilled at daemon startup for sessions that predate the sidecar.
 *
 * WHY: recovering a session by its user-visible label (or its cwd, or an id
 * prefix) used to require `grep -r` across the whole sessions store and a
 * hand-rolled parse of a multi-thousand-line `events.jsonl`. Everything was
 * in the jsonl, but answering "which session was that?" meant loading every
 * file whole. The sidecar turns that into one small JSON read per session
 * (`sessions find`) and a single bounded tail read for the "where did we
 * stop" recap (`sessions recap`).
 *
 * INVARIANTS:
 *   - additive: `events.jsonl`'s format is never touched; this is a sidecar.
 *   - best-effort: a failed index write must never fail a session write.
 *   - bounded: reads seek from the end and cap the window ({@link INDEX_TAIL_BYTES});
 *     a whole-file read of `events.jsonl` is never performed here.
 *   - throttled: the registry schedules index writes rather than doing one
 *     per streaming frame (see `scheduleIndexWrite` in sessions.ts).
 *
 * Pure by construction apart from the explicit read/write helpers; the
 * registry owns the scheduling, this module owns the shape and the disk.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { defaultTranscriptBaseDir, sessionEventsPath, sessionTranscriptDir } from "./transcript-writer.js"
import type { PendingPromptView, SessionDescriptor } from "./sessions.js"

/** Hard cap on `lastUserPrompt.text`, in characters. */
export const INDEX_MAX_PROMPT = 500
/** Hard cap on `lastOutputText`, in characters. */
export const INDEX_MAX_OUTPUT = 300
/** How many bytes of `events.jsonl` a tail read may pull back from the end.
 *  Bounded so a multi-MB transcript never turns a find/recap into a scan. */
export const INDEX_TAIL_BYTES = 256 * 1024
/** Default page size for `sessions find` / `session_search`. */
export const INDEX_DEFAULT_LIMIT = 20

/** The compact sidecar shape. Every field is optional except `id`/`kind`/
 *  `status`/`alive`/`startedAt`, so a recovered-from-jsonl entry can be
 *  partial without lying about what it knows. */
export interface SessionIndexEntry {
  id: string
  label?: string
  title?: string
  renamedByUser?: boolean
  kind: string
  status: string
  alive: boolean
  adapter?: string
  model?: string
  cwd?: string
  workspaceSlug?: string
  origin?: string
  depth?: number
  parentSessionId?: string
  startedAt: string
  lastActivityAt?: string
  /** True when the session was archived at the time this sidecar was
   *  written. Present from this point on; a sidecar written by an older
   *  daemon simply omits it, so a cold read of such a row shows it as
   *  non-archived. */
  archived?: boolean
  lastTurnReason?: string
  lastUserPrompt?: { ts: string; text: string }
  lastOutputText?: string
  turnsCompleted?: number
  costUsd?: number
}

/** One user prompt recovered from a transcript tail. */
export interface TranscriptPrompt {
  ts: string
  text: string
}

/** The bounded tail-read result: parsed prompts, the last assistant run, and
 *  how many bytes were actually read (exposed so a test can prove the read
 *  stayed within {@link INDEX_TAIL_BYTES}). */
export interface TranscriptTail {
  prompts: TranscriptPrompt[]
  lastOutputText?: string
  bytesRead: number
  /** `ts` of the first parseable record in the window, when it carries one. */
  firstTs?: string
}

/** Absolute path of one session's index sidecar. */
export function sessionIndexPath(sessionId: string, baseDir?: string): string {
  return join(sessionTranscriptDir(sessionId, baseDir), "index.json")
}

function capText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  // Slice by CODE POINT, not UTF-16 code unit, so an astral char at the
  // boundary is never split into a lone surrogate.
  const points = Array.from(flat)
  if (points.length <= max) return flat
  return points.slice(0, max - 1).join("") + "…"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Build the sidecar entry from a live/persisted descriptor, filling the
 *  transcript-derived fields (`lastUserPrompt`/`lastOutputText`) from the
 *  caller when it has them. */
export function indexEntryFromDescriptor(
  desc: SessionDescriptor,
  extra?: { lastUserPrompt?: TranscriptPrompt; lastOutputText?: string },
): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    id: desc.id,
    kind: desc.kind,
    status: desc.status,
    alive: desc.status === "running" || desc.status === "starting",
    startedAt: desc.startedAt,
  }
  if (desc.label !== undefined) entry.label = desc.label
  if (desc.title !== undefined) entry.title = desc.title
  if (desc.renamedByUser !== undefined) entry.renamedByUser = desc.renamedByUser
  if (desc.adapterSlug !== undefined) entry.adapter = desc.adapterSlug
  if (desc.model !== undefined) entry.model = desc.model
  if (desc.cwd !== undefined) entry.cwd = desc.cwd
  if (desc.workspaceSlug !== undefined) entry.workspaceSlug = desc.workspaceSlug
  if (desc.origin !== undefined) entry.origin = desc.origin
  if (desc.depth !== undefined) entry.depth = desc.depth
  if (desc.parentSessionId !== undefined) entry.parentSessionId = desc.parentSessionId
  if (desc.lastActivityAt !== undefined) entry.lastActivityAt = desc.lastActivityAt
  if (desc.lastTurnReason !== undefined) entry.lastTurnReason = desc.lastTurnReason
  if (desc.turnsCompleted !== undefined) entry.turnsCompleted = desc.turnsCompleted
  if (desc.costUsd !== undefined) entry.costUsd = desc.costUsd
  if (desc.archived === true) entry.archived = true
  const prompt = extra?.lastUserPrompt
  if (prompt && prompt.text.trim()) {
    entry.lastUserPrompt = { ts: prompt.ts, text: capText(prompt.text, INDEX_MAX_PROMPT) }
  }
  const output = extra?.lastOutputText
  if (output && output.trim()) entry.lastOutputText = capText(output, INDEX_MAX_OUTPUT)
  return entry
}

/** Read one session's sidecar. Returns undefined on ENOENT, malformed JSON,
 *  or a shape missing its id — never throws. */
export function readSessionIndex(sessionId: string, baseDir?: string): SessionIndexEntry | undefined {
  let raw: string
  try {
    raw = readFileSync(sessionIndexPath(sessionId, baseDir), "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return undefined
  return parsed as unknown as SessionIndexEntry
}

/** Atomically write one session's sidecar (tmp + rename). Best-effort:
 *  swallows every error — a failed index write must never fail a session
 *  write. */
export function writeSessionIndex(entry: SessionIndexEntry, baseDir?: string): void {
  try {
    const dir = sessionTranscriptDir(entry.id, baseDir)
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, "index.json")
    const tmpPath = `${finalPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(entry) + "\n")
    renameSync(tmpPath, finalPath)
  } catch {
    // best-effort
  }
}

/**
 * Read the final `maxBytes` of `eventsPath` and extract, in one forward pass,
 * every `user-prompt` (with its `ts`) and the last non-empty assistant text
 * run. The window's first line is usually torn; JSON.parse rejects it and it
 * is skipped. Never reads the whole file.
 */
export function readTranscriptTail(eventsPath: string, maxBytes: number = INDEX_TAIL_BYTES): TranscriptTail {
  const empty: TranscriptTail = { prompts: [], bytesRead: 0 }
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return empty
  }
  let tail: string
  let bytesRead = 0
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, Math.max(0, maxBytes))
    if (len === 0) return empty
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    bytesRead = len
    tail = buf.toString("utf8")
  } catch {
    return empty
  } finally {
    closeSync(fd)
  }

  const prompts: TranscriptPrompt[] = []
  let assistant = ""
  let lastOutputText: string | undefined
  let firstTs: string | undefined
  const sealAssistant = (): void => {
    const t = assistant.trim()
    if (t) lastOutputText = t
    assistant = ""
  }
  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // torn first line of the window
    }
    if (firstTs === undefined && typeof rec.ts === "string") firstTs = rec.ts
    if (rec.kind === "user-prompt" && typeof rec.text === "string") {
      sealAssistant()
      if (rec.text.trim()) {
        prompts.push({ ts: typeof rec.ts === "string" ? rec.ts : "", text: rec.text })
      }
    } else if (rec.kind === "text-delta" && typeof rec.text === "string") {
      assistant += rec.text
    } else if (rec.kind === "tool-call" || rec.kind === "tool-result" || rec.kind === "turn-end") {
      sealAssistant()
    }
  }
  sealAssistant()
  return { prompts, ...(lastOutputText !== undefined ? { lastOutputText } : {}), bytesRead, ...(firstTs !== undefined ? { firstTs } : {}) }
}

/** Recover a partial sidecar entry for a session from its `events.jsonl`
 *  alone — the backfill path for a missing/corrupt index. Returns undefined
 *  when the session dir has no transcript. */
export function deriveIndexFromTranscript(sessionId: string, baseDir?: string): SessionIndexEntry | undefined {
  const eventsPath = sessionEventsPath(sessionId, baseDir)
  if (!existsSync(eventsPath)) return undefined
  const tail = readTranscriptTail(eventsPath)
  // `tail.firstTs` is the first record WITHIN the 256KB window, which for a
  // long-lived session is nowhere near its start — prefer the transcript
  // file's birthtime (created when the session's first record landed) and
  // only fall back to the window/mtime when the FS reports no birthtime.
  let startedAt: string | undefined
  try {
    const stat = statSync(eventsPath)
    if (stat.birthtimeMs > 0) startedAt = stat.birthtime.toISOString()
    else startedAt = stat.mtime.toISOString()
  } catch {
    // unreadable stat — fall through to the window ts
  }
  startedAt = startedAt ?? tail.firstTs ?? new Date(0).toISOString()
  const lastPrompt = tail.prompts[tail.prompts.length - 1]
  return {
    id: sessionId,
    kind: "agent-cli",
    status: "unknown",
    alive: false,
    startedAt,
    ...(lastPrompt ? { lastUserPrompt: { ts: lastPrompt.ts, text: capText(lastPrompt.text, INDEX_MAX_PROMPT) } } : {}),
    ...(tail.lastOutputText ? { lastOutputText: capText(tail.lastOutputText, INDEX_MAX_OUTPUT) } : {}),
  }
}

/** Every sidecar under `baseDir`, newest activity first. Dirs with a missing
 *  or corrupt index are recovered in memory from their transcript tail so a
 *  find still sees them; this never writes. Best-effort: a readdir failure
 *  returns `[]`. */
export function readAllSessionIndexes(baseDir?: string): SessionIndexEntry[] {
  const dir = baseDir ?? defaultTranscriptBaseDir()
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SessionIndexEntry[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const id = ent.name
    const index = readSessionIndex(id, dir)
    if (index) {
      out.push(index)
      continue
    }
    const derived = deriveIndexFromTranscript(id, dir)
    if (derived) out.push(derived)
  }
  out.sort((a, b) => (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt))
  return out
}

/** Case-insensitive query match: `id` by prefix, every other searchable field
 *  by substring. An empty query matches everything. */
export function matchesSessionQuery(
  entry: Pick<SessionIndexEntry, "id" | "label" | "title" | "cwd" | "workspaceSlug">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (entry.id.toLowerCase().startsWith(q)) return true
  for (const field of [entry.label, entry.title, entry.cwd, entry.workspaceSlug]) {
    if (field && field.toLowerCase().includes(q)) return true
  }
  return false
}

/** Filter + order + cap a set of index entries. `limit` defaults to
 *  {@link INDEX_DEFAULT_LIMIT}. */
export function searchSessionIndexes(
  entries: readonly SessionIndexEntry[],
  query: string,
  opts: { status?: string; limit?: number } = {},
): SessionIndexEntry[] {
  const limit = opts.limit ?? INDEX_DEFAULT_LIMIT
  return entries
    .filter(e => matchesSessionQuery(e, query))
    .filter(e => (opts.status ? e.status === opts.status : true))
    .sort((a, b) => (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt))
    .slice(0, Math.max(0, limit))
}

/** The one-glance "where did we stop" recap — the output an agent needs to
 *  resume. Built from the sidecar plus a bounded tail read of the transcript. */
export interface SessionRecap {
  id: string
  status: string
  alive: boolean
  label?: string
  title?: string
  adapter?: string
  model?: string
  cwd?: string
  workspaceSlug?: string
  parentSessionId?: string
  children: string[]
  startedAt: string
  lastActivityAt?: string
  turnsCompleted?: number
  costUsd?: number
  lastTurnReason?: string
  /** Last K user prompts, oldest → newest. */
  prompts: TranscriptPrompt[]
  /** Final assistant text/thought of the last turn (trimmed). */
  lastOutputText?: string
  queuedPrompts?: number
  /** The queued prompts with age — see `SessionDescriptor.pendingPrompts`. */
  pendingPrompts?: readonly PendingPromptView[]
}

/**
 * Compose a recap from an index entry + a bounded transcript tail read.
 * `eventsPath` is read from the end only (≤{@link INDEX_TAIL_BYTES});
 * `children`/`queuedPrompts` come from the caller (the daemon has them live,
 * the CLI derives children from the index set).
 */
export function buildSessionRecap(input: {
  entry: SessionIndexEntry
  eventsPath: string
  last?: number
  children?: readonly string[]
  queuedPrompts?: number
  pendingPrompts?: readonly PendingPromptView[]
}): SessionRecap {
  const { entry } = input
  const last = input.last ?? 8
  const tail = readTranscriptTail(input.eventsPath)
  // The transcript tail is authoritative for the prompt list; fall back to
  // the sidecar's own last prompt when the tail window held none (e.g. the
  // debounced transcript write hasn't landed yet, or the window missed it).
  const source = tail.prompts.length > 0 ? tail.prompts : entry.lastUserPrompt ? [entry.lastUserPrompt] : []
  const prompts = source.slice(Math.max(0, source.length - last))
  const lastOutputText = tail.lastOutputText ?? entry.lastOutputText
  return {
    id: entry.id,
    status: entry.status,
    alive: entry.alive,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.adapter !== undefined ? { adapter: entry.adapter } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(entry.workspaceSlug !== undefined ? { workspaceSlug: entry.workspaceSlug } : {}),
    ...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
    children: [...(input.children ?? [])],
    startedAt: entry.startedAt,
    ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
    ...(entry.turnsCompleted !== undefined ? { turnsCompleted: entry.turnsCompleted } : {}),
    ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
    ...(entry.lastTurnReason !== undefined ? { lastTurnReason: entry.lastTurnReason } : {}),
    prompts,
    ...(lastOutputText ? { lastOutputText: capText(lastOutputText, INDEX_MAX_OUTPUT) } : {}),
    ...(input.queuedPrompts !== undefined ? { queuedPrompts: input.queuedPrompts } : {}),
    ...(input.pendingPrompts?.length ? { pendingPrompts: input.pendingPrompts } : {}),
  }
}

/**
 * Daemon-startup pass: create the sidecar for every session dir that lacks a
 * valid one, recovering `lastUserPrompt`/`lastOutputText` from the transcript
 * tail (never a whole-file parse). When `descriptors` are supplied (the live
 * registry), their authoritative meta fills the entry. Best-effort and
 * synchronous — a store with thousands of sessions does one readdir plus one
 * bounded read per missing index, nothing more.
 */
export function backfillSessionIndexes(
  baseDir?: string,
  opts?: { descriptors?: Iterable<SessionDescriptor> },
): { scanned: number; created: number; skipped: number } {
  const dir = baseDir ?? defaultTranscriptBaseDir()
  const byId = new Map<string, SessionDescriptor>()
  if (opts?.descriptors) {
    for (const desc of opts.descriptors) byId.set(desc.id, desc)
  }
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { scanned: 0, created: 0, skipped: 0 }
  }
  let scanned = 0
  let created = 0
  let skipped = 0
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue
    scanned++
    const id = ent.name
    if (readSessionIndex(id, dir)) {
      skipped++
      continue
    }
    if (createMissingIndex(id, dir, byId)) created++
    else skipped++
  }
  return { scanned, created, skipped }
}

/** Build + write the sidecar for one dir that has no valid index. Returns
 *  whether one was written (false when neither a descriptor nor a
 *  transcript can describe the dir). */
function createMissingIndex(id: string, dir: string, byId: ReadonlyMap<string, SessionDescriptor>): boolean {
  const desc = byId.get(id)
  const derived = deriveIndexFromTranscript(id, dir)
  if (!desc && !derived) return false
  const entry = desc
    ? indexEntryFromDescriptor(desc, {
        ...(derived?.lastUserPrompt ? { lastUserPrompt: derived.lastUserPrompt } : {}),
        ...(derived?.lastOutputText ? { lastOutputText: derived.lastOutputText } : {}),
      })
    : derived!
  writeSessionIndex(entry, dir)
  return true
}

/** Async twin of {@link readSessionIndex}'s validity check. */
async function hasValidSessionIndex(sessionId: string, baseDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(sessionIndexPath(sessionId, baseDir), "utf8")
  } catch {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && typeof parsed.id === "string" && parsed.id.length > 0
  } catch {
    return false
  }
}

/** Dirs examined per batch by {@link backfillSessionIndexesAsync} before it
 *  yields to the event loop. */
const BACKFILL_BATCH = 64

/**
 * Non-blocking variant of {@link backfillSessionIndexes} — the one the daemon
 * runs at boot. Same result, but the readdir and every sidecar check are
 * async and dirs are processed in batches with a `setImmediate` yield in
 * between, so a store with thousands of session dirs never holds the event
 * loop for the whole scan. Only the rare missing-index path (a bounded tail
 * read + a small write) stays synchronous.
 */
export async function backfillSessionIndexesAsync(
  baseDir?: string,
  opts?: { descriptors?: Iterable<SessionDescriptor> },
): Promise<{ scanned: number; created: number; skipped: number }> {
  const dir = baseDir ?? defaultTranscriptBaseDir()
  const byId = new Map<string, SessionDescriptor>()
  if (opts?.descriptors) {
    for (const desc of opts.descriptors) byId.set(desc.id, desc)
  }
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return { scanned: 0, created: 0, skipped: 0 }
  }
  let created = 0
  let skipped = 0
  for (let i = 0; i < names.length; i += BACKFILL_BATCH) {
    const batch = names.slice(i, i + BACKFILL_BATCH)
    const valid = await Promise.all(batch.map(id => hasValidSessionIndex(id, dir)))
    batch.forEach((id, j) => {
      if (valid[j]) skipped++
      else if (createMissingIndex(id, dir, byId)) created++
      else skipped++
    })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { scanned: names.length, created, skipped }
}
