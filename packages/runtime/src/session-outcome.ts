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
import type { SessionEndReason } from "./session-end-reason.js"

/** Hard cap on `outcome.summary`, in characters. */
export const OUTCOME_SUMMARY_MAX = 600
/** Cap on the summary preview carried by the compact list projection. */
export const OUTCOME_COMPACT_SUMMARY_MAX = 120
/** How many bytes of `events.jsonl` boot reconcile reads back from the end
 *  to recover the last assistant message of a session that died with the
 *  daemon. Bounded so a huge transcript never turns boot into a scan. */
export const OUTCOME_TAIL_BYTES = 64 * 1024

export interface SessionOutcomeArtifact {
  type: "pr" | "commit" | "url" | "file"
  /** The artifact's canonical reference — a PR url, a commit sha, a url,
   *  or (for `type: "file"`) the session artifact's `key`
   *  (`session-artifacts.ts`) — resolve it via `session_artifact_get` /
   *  `GET /sessions/:id/artifacts/:key`. */
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
  /** Level 1 (`deriveSessionOutcome`) only ever writes `"derived"` — what an
   *  ended session produced, with zero agent/human cooperation. Level 2 adds
   *  `"judged"` (a judge agent decided the verdict, `judgedBy` names the
   *  judge session) and `"declared"` (a deterministic rule or an operator
   *  declared it, `judgedBy` is `"steward-rules"` or absent). See
   *  `registry.closeWithOutcome`. */
  source: "derived" | "judged" | "declared"
  /** `produced` — the session said something or left an artifact;
   *  `empty` — no assistant text and no artifacts. */
  status: "produced" | "empty"
  /** Level 2 only: what a judge/declaration decided the session's work
   *  amounted to. `blocked`/`needs-input` never close (flagged instead);
   *  `abandoned`/`partial`/`failed` all close as not-completed
   *  (`endedReason:"steward-abandoned"`), the verdict nuance kept here.
   *  Absent on a plain Level 1 `"derived"` outcome. */
  verdict?: "done" | "abandoned" | "partial" | "failed" | "blocked" | "needs-input"
  /** Level 2 only: who reached `verdict` — a session id (a judge agent) or
   *  the literal `"steward-rules"` for a deterministic close with no judge
   *  in the loop. Absent on a plain Level 1 `"derived"` outcome. */
  judgedBy?: string
  /** Level 2 only: free-text note from the judge/declaration explaining
   *  `verdict` — never populated by `deriveSessionOutcome` itself. */
  note?: string
  /** Last assistant message of the session, trimmed to
   *  {@link OUTCOME_SUMMARY_MAX} chars (the TAIL is kept — the conclusion,
   *  not the preamble). Absent when the session never said anything. */
  summary?: string
  /** Copy of the descriptor's end state at the moment the outcome was
   *  recorded — the termination axis, never mixed into `status`. */
  termination: {
    status: string
    /** Copy of `SessionDescriptor.endedReason` — see {@link SessionEndReason}
     *  for the full, single-source enum of values (operator kill, cost cap,
     *  provider limit, …). Absent for a plain natural exit or an ordinary
     *  turn error this file doesn't tag. A value outside the known enum is
     *  still valid (a newer/older daemon) — never gate rendering on it being
     *  a member; see `isKnownSessionEndReason`. */
    reason?: SessionEndReason
    /** The reason this row carried BEFORE an operator's "mark as completed"
     *  (`kill(id, signal, "operator-completed")` on an already-terminal
     *  session — the UI's affordance for relabeling a finished-but-not-
     *  operator-tagged row) overwrote `reason` with `"operator-completed"`.
     *  Set ONLY by that relabel, so the true original mechanism (a natural
     *  exit with no reason, `"crashed"`, `"idle-reaped"`, …) is never lost
     *  under the operator's override. Absent otherwise. */
    previousReason?: SessionEndReason
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
  /** Extra `type: "file"` artifacts to merge alongside the PR-derived ones
   *  — the registry passes the session's PINNED `session-artifacts.ts`
   *  records here so the ended block can show them (an unpinned artifact
   *  still lists in the session's "Artifacts" section, just not surfaced
   *  in the terse outcome). */
  artifacts?: SessionOutcomeArtifact[]
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

  const artifacts: SessionOutcomeArtifact[] = [
    ...(desc.openedPrs ?? []).map((pr): SessionOutcomeArtifact => ({
      type: "pr",
      ref: pr.url,
      title: `#${pr.number}`,
    })),
    ...(input.artifacts ?? []),
  ]

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
