/**
 * Pure logic for RESUME-IN-PLACE — reviving a daemon-restart ghost by
 * prompting the SAME session id. No `vscode` import, so it's directly
 * unit-testable; sessionResume.ts's command calls into these.
 *
 * This is the deliberate counterpart to sessionRestart.logic.ts, and the two
 * must never be conflated:
 *
 *   - `session_restart` (sessionRestart.*) mints a brand-NEW session id;
 *     continuity, when it happens, is via `claude --resume` / adapter resume.
 *     It's the right tool for an ordinary terminal row (exited / error /
 *     user-killed).
 *   - RESUME-IN-PLACE (this file) is just a PLAIN PROMPT to the same id. An
 *     agent-cli row killed by a daemon restart keeps its descriptor and its
 *     provider-side conversation on disk; the daemon's lazy resume-on-prompt
 *     path (#634 billing-auth re-resolution, #635 interrupted-turn contract)
 *     revives it transparently on the next prompt — SAME id, SAME history.
 *     There is no separate "resume" RPC, and NOTHING here calls
 *     `session_restart`.
 *
 * Eligibility is `isResumableInPlace` (sessionsTree.logic.ts). If the row died
 * mid-turn (#635's derived `interrupted`), that turn was DROPPED and is not
 * auto-retried — the resume prompt continues from wherever the provider last
 * saved the conversation; we surface that so the user isn't surprised.
 */

import type { SessionDescriptor } from "../client/types.js"
import { isResumableInPlace } from "../views/sessionsTree.logic.js"
import { describeSession } from "./sessionActions.logic.js"

/**
 * Client-side gate for the resume-in-place affordance — a daemon-restart ghost
 * (agent-cli, non-pty). Thin alias over `isResumableInPlace` so the command and
 * the quick-pick filter read against the same predicate the tree menu gates on.
 */
export function canResumeInPlace(session: SessionDescriptor): boolean {
  return isResumableInPlace(session)
}

/**
 * The interrupted-turn notice (#635): present ONLY when the ghost died with a
 * turn in flight (`interrupted === true`). That turn was dropped and is NOT
 * re-run — the user's prompt starts a fresh turn from the provider's last
 * saved state. Absent for a ghost that was idle at death (nothing was lost).
 */
export function resumeInterruptedNotice(session: SessionDescriptor): string | undefined {
  if (session.interrupted !== true) return undefined
  return (
    "its previous turn was interrupted by the daemon restart and was NOT re-run — " +
    "your prompt continues the conversation from where the provider last saved it"
  )
}

/** InputBox config for the resume prompt — carries the interrupted notice into
 *  the prompt line when the turn was dropped, so it's visible at the moment the
 *  user types the re-prompt. */
export function resumeInputBox(session: SessionDescriptor): { prompt: string; placeHolder: string } {
  const base = `Resume ${describeSession(session)} in place (same session)`
  const notice = resumeInterruptedNotice(session)
  return {
    prompt: notice ? `${base} — ${notice}.` : base,
    placeHolder: session.interrupted
      ? "Re-prompt to continue the interrupted turn…"
      : "Type a prompt to bring this session back…",
  }
}

/** Success toast after the resume prompt is queued — names the SAME id and
 *  spells out that no new id was minted, so it never reads like a restart. */
export function describeResume(session: SessionDescriptor): string {
  return (
    `agentproto: resuming ${describeSession(session)} in place — ` +
    `a plain prompt revives session ${session.id} (same id, same history), not a new one.`
  )
}

/** Minimal surface the resume core needs — a prompt sender and an input getter.
 *  Both are injected so the decision logic is testable without a vscode host. */
export interface ResumeInPlaceDeps {
  /** Ask the user for the resume prompt text; undefined/empty = cancelled. */
  getInput(box: { prompt: string; placeHolder: string }): Promise<string | undefined>
  /** Send a PLAIN prompt to the given (unchanged) session id. */
  sendPrompt(id: string, text: string): Promise<void>
}

export type ResumeInPlaceOutcome =
  | { resumed: false }
  | { resumed: true; id: string; text: string }

/**
 * The testable core of the resume command: collect a prompt, then send it as a
 * PLAIN prompt to the SAME session id. Deliberately routes through
 * `sendPrompt` (the plain prompt path) and NEVER `session_restart` — that is
 * the whole point of resume-in-place. Returns the id it prompted so the test
 * can assert it equals the original (no new id), and so the caller can toast.
 */
export async function runResumeInPlace(
  session: SessionDescriptor,
  deps: ResumeInPlaceDeps,
): Promise<ResumeInPlaceOutcome> {
  const text = await deps.getInput(resumeInputBox(session))
  if (!text) return { resumed: false }
  await deps.sendPrompt(session.id, text)
  return { resumed: true, id: session.id, text }
}
