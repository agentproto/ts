/**
 * Pure chain-walking logic for stitching a restarted session's transcript
 * onto its resume ancestors.
 *
 * A restart always mints a NEW session id (continuity is via provider/ACP
 * resume, never id reuse — see the runtime's `restartAgentSession` doc), and
 * the daemon now persists `resumedFrom`/`resumeVia` on the STORED descriptor
 * (`SessionDescriptor.resumedFrom`, runtime/src/sessions.ts). But the new
 * session's own events.jsonl still starts blank — its structured transcript
 * has no memory of what came before. This module answers "given a session
 * with `resumedFrom`, what's the ordered list of ancestor transcripts to
 * show above it?" without needing to know a single hard thing about
 * daemon/vscode transport — that's `fetchers`' job.
 *
 * Runs host-side (extension process), NOT injected into the webview's inline
 * script — unlike history.logic.ts, this needs `NoTranscriptError` and
 * per-session fetches the webview must never perform (it never talks to the
 * daemon directly). So it's a normal ES module, imported by
 * transcriptPanelController.ts and unit-tested directly under vitest with a
 * stub `ResumeChainFetchers`.
 */

import { NoTranscriptError } from "../client/daemonClient.js"
import type { SessionEventRecord } from "../client/types.js"

/** Minimal shape this module needs from a session descriptor — just enough
 *  to keep walking the chain, not the full `SessionDescriptor`. */
export interface ResumeLink {
  id: string
  resumedFrom?: string
  resumeVia?: string
}

/**
 * One ancestor step in the resume chain, in WALK order (index 0 is the
 * closest ancestor — `session.resumedFrom` — and each subsequent entry is
 * one hop further back). Callers that want chronological (oldest-first)
 * rendering order reverse the returned array.
 */
export interface ResumeChainSegment {
  /** The ancestor session's id. */
  sessionId: string
  /** How the CHILD (one step more recent in the chain) resumed from this
   *  ancestor — echoes the child's own `resumeVia`, since that's what
   *  actually describes the transition INTO this ancestor's history. Empty
   *  string for a fresh fallback spawn (see `SessionDescriptor.resumeVia`'s
   *  doc) — still worth a divider, just one that says no continuity was
   *  established. */
  resumeVia: string
  /** This ancestor's full structured transcript, when it loaded. Absent
   *  (with `unavailable` set instead) when it couldn't. */
  records?: readonly SessionEventRecord[]
  /** Set when this ancestor's transcript couldn't be loaded — the walk
   *  stops at this segment and never guesses further back past a session it
   *  can't read. `"no-transcript"` is a terminal/command session or one
   *  that predates structured capture (the daemon's `NoTranscriptError`);
   *  `"fetch-error"` is anything else (daemon unreachable, session unknown,
   *  transiently down). */
  unavailable?: "no-transcript" | "fetch-error"
}

export interface ResumeChainFetchers {
  /** Resolve an ancestor's own resume link so the walk can continue past it.
   *  Returning `undefined` (lookup failed) stops the walk AFTER the current
   *  segment without marking it `unavailable` — its own transcript may have
   *  loaded fine, we just can't see further back than it. */
  getResumeLink(id: string): Promise<ResumeLink | undefined>
  /** Fetch an ancestor's full structured transcript, already paged to
   *  completion. Rejects with `NoTranscriptError` (or anything else) when
   *  the session has no structured capture — the walk stops there. */
  getAllEvents(id: string): Promise<readonly SessionEventRecord[]>
}

/** Loop guard — see the module doc. A restart chain of this length is
 *  already well past anything a real "restart the same conversation a few
 *  times" workflow produces; the cap exists purely so a data bug (or a
 *  contrived cycle) can't hang the panel walking forever. */
export const DEFAULT_MAX_CHAIN_DEPTH = 10

/**
 * Walk `session.resumedFrom` backward. Returns segments in WALK order
 * (closest ancestor first) — see `ResumeChainSegment`'s doc for why the
 * caller reverses this for chronological rendering.
 *
 * Stops when: there's no further `resumedFrom` link, the depth cap is hit,
 * a cycle is detected (an id already visited), an ancestor's resume-link
 * lookup fails, or an ancestor's transcript can't be loaded (that ancestor
 * still gets a segment, marked `unavailable`, precisely so the panel can
 * show "history wasn't structured here" instead of erroring out).
 */
export async function walkResumeChain(
  session: ResumeLink,
  fetchers: ResumeChainFetchers,
  maxDepth: number = DEFAULT_MAX_CHAIN_DEPTH,
): Promise<ResumeChainSegment[]> {
  const segments: ResumeChainSegment[] = []
  const visited = new Set<string>([session.id])
  let ancestorId = session.resumedFrom
  let resumeVia = session.resumeVia ?? ""
  let depth = 0

  while (ancestorId && depth < maxDepth) {
    if (visited.has(ancestorId)) break
    visited.add(ancestorId)
    depth++

    let records: readonly SessionEventRecord[] | undefined
    let unavailable: "no-transcript" | "fetch-error" | undefined
    try {
      records = await fetchers.getAllEvents(ancestorId)
    } catch (err) {
      unavailable = err instanceof NoTranscriptError ? "no-transcript" : "fetch-error"
    }

    segments.push({
      sessionId: ancestorId,
      resumeVia,
      ...(records ? { records } : {}),
      ...(unavailable ? { unavailable } : {}),
    })

    // Can't read this ancestor's transcript — never guess further back past
    // a gap we can't verify.
    if (unavailable) break

    const link = await fetchers.getResumeLink(ancestorId).catch(() => undefined)
    if (!link) break
    ancestorId = link.resumedFrom
    resumeVia = link.resumeVia ?? ""
  }

  return segments
}
