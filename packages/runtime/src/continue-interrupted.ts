/**
 * Continue-interrupted: pick back up the sessions a daemon restart cut off
 * mid-turn, by sending each an explicit "continue" prompt.
 *
 * Everything below the prompt already exists — the persisted registry is the
 * snapshot, `maybeResumeAgent` resumes a dead row in place (lazily on its first
 * prompt, or eagerly at boot via `eager-resume.ts`), and the row keeps the
 * derived `interrupted` marker until its next successful turn-end. What a
 * restart does NOT do, by design, is re-run the interrupted prompt (prompts
 * aren't idempotent). This module is the explicit, opt-in replacement for that:
 * a NEW prompt that tells the agent its last turn was cut off and to check the
 * state on disk before carrying on.
 *
 * Two callers share one eligibility rule + one sender:
 *   - the manual verb (`session_continue_interrupted` MCP tool,
 *     `POST /sessions/continue-interrupted`, `agentproto sessions
 *     continue-interrupted`) — `mode: "manual"`, dry-run by default;
 *   - the opt-in boot pass (`daemon.continueInterruptedOnBoot`) —
 *     `mode: "boot"`, run by serve.ts right after the eager resume pass.
 *
 * Eligibility (both modes): an agent-cli row that is `interrupted` BY THE LAST
 * RESTART (`interruptedAtBoot === registry.bootId` — a stale interruption from
 * an older restart that nobody picked up is left alone), resumable under the
 * attempt cap (`canResume`), not already busy, and whose `cwd` still exists
 * (a removed worktree fails the adapter respawn every time — knowable up front,
 * so the dry run must not call such a row eligible). The prompt goes through
 * `enqueuePrompt`, the same entry MCP `agent_prompt` uses, so a
 * dead-but-resumable row lazy-resumes with its billing auth re-resolved exactly
 * as a human prompt would. When that resume fails, the outcome says so instead
 * of passing on the bare post-resume "not alive" admission error.
 *
 * No-loop rules (boot mode only — a human pressing the button is intent):
 *   - never auto-continue a row whose resume has failed (`resumeAttempts > 0`:
 *     the eager pass, or an earlier attempt, could not bring it back);
 *   - at most one auto-continue per restart (`lastAutoContinueBoot`);
 *   - at most `MAX_AUTO_CONTINUE_ATTEMPTS` auto-continues without a successful
 *     turn-end in between (`autoContinueAttempts`, booked BEFORE sending), so a
 *     continue turn that keeps getting cut off — or keeps taking the daemon
 *     down with it — stops being retried.
 *
 * Ordering (boot mode): MUST run after the supervisor is re-armed, same
 * constraint as `eager-resume.ts` — the continue turn's `turn-end` is exactly
 * what a re-armed completion policy is waiting for — and after the eager pass,
 * so a row whose eager resume failed is recognisable (`resumeAttempts`) and
 * skipped rather than lazily retried.
 */

import { existsSync } from "node:fs"
import {
  canResume,
  isResumable,
  MAX_RESUME_ATTEMPTS,
  type SessionDescriptor,
  type SessionsRegistry,
} from "./sessions.js"
import { byLastActivityDesc } from "./eager-resume.js"
import { isRetired } from "./session-retirement.js"

/** The prompt sent when the caller doesn't supply one. */
export const DEFAULT_CONTINUE_PROMPT =
  "The agentproto daemon restarted while you were mid-turn, so your previous " +
  "turn was cut off before it finished. Check the current state on disk " +
  "(files, git status, anything you were running) and continue where you left off."

/** Transcript provenance for the continue prompt (`opts.source`). */
export const CONTINUE_PROMPT_SOURCE = "daemon:continue-interrupted"

/** Cap on automatic continue prompts sent to one row without a successful
 *  turn-end in between (boot mode). 2 = the original interruption gets one
 *  auto-continue, and if a second restart cuts THAT turn off it gets one more;
 *  after that only a human (manual verb) re-sends. */
export const MAX_AUTO_CONTINUE_ATTEMPTS = 2

export type ContinueInterruptedSkipReason =
  /** Unknown id (explicit `ids` filter only). */
  | "unknown"
  /** Not interrupted at all — no turn was cut off. */
  | "not-interrupted"
  /** Interrupted by an EARLIER restart, not the last one. */
  | "stale-interrupt"
  /** Retired (`isRetired`: archived, deliberately ended, superseded) — never
   *  revived by an automatic pass. */
  | "retired"
  /** Not in-place resumable (not agent-cli / missing adapter session / archived). */
  | "not-resumable"
  /** Already burned through `MAX_RESUME_ATTEMPTS` failed resumes. */
  | "resume-cap-exhausted"
  /** Mid-turn already — someone got there first. */
  | "busy"
  /** The row's `cwd` is gone (removed worktree) — the resume would fail. */
  | "cwd-missing"
  /** Boot mode: a resume attempt has failed on this row. */
  | "resume-failed"
  /** Boot mode: already auto-continued by this boot. */
  | "already-auto-continued"
  /** Boot mode: `MAX_AUTO_CONTINUE_ATTEMPTS` reached without recovering. */
  | "auto-continue-cap"
  /** Excluded by the cross-process `isServed` gate (another daemon's row). */
  | "not-served"

export type ContinueInterruptedOutcome =
  | { id: string; name?: string; status: "eligible" }
  | { id: string; name?: string; status: "sent" }
  | { id: string; name?: string; status: "skipped"; reason: ContinueInterruptedSkipReason }
  | { id: string; name?: string; status: "failed"; error: string }

export interface ContinueInterruptedResult {
  dryRun: boolean
  /** The prompt that was (or, on a dry run, would be) sent. */
  prompt: string
  /** The boot the candidates were interrupted before (`registry.bootId`). */
  bootId: string
  /** One entry per considered row — every interrupted row when `ids` is
   *  omitted, every requested id otherwise. Eligible-first ordering matches
   *  the send order (newest activity first). */
  sessions: ContinueInterruptedOutcome[]
  /** Counts by outcome status. */
  eligible: number
  sent: number
  skipped: number
  failed: number
}

export type ContinueInterruptedMode = "manual" | "boot"

/** Decide one row. `undefined` ⇒ eligible. Pure — reads the descriptor only. */
export function continueSkipReason(
  desc: SessionDescriptor,
  bootId: string,
  mode: ContinueInterruptedMode,
): ContinueInterruptedSkipReason | undefined {
  if (desc.killedMidTurn !== true || desc.endedReason !== "daemon-restart") {
    return "not-interrupted"
  }
  if (desc.interruptedAtBoot !== bootId) return "stale-interrupt"
  if (isRetired(desc)) return "retired"
  if (!isResumable(desc)) return "not-resumable"
  if (!canResume(desc)) return "resume-cap-exhausted"
  if (desc.busy === true) return "busy"
  if (mode === "boot") {
    if ((desc.resumeAttempts ?? 0) > 0) return "resume-failed"
    if (desc.lastAutoContinueBoot === bootId) return "already-auto-continued"
    if ((desc.autoContinueAttempts ?? 0) >= MAX_AUTO_CONTINUE_ATTEMPTS) {
      return "auto-continue-cap"
    }
  }
  return undefined
}

const withName = (d: SessionDescriptor): { id: string; name?: string } =>
  d.name ? { id: d.id, name: d.name } : { id: d.id }

/**
 * List — and unless `dryRun` — continue the sessions interrupted by the last
 * restart. See the module docblock for eligibility, the no-loop rules, and the
 * ordering contract. No-throw per row: a send that fails admission (row went
 * busy, resume refused) is reported as `failed` and the pass carries on.
 */
export async function continueInterruptedSessions(opts: {
  registry: Pick<
    SessionsRegistry,
    "list" | "get" | "enqueuePrompt" | "bootId" | "recordAutoContinue"
  >
  mode: ContinueInterruptedMode
  /** Default true: report what would be sent, send nothing. */
  dryRun?: boolean
  /** Restrict to these session ids. Omitted ⇒ every interrupted row. */
  ids?: readonly string[]
  /** Custom prompt. Omitted/blank ⇒ `DEFAULT_CONTINUE_PROMPT`. */
  prompt?: string
  /** Max sends in flight at once (each may lazily resume an adapter). Clamped
   *  to ≥1. Default 4, same as the eager pass. */
  concurrency?: number
  /** Cross-process gate — see `runEagerResumePass`. Omitted ⇒ all served. */
  isServed?: (desc: SessionDescriptor) => boolean
  /** Extra visibility filter (a scoped orchestrator's subtree). Rows it
   *  rejects are dropped silently — never reported, never sent. */
  visible?: (desc: SessionDescriptor) => boolean
  /** Filesystem probe for the `cwd-missing` check. Default `existsSync`. */
  cwdExists?: (cwd: string) => boolean
}): Promise<ContinueInterruptedResult> {
  const { registry, mode, isServed, visible } = opts
  const cwdExists = opts.cwdExists ?? existsSync
  // Descriptor rules, then the one environmental fact the resume depends on
  // that is cheap to check before spending a resume attempt on it.
  const skipReason = (d: SessionDescriptor): ContinueInterruptedSkipReason | undefined =>
    continueSkipReason(d, bootId, mode) ?? (d.cwd && !cwdExists(d.cwd) ? "cwd-missing" : undefined)
  const dryRun = opts.dryRun ?? true
  const prompt = opts.prompt?.trim() ? opts.prompt : DEFAULT_CONTINUE_PROMPT
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 4))
  const bootId = registry.bootId

  const outcomes: ContinueInterruptedOutcome[] = []
  const candidates: SessionDescriptor[] = []
  const consider = (d: SessionDescriptor): void => {
    if (visible && !visible(d)) return
    if (isServed && !isServed(d)) {
      outcomes.push({ ...withName(d), status: "skipped", reason: "not-served" })
      return
    }
    const reason = skipReason(d)
    if (reason) outcomes.push({ ...withName(d), status: "skipped", reason })
    else candidates.push(d)
  }

  if (opts.ids) {
    for (const id of new Set(opts.ids)) {
      const d = registry.get(id)
      if (!d || (visible && !visible(d))) {
        outcomes.push({ id, status: "skipped", reason: "unknown" })
      } else {
        consider(d)
      }
    }
  } else {
    // Only rows that ARE interrupted are worth reporting on an unfiltered
    // call — "not interrupted" for every other session is noise.
    for (const d of registry.list()) {
      if (d.killedMidTurn === true && d.endedReason === "daemon-restart") consider(d)
    }
  }
  candidates.sort(byLastActivityDesc)

  const result: ContinueInterruptedResult = {
    dryRun,
    prompt,
    bootId,
    sessions: [],
    eligible: candidates.length,
    sent: 0,
    skipped: outcomes.length,
    failed: 0,
  }

  if (dryRun) {
    result.sessions = [
      ...candidates.map(d => ({ ...withName(d), status: "eligible" as const })),
      ...outcomes,
    ]
    return result
  }

  const sentOutcomes: ContinueInterruptedOutcome[] = new Array(candidates.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const index = cursor++
      const d = candidates[index]!
      // Re-check against the live row: a lazy prompt may have raced us
      // between selection and this slot.
      const live = registry.get(d.id) ?? d
      const reason = skipReason(live)
      if (reason) {
        sentOutcomes[index] = { ...withName(d), status: "skipped", reason }
        continue
      }
      // Book the auto-continue BEFORE sending: if this turn takes the
      // daemon down (or the next restart cuts it off), the count survives.
      if (mode === "boot") registry.recordAutoContinue(d.id)
      const attemptsBefore = live.resumeAttempts ?? 0
      try {
        await registry.enqueuePrompt(d.id, prompt, { source: CONTINUE_PROMPT_SOURCE })
        sentOutcomes[index] = { ...withName(d), status: "sent" }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // The lazy resume swallows the adapter's own error (it's logged as
        // `resumeAgent(...) failed: ...`) and books a failed attempt; what
        // reaches us is admission's "not alive" on the still-dead row. Name
        // the real failure so the caller doesn't read it as a routing bug.
        const attemptsAfter = registry.get(d.id)?.resumeAttempts ?? 0
        sentOutcomes[index] = {
          ...withName(d),
          status: "failed",
          error:
            attemptsAfter > attemptsBefore
              ? `in-place resume failed (attempt ${attemptsAfter}/${MAX_RESUME_ATTEMPTS}; ` +
                `the daemon log has the adapter's error): ${message}`
              : message,
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, candidates.length) }, () => worker()),
  )

  result.sessions = [...sentOutcomes, ...outcomes]
  result.skipped = 0
  for (const o of result.sessions) {
    if (o.status === "sent") result.sent++
    else if (o.status === "failed") result.failed++
    else if (o.status === "skipped") result.skipped++
  }
  return result
}

/** Tally of the boot-time continue pass, for the boot-banner line. */
export interface ContinueOnBootSummary {
  /** False when `daemon.continueInterruptedOnBoot` is off (nothing ran). */
  enabled: boolean
  /** Rows passing eligibility at selection time — the banner's denominator. */
  eligible: number
  sent: number
  skipped: number
  failed: number
}

/**
 * The boot pass: `continueInterruptedSessions` in `mode: "boot"`, not a dry
 * run, reduced to the banner tally. Caller (the gateway handle, invoked from
 * serve.ts) is responsible for the ordering contract in the module docblock.
 */
export async function runContinueOnBootPass(opts: {
  registry: Parameters<typeof continueInterruptedSessions>[0]["registry"]
  concurrency: number
  isServed?: (desc: SessionDescriptor) => boolean
}): Promise<ContinueOnBootSummary> {
  const res = await continueInterruptedSessions({
    registry: opts.registry,
    mode: "boot",
    dryRun: false,
    concurrency: opts.concurrency,
    ...(opts.isServed ? { isServed: opts.isServed } : {}),
  })
  return {
    enabled: true,
    eligible: res.eligible,
    sent: res.sent,
    skipped: res.skipped,
    failed: res.failed,
  }
}
