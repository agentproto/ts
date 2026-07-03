/**
 * Per-session structured event capture — one append-only JSONL file per
 * agent-cli session, written at the same tap point where `projectEvent`
 * (sessions.ts) flattens `StreamEvent`s into the ANSI ring buffer, but
 * BEFORE that flattening happens. Gives agentproto the Claude-Code
 * property: a daemon-owned structured transcript that survives a daemon
 * restart (the ring buffer doesn't) and that any frontend can render,
 * not just the two adapters `transcript-export.ts` knows how to re-read
 * from their own native stores.
 *
 * File layout: `~/.agentproto/sessions/<sessionId>/events.jsonl`, one
 * JSON object per line: `{seq, ts, kind, ...fields}`.
 *
 * PTY (`terminal`) and `command` sessions never call into this writer —
 * they have no structured event source (see report-transcript-
 * architecture.md finding C.17), so this module is only ever driven from
 * `agent-cli` sessions' `runAgentTurn`.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentStreamEvent } from "./sessions.js"
import type { SessionUsage } from "./usage.js"

/** Debounce window for flushing a buffered text-delta/thought fragment
 *  that hasn't hit a newline yet. Keeps a long no-newline stream from
 *  sitting in memory indefinitely without also spamming one record per
 *  token — mirrors the "coalesce, don't spam" rule `projectEvent`
 *  already applies to the ring buffer, just with a disk-durability
 *  angle added. */
const DEBOUNCE_MS = 250

/** `baseDir` defaults to `~/.agentproto/sessions` — overridable so tests
 *  (and a future `--home` style daemon flag) can redirect writes away from
 *  the real home directory instead of mocking `node:os`. */
export function sessionTranscriptDir(sessionId: string, baseDir?: string): string {
  return join(baseDir ?? join(homedir(), ".agentproto", "sessions"), sessionId)
}

export function sessionEventsPath(sessionId: string, baseDir?: string): string {
  return join(sessionTranscriptDir(sessionId, baseDir), "events.jsonl")
}

export interface TranscriptWriter {
  /** Record the outgoing message for a new turn. Not an ACP `StreamEvent`
   *  kind (ACP's own "agent-prompt" means the agent asking the human a
   *  question, the opposite direction) — recorded under its own
   *  "user-prompt" kind so turns stay reconstructable without overloading
   *  that name. */
  recordPrompt(sessionId: string, message: unknown): void
  /** Record one structured stream event, ahead of `projectEvent`'s
   *  flattening. Coalesces consecutive text-delta/thought chunks the same
   *  way the ring buffer does. */
  recordEvent(sessionId: string, evt: AgentStreamEvent): void
  /** Record a durable `usage_snapshot` recap at a turn boundary or on
   *  session exit — the cumulative cost/token/context view resolved by
   *  `deriveSessionUsage`. Distinct from the high-frequency `usage_update`
   *  stream: this is the aggregable turn-boundary durable record, so a
   *  daemon restart doesn't lose the session's accumulated usage. */
  recordUsageSnapshot(sessionId: string, usage: SessionUsage): void
  /** Flush buffers and close the session's append stream. Safe to call
   *  more than once (subsequent calls are no-ops) and safe to call for a
   *  session that never wrote anything (also a no-op). Production call
   *  sites treat this as fire-and-forget (same as `agentSession.close()`);
   *  the returned promise exists so tests can await the on-disk flush. */
  close(sessionId: string): Promise<void>
  /** Close every open session stream — called from the registry's
   *  synchronous shutdown path (fire-and-forget there too). */
  closeAll(): Promise<void>
}

interface WriterState {
  stream: WriteStream
  seq: number
  textBuf: string
  thoughtBuf: string
  textDebounce: ReturnType<typeof setTimeout> | null
  thoughtDebounce: ReturnType<typeof setTimeout> | null
}

export function createTranscriptWriter(opts?: { baseDir?: string }): TranscriptWriter {
  const baseDir = opts?.baseDir
  const states = new Map<string, WriterState>()

  const getState = (sessionId: string): WriterState => {
    const existing = states.get(sessionId)
    if (existing) return existing
    mkdirSync(sessionTranscriptDir(sessionId, baseDir), { recursive: true })
    const stream = createWriteStream(sessionEventsPath(sessionId, baseDir), { flags: "a" })
    stream.on("error", err => {
      console.warn(`[transcript-writer] session ${sessionId}: ${err.message}`)
    })
    const state: WriterState = {
      stream,
      seq: 0,
      textBuf: "",
      thoughtBuf: "",
      textDebounce: null,
      thoughtDebounce: null,
    }
    states.set(sessionId, state)
    return state
  }

  const writeRecord = (
    sessionId: string,
    state: WriterState,
    record: Record<string, unknown>
  ): void => {
    state.seq += 1
    state.stream.write(
      JSON.stringify({ seq: state.seq, ts: new Date().toISOString(), ...record }) + "\n"
    )
  }

  const flushTextBuf = (sessionId: string, state: WriterState): void => {
    if (state.textDebounce) {
      clearTimeout(state.textDebounce)
      state.textDebounce = null
    }
    if (!state.textBuf) return
    const text = state.textBuf
    state.textBuf = ""
    writeRecord(sessionId, state, { kind: "text-delta", sessionId, text })
  }

  const flushThoughtBuf = (sessionId: string, state: WriterState): void => {
    if (state.thoughtDebounce) {
      clearTimeout(state.thoughtDebounce)
      state.thoughtDebounce = null
    }
    if (!state.thoughtBuf) return
    const text = state.thoughtBuf
    state.thoughtBuf = ""
    writeRecord(sessionId, state, { kind: "thought", sessionId, text })
  }

  /** Flush both coalescing buffers as FINAL (non-partial) records — called
   *  before any non text/thought event so on-disk order matches wall-clock
   *  order even when a partial line was still sitting in the buffer. */
  const flushBuffers = (sessionId: string, state: WriterState): void => {
    flushThoughtBuf(sessionId, state)
    flushTextBuf(sessionId, state)
  }

  const scheduleTextDebounce = (sessionId: string, state: WriterState): void => {
    if (state.textDebounce) clearTimeout(state.textDebounce)
    state.textDebounce = setTimeout(() => {
      state.textDebounce = null
      if (!state.textBuf) return
      const text = state.textBuf
      state.textBuf = ""
      writeRecord(sessionId, state, { kind: "text-delta", sessionId, text, partial: true })
    }, DEBOUNCE_MS)
  }

  const scheduleThoughtDebounce = (sessionId: string, state: WriterState): void => {
    if (state.thoughtDebounce) clearTimeout(state.thoughtDebounce)
    state.thoughtDebounce = setTimeout(() => {
      state.thoughtDebounce = null
      if (!state.thoughtBuf) return
      const text = state.thoughtBuf
      state.thoughtBuf = ""
      writeRecord(sessionId, state, { kind: "thought", sessionId, text, partial: true })
    }, DEBOUNCE_MS)
  }

  return {
    recordPrompt(sessionId, message) {
      const state = getState(sessionId)
      flushBuffers(sessionId, state)
      const text = typeof message === "string" ? message : JSON.stringify(message)
      writeRecord(sessionId, state, { kind: "user-prompt", sessionId, text })
    },
    recordEvent(sessionId, evt) {
      const state = getState(sessionId)
      switch (evt.kind) {
        case "text-delta": {
          if (!evt.text) break
          const combined = state.textBuf + evt.text
          const lines = combined.split(/\r?\n/)
          state.textBuf = lines.pop() ?? ""
          // `split` consumes each line's terminator — reappend it so the
          // on-disk record stays byte-for-byte reconstructable (a blank
          // line becomes "\n" rather than a lossy "").
          for (const line of lines) {
            writeRecord(sessionId, state, { kind: "text-delta", sessionId, text: `${line}\n` })
          }
          if (state.textBuf) scheduleTextDebounce(sessionId, state)
          break
        }
        case "thought": {
          if (!evt.text) break
          const combined = state.thoughtBuf + evt.text
          const lines = combined.split(/\r?\n/)
          state.thoughtBuf = lines.pop() ?? ""
          for (const line of lines) {
            writeRecord(sessionId, state, { kind: "thought", sessionId, text: `${line}\n` })
          }
          if (state.thoughtBuf) scheduleThoughtDebounce(sessionId, state)
          break
        }
        case "tool-call":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, {
            kind: "tool-call",
            sessionId,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            arguments: evt.arguments,
          })
          break
        case "tool-result":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, {
            kind: "tool-result",
            sessionId,
            toolCallId: evt.toolCallId,
            result: evt.result,
            isError: evt.isError ?? false,
          })
          break
        case "agent-prompt":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, {
            kind: "agent-prompt",
            sessionId,
            toolCallId: evt.toolCallId,
            options: evt.options,
          })
          break
        case "turn-end":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, { kind: "turn-end", sessionId, reason: evt.reason })
          break
        case "error":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, { kind: "error", sessionId, error: evt.error })
          break
        case "plan":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, { kind: "plan", sessionId, entries: evt.entries ?? [] })
          break
        case "usage_update":
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, {
            kind: "usage_update",
            sessionId,
            size: evt.size,
            used: evt.used,
            ...(evt.cost ? { cost: evt.cost } : {}),
            // Persist cumulative token counts when the adapter reports them
            // (claude-code over ACP, hermes via its state.db reader,
            // mastracode via its native usage_update) so the transcript can
            // price/aggregate a session even without a `cost` block.
            ...(evt.tokensIn !== undefined ? { tokensIn: evt.tokensIn } : {}),
            ...(evt.tokensOut !== undefined ? { tokensOut: evt.tokensOut } : {}),
          })
          break
        default:
          // Unknown kind — drop, same as `projectEvent`'s implicit
          // no-op for anything it doesn't switch on.
          break
      }
    },
    recordUsageSnapshot(sessionId, usage) {
      const state = getState(sessionId)
      // Order after any buffered text/thought so on-disk order matches
      // wall-clock order.
      flushBuffers(sessionId, state)
      writeRecord(sessionId, state, {
        kind: "usage_snapshot",
        sessionId,
        // Omit absent fields so a missing value never reads as a measured 0.
        ...(usage.model !== undefined ? { model: usage.model } : {}),
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        ...(usage.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
        ...(usage.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
        ...(usage.contextSize !== undefined ? { contextSize: usage.contextSize } : {}),
        ...(usage.contextUsed !== undefined ? { contextUsed: usage.contextUsed } : {}),
        source: usage.source,
      })
    },
    close(sessionId) {
      const state = states.get(sessionId)
      if (!state) return Promise.resolve()
      flushBuffers(sessionId, state)
      states.delete(sessionId)
      return new Promise<void>(resolve => {
        state.stream.end(() => resolve())
      })
    },
    closeAll() {
      const closings: Promise<void>[] = []
      for (const sessionId of Array.from(states.keys())) {
        const state = states.get(sessionId)
        if (!state) continue
        flushBuffers(sessionId, state)
        closings.push(new Promise<void>(resolve => state.stream.end(() => resolve())))
      }
      states.clear()
      return Promise.all(closings).then(() => undefined)
    },
  }
}
