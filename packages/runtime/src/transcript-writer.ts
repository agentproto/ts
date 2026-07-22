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

import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionObserver } from "./session-observer.js"
import type { AgentStreamEvent } from "./sessions.js"
import { extractCommandArgs } from "./tool-call-record.js"
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

/** Highest `seq` already durably on disk for a session, or 0 when the file
 *  is absent/empty. A fresh writer instance (e.g. after a daemon restart)
 *  opens the existing events.jsonl in append mode, so its first record must
 *  continue from this cursor rather than restarting at 1 — otherwise a
 *  restart mid-session emits duplicate seq numbers and any `since`-based
 *  reader (GET /sessions/:id/events) silently drops the post-restart tail.
 *  Records are written in ascending `seq`, so the max is on the last valid
 *  line, but a truncated/partial final line is tolerated by scanning every
 *  parseable line rather than trusting the tail. */
function highestSeqOnDisk(path: string): number {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    // ENOENT (fresh session) or any read error — start from 0.
    return 0
  }
  let max = 0
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as { seq?: unknown }
      if (typeof rec.seq === "number" && rec.seq > max) max = rec.seq
    } catch {
      // Ignore a malformed/partial line (e.g. a torn final write).
    }
  }
  return max
}

export interface TranscriptWriter extends SessionObserver {
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
  /** Subscribe to every record as it's written for one session — the
   *  live-push half of `GET /sessions/:id/events/stream`'s replay-then-
   *  subscribe handoff (http-server.ts). Delivers the exact object shape
   *  written to disk (`{seq, ts, kind, ...}`, pre-JSON.stringify), so a
   *  consumer already reducing the poll route's `events` array can reduce
   *  this stream with identical logic. No backfill here — history is a
   *  file read the caller does itself; this only wires the live tap.
   *  Notification happens synchronously, in the same call that appends the
   *  record, so a caller that subscribes before doing its own disk read is
   *  guaranteed to observe (via this callback) every record from that
   *  point on, even ones the read might otherwise race. Returns an
   *  unsubscribe fn; safe to call more than once. */
  subscribe(sessionId: string, onRecord: (record: Record<string, unknown>) => void): () => void
}

interface WriterState {
  stream: WriteStream
  seq: number
  textBuf: string
  thoughtBuf: string
  textDebounce: ReturnType<typeof setTimeout> | null
  thoughtDebounce: ReturnType<typeof setTimeout> | null
  /**
   * Latest un-written tool-call ENRICHMENT per toolCallId — the same
   * coalescing textBuf/thoughtBuf do, for the same reason.
   *
   * An ACP agent streams a tool's `rawInput` as the model types it, so one
   * call arrives as a run of growing updates:
   *   {} → {adapter} → {adapter,cwd} → {adapter,cwd,role} → {…,prompt} → …
   * Writing each would put six records on disk for one `agent_start`, and
   * only the last is true. They're superseding snapshots, not increments:
   * keep the newest and write it once, when something else needs ordering
   * around it (see flushBuffers).
   */
  toolUpdates: Map<string, Record<string, unknown>>
  /**
   * Latest known {toolName, arguments} + announce time per in-flight
   * toolCallId, kept across BOTH the announcement and any enrichment
   * updates (not just the held/coalesced ones above) — the "tool-result"
   * handler consumes this to emit ONE normalized `tool-call-record` line
   * (see tool-call-record.ts) per finished call, since a bare "tool-result"
   * event carries neither the tool's name nor its input.
   */
  toolCallMeta: Map<string, { toolName: string; arguments: unknown; startedAt: number }>
}

export function createTranscriptWriter(opts?: { baseDir?: string }): TranscriptWriter {
  const baseDir = opts?.baseDir
  const states = new Map<string, WriterState>()
  const listeners = new Map<string, Set<(record: Record<string, unknown>) => void>>()

  const getState = (sessionId: string): WriterState => {
    const existing = states.get(sessionId)
    if (existing) return existing
    mkdirSync(sessionTranscriptDir(sessionId, baseDir), { recursive: true })
    const eventsPath = sessionEventsPath(sessionId, baseDir)
    // Resume the seq counter from what's already durable so a restart
    // mid-session keeps events.jsonl monotonic in append mode.
    const resumeSeq = highestSeqOnDisk(eventsPath)
    const stream = createWriteStream(eventsPath, { flags: "a" })
    stream.on("error", err => {
      console.warn(`[transcript-writer] session ${sessionId}: ${err.message}`)
    })
    const state: WriterState = {
      stream,
      seq: resumeSeq,
      textBuf: "",
      thoughtBuf: "",
      textDebounce: null,
      thoughtDebounce: null,
      toolUpdates: new Map(),
      toolCallMeta: new Map(),
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
    const full = { seq: state.seq, ts: new Date().toISOString(), ...record }
    state.stream.write(JSON.stringify(full) + "\n")
    const subs = listeners.get(sessionId)
    if (subs) {
      for (const onRecord of subs) onRecord(full)
    }
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

  /** Write the newest held enrichment for each in-flight tool call. */
  const flushToolUpdates = (sessionId: string, state: WriterState): void => {
    if (state.toolUpdates.size === 0) return
    const held = [...state.toolUpdates.values()]
    state.toolUpdates.clear()
    for (const record of held) writeRecord(sessionId, state, record)
  }

  /** Flush every coalescing buffer as FINAL (non-partial) records — called
   *  before any other event so on-disk order matches wall-clock order even
   *  when a partial line, or a still-growing tool input, was still held. */
  const flushBuffers = (sessionId: string, state: WriterState): void => {
    flushThoughtBuf(sessionId, state)
    flushTextBuf(sessionId, state)
    flushToolUpdates(sessionId, state)
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
        case "tool-call": {
          // Remember the latest name/input for this call regardless of
          // whether this frame is an announcement or an enrichment — the
          // eventual "tool-result" needs both and carries neither itself.
          // An enrichment's `toolName` is `""` when the update carried no
          // title (see toolCallEnrichment in @agentproto/acp); keep the
          // prior name in that case rather than overwriting it with blank.
          if (evt.toolCallId) {
            const existing = state.toolCallMeta.get(evt.toolCallId)
            state.toolCallMeta.set(evt.toolCallId, {
              toolName: evt.toolName || existing?.toolName || "",
              arguments: evt.arguments !== undefined ? evt.arguments : existing?.arguments,
              startedAt: existing?.startedAt ?? Date.now(),
            })
          }
          const record = {
            kind: "tool-call",
            sessionId,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            arguments: evt.arguments,
            // Carried through so a replay can tell an ENRICHMENT of an
            // announced call from a genuine second call. Readers merge by
            // toolCallId either way, but a record that silently drops the
            // distinction can't be reasoned about after the fact.
            ...(evt.isUpdate ? { isUpdate: true } : {}),
          }
          // An enrichment is a superseding SNAPSHOT of the call's input, and
          // the agent emits one per token as the model types it. Hold the
          // newest instead of writing all of them — flushBuffers puts it on
          // disk the moment anything else needs ordering around it (the
          // tool-result, the next call, a text delta, turn-end). Deliberately
          // no flushBuffers here: that's what lets consecutive updates for the
          // same call collapse into one record.
          if (evt.isUpdate && evt.toolCallId) {
            state.toolUpdates.set(evt.toolCallId, record)
            break
          }
          // The announcement is written at once — it's what makes the step
          // appear, and a pending row the user can see is the whole point.
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, record)
          break
        }
        case "tool-result": {
          flushBuffers(sessionId, state)
          writeRecord(sessionId, state, {
            kind: "tool-result",
            sessionId,
            toolCallId: evt.toolCallId,
            result: evt.result,
            isError: evt.isError ?? false,
          })
          // Normalized ToolCallRecord (see tool-call-record.ts) — the same
          // shape the command_execute proxy path writes via
          // `writeToolCallRecord`, so `tool_calls_list` reads one unified
          // log regardless of which path produced the call.
          const meta = evt.toolCallId ? state.toolCallMeta.get(evt.toolCallId) : undefined
          if (evt.toolCallId) state.toolCallMeta.delete(evt.toolCallId)
          const { command, args } = extractCommandArgs(meta?.arguments)
          writeRecord(sessionId, state, {
            kind: "tool-call-record",
            sessionId,
            tool: meta?.toolName || "unknown",
            ...(command !== undefined ? { command } : {}),
            ...(args !== undefined ? { args } : {}),
            isError: evt.isError ?? false,
            ...(meta ? { durationMs: Date.now() - meta.startedAt } : {}),
          })
          break
        }
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
    subscribe(sessionId, onRecord) {
      let subs = listeners.get(sessionId)
      if (!subs) {
        subs = new Set()
        listeners.set(sessionId, subs)
      }
      subs.add(onRecord)
      return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(onRecord)
        if (current.size === 0) listeners.delete(sessionId)
      }
    },
  }
}
