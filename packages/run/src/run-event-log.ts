/**
 * Per-run append-only event log (AIP-58 §5) — one `events.jsonl` file per
 * run under `<runsRoot>/<runId>/events.jsonl`, host-written, never step-
 * written (§Security considerations). Every envelope is `{ seq, ts, runId,
 * stepId?, type, data }`; `seq` is monotonic within a run, starting at 1.
 *
 * This is the ONLY status interface AIP-58 names — `workflow_status` and
 * `run_events` both project it, never a second store that could disagree
 * with it. Internal statuses keep their existing names (`done`,
 * `awaiting-input`, …) everywhere except the event `type` string, which
 * uses the spec's own vocabulary (`run.succeeded`, `run.suspended`, …).
 */

import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs"

export interface RunEventEnvelope {
  seq: number
  ts: string
  runId: string
  stepId?: string
  type: string
  data: unknown
}

export interface RunEventLog {
  /** Append one event, stamping `seq`/`ts`/`runId` — best-effort: a write
   *  failure is swallowed (never crashes the daemon), same posture as
   *  `workflow-runner.ts`'s `saveRuns`. */
  append(input: { stepId?: string; type: string; data?: unknown }): RunEventEnvelope
  /** Events with `seq > sinceSeq`, in order. */
  list(sinceSeq?: number): RunEventEnvelope[]
}

export const DEFAULT_RUNS_ROOT = (): string => join(homedir(), ".agentproto", "runs")

function eventsPath(runId: string, runsRoot: string): string {
  return join(runsRoot, runId, "events.jsonl")
}

/** Read every event line from `path`, skipping any line that fails to
 *  parse (a torn write from a killed process) rather than failing the
 *  whole read. */
function readEvents(path: string): RunEventEnvelope[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const events: RunEventEnvelope[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as RunEventEnvelope
      if (typeof parsed.seq === "number") events.push(parsed)
    } catch {
      // Skip a torn/partial line.
    }
  }
  return events
}

/** Read a run's events straight from disk — used by `run_events` so a
 *  caller can page a run's log regardless of whether the daemon still
 *  holds a live `RunEventLog` for it (e.g. after a restart). */
export function readRunEvents(runId: string, runsRoot: string, sinceSeq?: number): RunEventEnvelope[] {
  const events = readEvents(eventsPath(runId, runsRoot))
  return sinceSeq === undefined ? events : events.filter(e => e.seq > sinceSeq)
}

/** Create (or resume) the event log for one run. Resuming re-reads the
 *  existing file's max `seq` so a durably-suspended run's log stays
 *  monotonic across a daemon restart instead of restarting numbering. */
export function createRunEventLog(runId: string, runsRoot: string): RunEventLog {
  const path = eventsPath(runId, runsRoot)
  let nextSeq = readEvents(path).reduce((max, e) => Math.max(max, e.seq), 0) + 1

  return {
    append(input) {
      const envelope: RunEventEnvelope = {
        seq: nextSeq++,
        ts: new Date().toISOString(),
        runId,
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
        type: input.type,
        data: input.data ?? {},
      }
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, JSON.stringify(envelope) + "\n", "utf8")
      } catch {
        // Best-effort — a write failure must not crash the daemon.
      }
      return envelope
    },
    list(sinceSeq) {
      return readRunEvents(runId, runsRoot, sinceSeq)
    },
  }
}
