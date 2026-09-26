/**
 * Derived session outcome (Level 1) — what an ended agent-cli session
 * PRODUCED, recorded by the daemon with zero agent cooperation.
 *
 * Two axes, never conflated:
 *   - termination — HOW the session stopped (the descriptor's existing
 *     `status` + `endedReason`), copied verbatim into `outcome.termination`;
 *   - outcome — WHAT it produced: its last assistant message, the PRs it
 *     opened, what it cost, and which run / parent it belongs to.
 *
 * So a killed or idle-reaped session still shows what it said and did,
 * instead of a bare "killed".
 *
 * Pure by construction (plus one bounded sync tail-read helper for boot
 * reconcile): no LLM call, no full transcript scan. The registry calls
 * {@link deriveSessionOutcome} from its single exit funnel (`emitExited`)
 * and from boot reconcile (`loadHistorySnapshot`).
 */

import { closeSync, openSync, readSync, fstatSync } from "node:fs"
import type { SessionDescriptor } from "./sessions.js"

/** Hard cap on `outcome.summary`, in characters. */
export const OUTCOME_SUMMARY_MAX = 600
/** Cap on the summary preview carried by the compact list projection. */
export const OUTCOME_COMPACT_SUMMARY_MAX = 120
/** How many bytes of `events.jsonl` boot reconcile reads back from the end
 *  to recover the last assistant message of a session that died with the
 *  daemon. Bounded so a huge transcript never turns boot into a scan. */
export const OUTCOME_TAIL_BYTES = 64 * 1024

export interface SessionOutcomeArtifact {
  type: "pr" | "commit" | "url"
  /** The artifact's canonical reference — a PR url, a commit sha, a url. */
  ref: string
  title?: string
}

export interface SessionOutcomeLink {
  /** `run` — the workflow run this session was a step of (`ref` = run id,
   *  `title` = `<workflowId>/<stepId>`); `parent` — the orchestrator session
   *  that spawned it; `review` — reserved for the review ledger (Level 2). */
  rel: "run" | "parent" | "review"
  ref: string
  title?: string
}

export interface SessionOutcome {
  /** Level 1 only ever writes `"derived"`; a declared outcome (Level 2) is a
   *  later addition. */
  source: "derived"
  /** `produced` — the session said something or left an artifact;
   *  `empty` — no assistant text and no artifacts. */
  status: "produced" | "empty"
  /** Last assistant message of the session, trimmed to
   *  {@link OUTCOME_SUMMARY_MAX} chars (the TAIL is kept — the conclusion,
   *  not the preamble). Absent when the session never said anything. */
  summary?: string
  /** Copy of the descriptor's end state at the moment the outcome was
   *  recorded — the termination axis, never mixed into `status`. */
  termination: {
    status: string
    /** `SessionDescriptor.endedReason` (`daemon-restart` / `idle-reaped` /
     *  `crashed`); absent for an operator kill, a natural exit, an error. */
    reason?: string
    exitCode?: number
    /** True when the session was killed with a turn in flight. */
    midTurn?: boolean
  }
  cost?: { usd?: number; tokensIn?: number; tokensOut?: number; durationMs?: number }
  artifacts?: SessionOutcomeArtifact[]
  links?: SessionOutcomeLink[]
  recordedAt: string
}

/** The compact list projection of an outcome (`session_list` default). */
export interface SessionOutcomeCompact {
  status: SessionOutcome["status"]
  summary?: string
}

/** Collapse whitespace and cap at `max` chars — keeping the head or the
 *  tail, marked with `…` where cut. Returns undefined for blank input. */
export function trimOutcomeText(text: string | undefined, max: number, keep: "head" | "tail"): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  if (flat.length <= max) return flat
  return keep === "tail" ? `…${flat.slice(flat.length - (max - 1))}` : `${flat.slice(0, max - 1)}…`
}

export interface DeriveSessionOutcomeInput {
  /** The last assistant message the registry observed (raw, untrimmed). */
  lastAssistantText?: string
  now?: Date
}

/**
 * Build the derived outcome for a session that has just reached a terminal
 * status. Reads only the descriptor + the caller-supplied last assistant
 * text; never touches disk.
 */
export function deriveSessionOutcome(desc: SessionDescriptor, input: DeriveSessionOutcomeInput = {}): SessionOutcome {
  const now = input.now ?? new Date()
  const summary = trimOutcomeText(input.lastAssistantText, OUTCOME_SUMMARY_MAX, "tail")

  const artifacts: SessionOutcomeArtifact[] = (desc.openedPrs ?? []).map(pr => ({
    type: "pr",
    ref: pr.url,
    title: `#${pr.number}`,
  }))

  const links: SessionOutcomeLink[] = []
  const runId = desc.meta?.workflowRunId
  if (runId) {
    const step = [desc.meta?.workflowId, desc.meta?.workflowStepId].filter(Boolean).join("/")
    links.push({ rel: "run", ref: runId, ...(step ? { title: step } : {}) })
  }
  if (desc.parentSessionId) links.push({ rel: "parent", ref: desc.parentSessionId })

  const cost: NonNullable<SessionOutcome["cost"]> = {}
  if (typeof desc.costUsd === "number") cost.usd = desc.costUsd
  if (typeof desc.tokensIn === "number") cost.tokensIn = desc.tokensIn
  if (typeof desc.tokensOut === "number") cost.tokensOut = desc.tokensOut
  const started = Date.parse(desc.startedAt)
  const ended = Date.parse(desc.endedAt ?? now.toISOString())
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) cost.durationMs = ended - started

  return {
    source: "derived",
    status: summary || artifacts.length > 0 ? "produced" : "empty",
    ...(summary ? { summary } : {}),
    termination: {
      status: desc.status,
      ...(desc.endedReason ? { reason: desc.endedReason } : {}),
      ...(typeof desc.exitCode === "number" ? { exitCode: desc.exitCode } : {}),
      ...(desc.killedMidTurn ? { midTurn: true } : {}),
    },
    ...(Object.keys(cost).length > 0 ? { cost } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(links.length > 0 ? { links } : {}),
    recordedAt: now.toISOString(),
  }
}

/** Rough richness score, for "a later richer write MAY replace a partial one". */
function richness(o: SessionOutcome): number {
  return (o.summary ? 1 : 0) + (o.artifacts?.length ?? 0) + (o.links?.length ?? 0)
}

/**
 * Idempotency rule for recording an outcome on a descriptor that may
 * already carry one: the first write wins unless the new one is for a
 * DIFFERENT termination (the session was revived and died again — a real
 * second death) or is strictly richer (e.g. a PR recorded after the exit).
 */
export function shouldReplaceOutcome(existing: SessionOutcome | undefined, next: SessionOutcome): boolean {
  if (!existing) return true
  if (existing.termination.status !== next.termination.status) return true
  if (existing.termination.reason !== next.termination.reason) return true
  return richness(next) > richness(existing)
}

/** The compact projection: status + the first
 *  {@link OUTCOME_COMPACT_SUMMARY_MAX} chars of the summary. */
export function compactOutcome(o: SessionOutcome | undefined): SessionOutcomeCompact | undefined {
  if (!o) return undefined
  const summary = trimOutcomeText(o.summary, OUTCOME_COMPACT_SUMMARY_MAX, "head")
  return { status: o.status, ...(summary ? { summary } : {}) }
}

/**
 * Last assistant message recorded in an `events.jsonl` transcript, read
 * from at most the final {@link OUTCOME_TAIL_BYTES} bytes. The message is
 * the run of `text-delta` records after the last tool call / prompt; when
 * the transcript ends on a tool call (killed mid-tool), the text run just
 * before it is returned instead. Returns undefined on any read error or
 * when no assistant text is in the window. Sync: used from boot reconcile.
 */
export function readLastAssistantTextSync(eventsPath: string): string | undefined {
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return undefined
  }
  let tail: string
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, OUTCOME_TAIL_BYTES)
    if (len === 0) return undefined
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    tail = buf.toString("utf8")
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
  const lines = tail.split("\n")
  // The first line of a mid-file window is almost always torn; JSON.parse
  // rejects it below and it is skipped.
  const parts: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    let rec: { kind?: unknown; text?: unknown }
    try {
      rec = JSON.parse(line) as { kind?: unknown; text?: unknown }
    } catch {
      continue
    }
    if (rec.kind === "text-delta" && typeof rec.text === "string") {
      parts.push(rec.text)
      continue
    }
    // A tool call / result / new prompt closes the message being collected;
    // before any text is found it just means the session ended past its
    // last message, so keep walking back.
    if ((rec.kind === "tool-call" || rec.kind === "tool-result" || rec.kind === "user-prompt") && parts.length > 0) {
      break
    }
  }
  if (parts.length === 0) return undefined
  return parts.reverse().join("")
}
