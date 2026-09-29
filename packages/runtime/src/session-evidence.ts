/**
 * `session_evidence` — the compact, read-only evidence object the
 * session-steward workflow (FIX-9B) hands its judge agent for ONE idle
 * session: identity, liveness flags, the last few user/assistant turns
 * (trimmed), and — for a session in a linked worktree — the branch, dirty
 * counts, ahead/behind and PR state. Everything here is cheap and
 * in-process: a bounded tail read of the session's `events.jsonl` plus one
 * worktree status lookup. Nothing here mutates anything.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { SessionDescriptor } from "./sessions.js"
import type { WorktreeStatusView } from "./worktree-status.js"

/** How much of the transcript's tail is read — enough for ~10 turns of a
 *  chatty session without ever reading a multi-MB transcript whole. */
export const EVIDENCE_TAIL_BYTES = 256 * 1024
/** Most turns kept (user + assistant each count as one). */
export const EVIDENCE_MAX_TURNS = 10
/** Character budget across every kept turn's text. */
export const EVIDENCE_TURNS_MAX_CHARS = 3_000
/** Longest single turn kept before trimming, so one huge report can't eat
 *  the whole budget. */
export const EVIDENCE_TURN_MAX_CHARS = 900

export interface EvidenceTurn {
  role: "user" | "assistant"
  text: string
}

export interface SessionEvidence {
  sessionId: string
  label?: string
  cwd?: string
  adapter?: string
  status: string
  keepAlive: boolean
  awaitingInput: boolean
  busy: boolean
  idleMinutes?: number
  turnsCompleted?: number
  turns: EvidenceTurn[]
  worktree?: {
    branch: string | null
    dirty: boolean
    changes?: { modified: number; staged: number; untracked: number }
    ahead?: number
    behind?: number
    pr: null | { state: string; number?: number }
  }
}

/** `text` cut to `max` chars: the head for a user turn (the ask is at the
 *  start), the tail for an assistant turn (the conclusion is at the end). */
function trimTurn(text: string, max: number, keep: "head" | "tail"): string {
  const t = text.trim()
  if (t.length <= max) return t
  return keep === "head" ? `${t.slice(0, max - 1)}…` : `…${t.slice(t.length - (max - 1))}`
}

/**
 * The last `maxTurns` user/assistant turns of an `events.jsonl` transcript,
 * oldest first, read from at most the final `tailBytes` bytes. A user turn
 * is a `user-prompt` record; an assistant turn is the run of `text-delta`
 * records until the next prompt or `turn-end` (tool calls in between don't
 * split it — their text is not included). Then trimmed newest-first to the
 * total `maxChars` budget, so the most recent exchange always survives.
 * Returns `[]` on any read error.
 */
export function readRecentTurnsSync(
  eventsPath: string,
  opts: { maxTurns?: number; maxChars?: number; tailBytes?: number } = {},
): EvidenceTurn[] {
  const maxTurns = opts.maxTurns ?? EVIDENCE_MAX_TURNS
  const maxChars = opts.maxChars ?? EVIDENCE_TURNS_MAX_CHARS
  const tailBytes = opts.tailBytes ?? EVIDENCE_TAIL_BYTES
  let fd: number
  try {
    fd = openSync(eventsPath, "r")
  } catch {
    return []
  }
  let tail: string
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, tailBytes)
    if (len === 0) return []
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    tail = buf.toString("utf8")
  } catch {
    return []
  } finally {
    closeSync(fd)
  }

  const turns: EvidenceTurn[] = []
  let assistant: string | undefined
  const closeAssistant = (): void => {
    if (assistant !== undefined && assistant.trim()) turns.push({ role: "assistant", text: assistant })
    assistant = undefined
  }
  for (const line of tail.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: { kind?: unknown; text?: unknown }
    try {
      rec = JSON.parse(trimmed) as { kind?: unknown; text?: unknown }
    } catch {
      continue // the window's first line is usually torn
    }
    if (rec.kind === "user-prompt" && typeof rec.text === "string") {
      closeAssistant()
      if (rec.text.trim()) turns.push({ role: "user", text: rec.text })
    } else if (rec.kind === "text-delta" && typeof rec.text === "string") {
      assistant = (assistant ?? "") + rec.text
    } else if (rec.kind === "turn-end") {
      closeAssistant()
    }
  }
  closeAssistant()

  const kept: EvidenceTurn[] = []
  let budget = maxChars
  for (let i = turns.length - 1; i >= 0 && kept.length < maxTurns && budget > 0; i--) {
    const t = turns[i]!
    const text = trimTurn(t.text, Math.min(EVIDENCE_TURN_MAX_CHARS, budget), t.role === "user" ? "head" : "tail")
    budget -= text.length
    kept.unshift({ role: t.role, text })
  }
  return kept
}

/** Project a descriptor + its turns + its worktree view into the compact
 *  evidence object. `nowMs` drives `idleMinutes`. */
export function buildSessionEvidence(input: {
  desc: SessionDescriptor
  turns: EvidenceTurn[]
  worktree?: WorktreeStatusView
  nowMs: number
}): SessionEvidence {
  const { desc, turns, worktree, nowMs } = input
  const lastTs = desc.lastActivityAt ?? desc.startedAt
  const lastMs = lastTs ? Date.parse(lastTs) : Number.NaN
  return {
    sessionId: desc.id,
    ...(desc.label ?? desc.name ? { label: desc.label ?? desc.name } : {}),
    ...(desc.cwd ? { cwd: desc.cwd } : {}),
    ...(desc.adapterSlug ? { adapter: desc.adapterSlug } : {}),
    status: desc.status,
    keepAlive: desc.keepAlive === true,
    awaitingInput: desc.awaitingInput === true,
    busy: desc.busy === true,
    ...(Number.isFinite(lastMs) ? { idleMinutes: Math.max(0, Math.floor((nowMs - lastMs) / 60_000)) } : {}),
    ...(desc.turnsCompleted !== undefined ? { turnsCompleted: desc.turnsCompleted } : {}),
    turns,
    ...(worktree
      ? {
          worktree: {
            branch: worktree.branch,
            dirty: worktree.dirty,
            ...(worktree.changes ? { changes: worktree.changes } : {}),
            ...(worktree.base ? { ahead: worktree.base.ahead, behind: worktree.base.behind } : {}),
            pr: worktree.pr ? { state: worktree.pr.state, ...(worktree.pr.number !== undefined ? { number: worktree.pr.number } : {}) } : null,
          },
        }
      : {}),
  }
}
