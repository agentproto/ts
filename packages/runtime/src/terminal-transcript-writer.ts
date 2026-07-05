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

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
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
