/**
 * Per-session JSONL byte log for PTY (`terminal`) sessions — sibling to
 * transcript-writer.ts's events.jsonl, hooked at the same tap point PTY
 * bytes already flow through on their way into the RAM-only `recentBytes`
 * ring (`appendBytes` in sessions.ts). Gives terminal sessions the same
 * restart-survival property agent-cli sessions already have: today a
 * daemon restart loses every PTY byte that isn't still sitting in the
 * ring buffer.
 *
 * File layout: `~/.agentproto/sessions/<sessionId>/terminal.jsonl`, one
 * JSON object per chunk: `{ts, bytes: <base64>}`. Base64 because PTY
 * output is arbitrary bytes (ANSI escapes, partial multi-byte sequences
 * from full-screen apps) — a JSON string can't hold raw bytes safely.
 */

import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  type WriteStream,
} from "node:fs"
import { join } from "node:path"
import { sessionTranscriptDir } from "./transcript-writer.js"

export interface TerminalTranscriptWriter {
  appendChunk(sessionId: string, chunk: Buffer): void
  /** Flush and close the session's append stream. Safe to call more than
   *  once and safe to call for a session that never wrote anything. */
  close(sessionId: string): Promise<void>
  /** Close every open session stream — called from the registry's
   *  synchronous shutdown path (fire-and-forget there too). */
  closeAll(): Promise<void>
}

export function terminalLogPath(sessionId: string, baseDir?: string): string {
  return join(sessionTranscriptDir(sessionId, baseDir), "terminal.jsonl")
}

/** Hard cap on how much of `terminal.jsonl` a tail read will scan. Chunks are
 *  base64-wrapped JSON, so the encoded window is larger than the decoded
 *  payload it contains; this bounds the read for a file with many tiny chunks
 *  while still covering a full 64 KiB ring in normal use. */
const TERMINAL_LOG_TAIL_MAX_READ = 1024 * 1024

/**
 * Read back at most `maxBytes` of decoded PTY output from the end of a
 * session's durable `terminal.jsonl`. The window is grown from the end until
 * it holds enough decoded bytes, reaches the start of the file, or hits
 * {@link TERMINAL_LOG_TAIL_MAX_READ}; the first line of a partial window is
 * torn and skipped. Returns an empty buffer when the log is missing/unreadable.
 */
export function readTerminalLogTail(
  sessionId: string,
  maxBytes: number,
  baseDir?: string,
): Buffer {
  const empty = Buffer.alloc(0)
  if (maxBytes <= 0) return empty
  let fd: number
  try {
    fd = openSync(terminalLogPath(sessionId, baseDir), "r")
  } catch {
    return empty
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return empty
    let windowBytes = Math.min(size, Math.max(16 * 1024, maxBytes * 2))
    for (;;) {
      const len = Math.min(size, windowBytes)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString("utf8").split("\n")
      if (len < size) lines.shift() // torn first record of the window
      const chunks: Buffer[] = []
      let total = 0
      for (const line of lines) {
        if (!line.trim()) continue
        let rec: { bytes?: unknown }
        try {
          rec = JSON.parse(line) as { bytes?: unknown }
        } catch {
          continue // torn line
        }
        if (typeof rec.bytes !== "string") continue
        const chunk = Buffer.from(rec.bytes, "base64")
        chunks.push(chunk)
        total += chunk.byteLength
      }
      if (total >= maxBytes || len === size || len >= TERMINAL_LOG_TAIL_MAX_READ) {
        const joined = Buffer.concat(chunks, total)
        return joined.byteLength > maxBytes
          ? joined.subarray(joined.byteLength - maxBytes)
          : joined
      }
      windowBytes = Math.min(size, Math.max(len * 2, len + 1))
    }
  } catch {
    return empty
  } finally {
    closeSync(fd)
  }
}

export function createTerminalTranscriptWriter(opts?: {
  baseDir?: string
}): TerminalTranscriptWriter {
  const baseDir = opts?.baseDir
  const streams = new Map<string, WriteStream>()

  const getStream = (sessionId: string): WriteStream => {
    const existing = streams.get(sessionId)
    if (existing) return existing
    mkdirSync(sessionTranscriptDir(sessionId, baseDir), { recursive: true })
    const stream = createWriteStream(terminalLogPath(sessionId, baseDir), { flags: "a" })
    stream.on("error", err => {
      console.warn(`[terminal-transcript-writer] session ${sessionId}: ${err.message}`)
    })
    streams.set(sessionId, stream)
    return stream
  }

  return {
    appendChunk(sessionId, chunk) {
      const stream = getStream(sessionId)
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), bytes: chunk.toString("base64") })}\n`)
    },
    close(sessionId) {
      const stream = streams.get(sessionId)
      if (!stream) return Promise.resolve()
      streams.delete(sessionId)
      return new Promise<void>(resolve => {
        stream.end(() => resolve())
      })
    },
    closeAll() {
      const closings: Promise<void>[] = []
      for (const sessionId of Array.from(streams.keys())) {
        const stream = streams.get(sessionId)
        if (!stream) continue
        closings.push(
          new Promise<void>(resolve => {
            stream.end(() => resolve())
          }),
        )
      }
      streams.clear()
      return Promise.all(closings).then(() => undefined)
    },
  }
}
