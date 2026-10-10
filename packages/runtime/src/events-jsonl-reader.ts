/**
 * Fast `since`-cursor reads over a session's append-only `events.jsonl`, for
 * `GET /sessions/:id/events`, `GET /sessions/:id/events/stream` and the chat
 * replay (http-server.ts).
 *
 * The naive read (readline + `JSON.parse` on every line from byte 0, filter
 * `seq <= since` afterwards, read to EOF past `limit`) is O(file) per call:
 * a 1 KB tail of a 233 MB transcript cost ~70 s. Three things fix it:
 *
 *   1. A per-file sparse `seq → byte offset` index (a checkpoint every
 *      {@link CHECKPOINT_EVERY} records or {@link CHECKPOINT_BYTES} bytes), cached in a small LRU keyed by path
 *      and extended incrementally as the file grows — so a read seeks
 *      straight to (at most one checkpoint span before) the
 *      first record with `seq > since`.
 *   2. Lines at or below the cursor are skipped by reading `seq` off the raw
 *      bytes — the transcript writer always serializes `{"seq":N,...}` with
 *      `seq` first (transcript-writer.ts, `{ seq, ts, ...record }`) — with a
 *      `JSON.parse` fallback for any line that doesn't match that prefix.
 *   3. The reader is an async generator, so a caller that has its `limit`
 *      just stops iterating and the file stream is closed.
 *
 * Semantics are those of the naive read: records are yielded in file order,
 * only parseable lines whose parsed `seq` is a number `> since`, malformed
 * lines skipped. Checkpoints carry the max seq seen BEFORE them, so the seek
 * stays correct even if seqs are not monotonic in the file.
 */

import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"

/** One checkpoint per this many seq-bearing records… */
export const CHECKPOINT_EVERY = 256
/** …or per this many bytes, whichever comes first — transcripts with very
 *  large records (tool outputs) would otherwise leave MBs between checkpoints. */
export const CHECKPOINT_BYTES = 256 * 1024
/** Max files whose index is kept in memory. */
export const INDEX_CACHE_MAX = 64
/** Bytes before the indexed edge kept to detect an in-place rewrite. */
const FINGERPRINT_BYTES = 64
const SCAN_CHUNK = 4 << 20

const NL = 0x0a
// `{"seq":`
const SEQ_PREFIX = Buffer.from('{"seq":')

/** `seq` read straight off a raw `{"seq":N,` / `{"seq":N}` line, or -1 when
 *  the line doesn't start with that exact prefix (caller falls back to
 *  `JSON.parse`). Never claims a seq the parsed object wouldn't have: the
 *  prefix pins it as the object's first top-level key, and JSON.stringify
 *  never emits duplicate keys. */
export function fastSeq(buf: Buffer, start: number, end: number): number {
  const p = SEQ_PREFIX.length
  if (end - start < p + 2) return -1
  for (let i = 0; i < p; i++) if (buf[start + i] !== SEQ_PREFIX[i]) return -1
  let i = start + p
  let n = 0
  let digits = 0
  while (i < end) {
    const c = buf[i]!
    if (c < 0x30 || c > 0x39) break
    n = n * 10 + (c - 0x30)
    digits++
    i++
  }
  if (digits === 0 || digits > 15 || i >= end) return -1
  // A leading zero would be invalid JSON (`01`) — let the parser decide.
  if (digits > 1 && buf[start + p] === 0x30) return -1
  const term = buf[i]
  if (term !== 0x2c /* , */ && term !== 0x7d /* } */) return -1
  return n
}

/** Parse one raw line the way the naive reader did (`trim` → `JSON.parse`),
 *  returning the record only when it carries a numeric `seq`. */
function parseLine(buf: Buffer, start: number, end: number): Record<string, unknown> | null {
  const text = buf.toString("utf8", start, end).trim()
  if (!text) return null
  try {
    const rec = JSON.parse(text) as unknown
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null
    const r = rec as Record<string, unknown>
    return typeof r.seq === "number" ? r : null
  } catch {
    return null
  }
}

/** `seq` of a line for indexing: fast path, else parsed, else null. */
function lineSeq(buf: Buffer, start: number, end: number): number | null {
  const fast = fastSeq(buf, start, end)
  if (fast >= 0) return fast
  const rec = parseLine(buf, start, end)
  return rec ? (rec.seq as number) : null
}

/** Splits a byte stream into `\n`-terminated lines, tracking each line's
 *  absolute file offset. Carries an incomplete tail across chunks. */
class LineSplitter {
  private parts: Buffer[] = []
  private partsLen = 0
  private carryOffset: number

  constructor(startOffset: number) {
    this.carryOffset = startOffset
  }

  /** Offset just past the last complete line handed out. */
  get completeOffset(): number {
    return this.carryOffset
  }

  /** Feed a chunk; `onLine(buf, s, e, lineOffset)` gets each complete line
   *  (without the `\n`). Returning `false` from `onLine` stops early and
   *  makes `push` return `false`. */
  push(
    chunk: Buffer,
    onLine: (buf: Buffer, s: number, e: number, lineOffset: number) => boolean | void,
  ): boolean {
    let pos = 0
    while (pos < chunk.length) {
      const nl = chunk.indexOf(NL, pos)
      if (nl === -1) {
        this.parts.push(pos === 0 ? chunk : chunk.subarray(pos))
        this.partsLen += chunk.length - pos
        return true
      }
      let line: Buffer
      let s: number
      let e: number
      if (this.partsLen > 0) {
        this.parts.push(chunk.subarray(pos, nl))
        line = Buffer.concat(this.parts, this.partsLen + (nl - pos))
        s = 0
        e = line.length
        this.parts = []
        this.partsLen = 0
      } else {
        line = chunk
        s = pos
        e = nl
      }
      const lineOffset = this.carryOffset
      this.carryOffset = lineOffset + (e - s) + 1
      pos = nl + 1
      if (onLine(line, s, e, lineOffset) === false) return false
    }
    return true
  }

  /** The trailing bytes with no `\n` yet (a final unterminated line). */
  rest(): Buffer | null {
    if (this.partsLen === 0) return null
    return Buffer.concat(this.parts, this.partsLen)
  }
}

interface SeqIndex {
  ino: number
  /** Offset just past the last complete line indexed. */
  indexedOffset: number
  /** Bytes `[indexedOffset - fingerprint.length, indexedOffset)`. */
  fingerprint: Buffer
  /** checkpointOffsets[i] is a line start; every record before it has
   *  seq <= checkpointMaxBefore[i]. Entry 0 is `{0, -1}`. */
  checkpointOffsets: number[]
  checkpointMaxBefore: number[]
  maxSeq: number
  recordsSinceCheckpoint: number
}

const cache = new Map<string, SeqIndex>()
const inflight = new Map<string, Promise<SeqIndex>>()

function lruTouch(path: string, idx: SeqIndex): void {
  cache.delete(path)
  cache.set(path, idx)
  while (cache.size > INDEX_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function freshIndex(ino: number): SeqIndex {
  return {
    ino,
    indexedOffset: 0,
    fingerprint: Buffer.alloc(0),
    checkpointOffsets: [0],
    checkpointMaxBefore: [-1],
    maxSeq: -1,
    recordsSinceCheckpoint: 0,
  }
}

async function buildOrExtend(path: string): Promise<SeqIndex> {
  const fh = await open(path, "r")
  try {
    const st = await fh.stat()
    let idx = cache.get(path)
    if (idx) {
      let reuse = idx.ino === st.ino && st.size >= idx.indexedOffset
      if (reuse && idx.fingerprint.length > 0) {
        const fp = Buffer.alloc(idx.fingerprint.length)
        const { bytesRead } = await fh.read(fp, 0, fp.length, idx.indexedOffset - fp.length)
        reuse = bytesRead === fp.length && fp.equals(idx.fingerprint)
      }
      if (!reuse) idx = undefined
    }
    if (!idx) idx = freshIndex(st.ino)
    if (st.size > idx.indexedOffset) {
      // Scan from the indexed edge into a scratch copy, then commit, so a
      // concurrent reader never sees a half-extended index.
      const next: SeqIndex = {
        ...idx,
        checkpointOffsets: idx.checkpointOffsets.slice(),
        checkpointMaxBefore: idx.checkpointMaxBefore.slice(),
      }
      const splitter = new LineSplitter(idx.indexedOffset)
      let pos = idx.indexedOffset
      const end = st.size
      while (pos < end) {
        // Fresh buffer per read: the splitter may retain a view of it for a
        // line that spans chunks.
        const buf = Buffer.allocUnsafe(Math.min(SCAN_CHUNK, end - pos))
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
        if (bytesRead === 0) break
        const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
        pos += bytesRead
        splitter.push(chunk, (line, s, e, lineOffset) => {
          const seq = lineSeq(line, s, e)
          if (seq === null) return
          const lastCheckpoint = next.checkpointOffsets[next.checkpointOffsets.length - 1]!
          if (
            next.recordsSinceCheckpoint >= CHECKPOINT_EVERY ||
            (next.recordsSinceCheckpoint > 0 && lineOffset - lastCheckpoint >= CHECKPOINT_BYTES)
          ) {
            next.checkpointOffsets.push(lineOffset)
            next.checkpointMaxBefore.push(next.maxSeq)
            next.recordsSinceCheckpoint = 0
          }
          if (seq > next.maxSeq) next.maxSeq = seq
          next.recordsSinceCheckpoint++
        })
      }
      next.indexedOffset = splitter.completeOffset
      const fpLen = Math.min(FINGERPRINT_BYTES, next.indexedOffset)
      const fp = Buffer.alloc(fpLen)
      if (fpLen > 0) await fh.read(fp, 0, fpLen, next.indexedOffset - fpLen)
      next.fingerprint = fp
      idx = next
    }
    lruTouch(path, idx)
    return idx
  } finally {
    await fh.close()
  }
}

/** Index for `path`, built or incrementally extended to the current EOF.
 *  Concurrent callers for one path share a single scan. Rejects with the fs
 *  error (ENOENT included) when the file can't be opened. */
async function ensureIndex(path: string): Promise<SeqIndex> {
  for (;;) {
    const pending = inflight.get(path)
    if (pending) {
      await pending.catch(() => undefined)
      // Re-check: the file may have grown while we waited.
      continue
    }
    const p = buildOrExtend(path)
    inflight.set(path, p)
    try {
      return await p
    } finally {
      inflight.delete(path)
    }
  }
}

/** Byte offset to start reading at so that every record with `seq > since`
 *  is at or after it. 0 for `since <= 0` (no index needed). */
export async function seekOffsetForSince(path: string, since: number): Promise<number> {
  if (since <= 0) {
    // Still surface ENOENT the same way the indexed path does.
    await stat(path)
    return 0
  }
  const idx = await ensureIndex(path)
  const maxBefore = idx.checkpointMaxBefore
  // Last checkpoint whose max-seq-before is <= since (maxBefore is
  // non-decreasing; entry 0 is -1 so lo always lands on a valid entry).
  let lo = 0
  let hi = maxBefore.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (maxBefore[mid]! <= since) lo = mid
    else hi = mid - 1
  }
  return idx.checkpointOffsets[lo]!
}

/** Open `path` for a `since`-cursor read. Resolves once the file is open (so
 *  a missing file rejects here with ENOENT, before any response bytes go
 *  out); the returned generator yields parsed records with numeric
 *  `seq > since` in file order. Breaking out of the iteration closes the
 *  file. */
export async function openEventRecords(
  path: string,
  since: number,
): Promise<AsyncGenerator<Record<string, unknown>, void, undefined>> {
  const start = await seekOffsetForSince(path, since)
  const stream = createReadStream(path, { start, highWaterMark: 1024 * 1024 })
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject)
    stream.once("open", () => resolve())
  })
  return readFrom(stream, start, since)
}

async function* readFrom(
  stream: ReturnType<typeof createReadStream>,
  start: number,
  since: number,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const splitter = new LineSplitter(start)
  // Raw candidate lines (seq unknown or > since) from the current chunk;
  // parsed one at a time as the consumer pulls, so a caller that stops at
  // its limit never pays JSON.parse for the rest of the chunk.
  let pending: Array<[Buffer, number, number]> = []
  const collect = (line: Buffer, s: number, e: number): void => {
    const fast = fastSeq(line, s, e)
    if (fast >= 0 && fast <= since) return
    pending.push([line, s, e])
  }
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      splitter.push(chunk, collect)
      const batch = pending
      pending = []
      for (const [line, s, e] of batch) {
        const rec = parseLine(line, s, e)
        if (rec && (rec.seq as number) > since) yield rec
      }
    }
    const rest = splitter.rest()
    if (rest) {
      const rec = parseLine(rest, 0, rest.length)
      if (rec && (rec.seq as number) > since) yield rec
    }
  } finally {
    stream.destroy()
  }
}

/** Test hook: drop every cached index. */
export function clearEventsIndexCache(): void {
  cache.clear()
}

/** Test/diagnostic hook: the cached index summary for `path`, if any. */
export function eventsIndexSnapshot(
  path: string,
): { indexedOffset: number; checkpoints: number; maxSeq: number } | undefined {
  const idx = cache.get(path)
  if (!idx) return undefined
  return {
    indexedOffset: idx.indexedOffset,
    checkpoints: idx.checkpointOffsets.length,
    maxSeq: idx.maxSeq,
  }
}
