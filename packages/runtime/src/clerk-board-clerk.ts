/**
 * `clerk-board-clerk` - the BOARD arm of the clerk hook: the pass that
 * turns a PM's turn into board rows.
 *
 * ## WHAT IT DOES
 *
 * The clerk hook (AIP-68, `clerk-turn-end.ts`) runs ONE pass after a
 * session's turn ends. This module is the pass for the "plateaux des PM":
 * it reads the session's last turn (its transcript tail), extracts the
 * three kinds of thing a PM states out loud - a TASK (something to do), a
 * PROMISE (something they committed to) and a BLOCKER (something standing
 * in the way) - and writes them to the session's board, which is the
 * daemon's Task ledger (`task-ledger.ts`).
 *
 * The board is the ledger's own model, not a markdown file: a board id
 * (`tree:<rootSessionId>`, an `agent_start.boardId` stamp like
 * `pm:sarah`, or `ws:<slug>`) and a list of task records. That is the
 * same model the work-board panel (`packages/apps/src/work-board`) and
 * the `task_create` / `task_list` verbs already speak, so a PM's board
 * needs no second write path.
 *
 * ## WHY IT IS DETERMINISTIC
 *
 * The extraction is RULE-based, not LLM-based: a board is a place where
 * people look for the truth, and a pass that invents a task that was
 * never stated is worse than a pass that misses one. Every extracted item
 * is a sentence the PM actually wrote, quoted verbatim (trimmed), tagged
 * with its kind. The rules cover the French and English phrasings a PM
 * uses in practice; a sentence that matches no rule is simply not an item.
 *
 * ## WHAT IT NEVER DOES
 *
 *   - it never writes when the hook is disabled - the arm is only reached
 *     through the hook's own `enabled` gate (see `clerk-turn-end.ts`), and
 *     the hook is DISABLED by default;
 *   - it never writes to another session's board: the board is resolved
 *     from the session itself (its stamped `meta.boardId`, else its
 *     lineage board), and the ledger re-checks the caller's reach;
 *   - it never writes the same item twice: every pass diffs the items it
 *     extracted against the board's existing rows (closed rows included)
 *     before writing;
 *   - it never invents an owner, a due date or a priority - a row is
 *     `pending` and claimable, which is the ledger's own default.
 */

import type {
  BoardItemKind,
  ClerkBoardRun,
  ClerkHookConfig,
} from "./clerk-hook-config.js"
import { BOARD_ITEM_KINDS } from "./clerk-hook-config.js"

/** One turn of the transcript the pass reads (the shape the runtime's
 *  `session_evidence` already exposes). */
export interface BoardClerkTurn {
  role: "user" | "assistant"
  text: string
}

/** One item the pass extracted from a turn. */
export interface BoardItem {
  /** What kind of thing the PM stated. */
  kind: BoardItemKind
  /** The sentence the item came from, trimmed and tagged with its kind
   *  (`[task] …`, `[promise] …`, `[blocker] …`). */
  title: string
  /** The sentence the item came from, WITHOUT the kind tag. */
  source: string
}

/** How many items one pass writes at most when the config says nothing. */
export const BOARD_CLERK_DEFAULT_MAX_ITEMS = 10

/** How long a written row's title may be (the ledger has no limit; a
 *  board card does). */
export const BOARD_CLERK_MAX_TITLE_CHARS = 200

/** The prefix each kind gets on a board row. */
const KIND_TAG: Record<BoardItemKind, string> = {
  task: "[task]",
  promise: "[promise]",
  blocker: "[blocker]",
}

/** A BLOCKER wins over a PROMISE, and a PROMISE over a TASK: the most
 *  actionable reading of the sentence. French first (a Pygmalion PM
 *  writes in French), English second. */
const BLOCKER_PATTERNS: readonly RegExp[] = [
  // `\b` is ASCII-based, so it never matches after an accented letter
  // ("bloqué" ends on a non-word character) - the lookahead does.
  /bloqu(?:é|ée|és|ées|age)(?![a-z0-9])/iu,
  /\bblocked\b/iu,
  /\ben attente de\b/iu,
  /\bj'attends\b/iu,
  /\bwaiting (?:on|for)\b/iu,
  /\bpas de r[ée]ponse\b/iu,
  /\bneeds? (?:approval|sign-?off|access|input|a decision)\b/iu,
  /\bne peux pas\b/iu,
  /\bimpossible de\b/iu,
  /\bcan't\b/iu,
  /\bcannot\b/iu,
  /\bd[ée]pend de\b/iu,
]

const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bje m'engage\b/iu,
  /\bje promets\b/iu,
  /\bje prends en charge\b/iu,
  /\bje m'occupe de\b/iu,
  /\bje garantis\b/iu,
  /\bje vais\b/iu,
  /\bje ferai\b/iu,
  /\bi (?:will|promise|commit|shall)\b/iu,
  /\bi'll\b/iu,
  /\bi am going to\b/iu,
]

const TASK_PATTERNS: readonly RegExp[] = [
  /\btodo\b/iu,
  /\bt[âa]che\b/iu,
  /\baction\b/iu,
  /\b[àa] faire\b/iu,
  /\bje dois\b/iu,
  /\bil faut\b/iu,
  /\bi need to\b/iu,
  /\bi have to\b/iu,
  /\bwe need to\b/iu,
  /\bnext step\b/iu,
  /\bnext action\b/iu,
  /\bprochaine [ée]tape\b/iu,
  /\bprochain pas\b/iu,
  /\b[àa] valider\b/iu,
  /\bto (?:do|validate|review|prepare|send)\b/iu,
]

/**
 * Split a turn's text into candidate sentences. Newlines and sentence
 * punctuation both break, and a leading list marker (`- `, `* `, `1. `)
 * is stripped - a PM's board items are usually bullets.
 */
export function splitBoardSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/u)
    .map(sentence => sentence.replace(/^\s*(?:[-*•‣]|\d+[.)])\s+/u, "").trim())
    .filter(sentence => sentence.length > 0)
}

/**
 * Classify one sentence: `blocker`, `promise`, `task`, or `undefined` when
 * the sentence states none of them.
 */
export function classifyBoardSentence(sentence: string): BoardItemKind | undefined {
  if (BLOCKER_PATTERNS.some(p => p.test(sentence))) return "blocker"
  if (PROMISE_PATTERNS.some(p => p.test(sentence))) return "promise"
  if (TASK_PATTERNS.some(p => p.test(sentence))) return "task"
  return undefined
}

/** The row title a classified sentence gets: the kind tag, then the
 *  sentence, whitespace-collapsed and capped. */
export function boardItemTitle(kind: BoardItemKind, source: string): string {
  const collapsed = source.replace(/\s+/g, " ").trim()
  const capped =
    collapsed.length > BOARD_CLERK_MAX_TITLE_CHARS
      ? `${collapsed.slice(0, BOARD_CLERK_MAX_TITLE_CHARS - 1)}…`
      : collapsed
  return `${KIND_TAG[kind]} ${capped}`
}

/**
 * Normalize a title for the duplicate check: case-folded, accent-free,
 * punctuation-free. Two rows whose normalized titles are equal (or where
 * one contains the other and the shorter is long enough to be meaningful)
 * are the same item.
 */
export function normalizeBoardTitle(title: string): string {
  return stripKindTag(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** The kind tag a board row carries (`[task] `, `[promise] `, `[blocker] `)
 *  - stripped before two titles are compared, so a row the pass wrote is
 *  recognized as the same item as the sentence it came from. */
export function stripKindTag(title: string): string {
  return title.replace(/^\s*\[(?:task|promise|blocker)\]\s*/i, "")
}

/** Below this length a containment is a coincidence, not a duplicate. */
const DUPLICATE_MIN_CONTAINMENT_CHARS = 24

/** Do two normalized titles describe the same item? */
export function isSameBoardItem(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < DUPLICATE_MIN_CONTAINMENT_CHARS) return false
  if (b.length < DUPLICATE_MIN_CONTAINMENT_CHARS) return false
  return a.includes(b) || b.includes(a)
}

/**
 * Extract the items a turn states. Only the ASSISTANT's own turns are
 * read: a board holds what the PM said, not what they were asked.
 */
export function extractBoardItems(
  turns: readonly BoardClerkTurn[],
  opts: { kinds?: readonly BoardItemKind[] } = {},
): BoardItem[] {
  const wanted = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null
  const items: BoardItem[] = []
  const seen: string[] = []
  for (const turn of turns ?? []) {
    if (!turn || turn.role !== "assistant" || typeof turn.text !== "string") continue
    for (const sentence of splitBoardSentences(turn.text)) {
      const kind = classifyBoardSentence(sentence)
      if (!kind) continue
      if (wanted && !wanted.has(kind)) continue
      const source = sentence.replace(/\s+/g, " ").trim()
      const normalized = normalizeBoardTitle(source)
      if (seen.some(prev => isSameBoardItem(prev, normalized))) continue
      seen.push(normalized)
      items.push({ kind, title: boardItemTitle(kind, source), source })
    }
  }
  return items
}

/** The slice of the Task ledger the board pass writes through - the real
 *  `TaskLedger` satisfies it structurally. */
export interface BoardClerkLedger {
  list(
    filter: { boardId?: string; includeClosed?: boolean } | undefined,
    caller: BoardClerkCaller,
  ): BoardClerkTask[]
  create(
    input: {
      title: string
      description?: string
      boardId?: string
      meta?: Record<string, string>
    },
    caller: BoardClerkCaller,
  ): { ok: boolean; error?: string }
  resolveBoardId(caller: BoardClerkCaller, explicit?: string): string
}

/** Who the pass writes as: the PM's own session (so the rows are created
 *  by that session, on that session's board). */
export type BoardClerkCaller = { kind: "session"; sessionId: string }

/** The row shape the pass reads back (the ledger's own `TaskRecord`). */
export interface BoardClerkTask {
  taskId: string
  boardId: string
  title: string
  status: string
}

export interface BoardClerkPassInput {
  /** The session the pass runs for (the PM's session). */
  sessionId: string
  /** The session's last turns. */
  turns: readonly BoardClerkTurn[]
  /** The resolved hook config - the board arm's options come from it. */
  config: ClerkHookConfig
  /** The Task ledger. */
  ledger: BoardClerkLedger
}

export interface BoardClerkPassResult {
  /** The board the pass wrote to. */
  boardId: string
  /** How many rows were written. */
  created: number
  /** How many extracted items were skipped (already on the board, or
   *  filtered out by the config). */
  skipped: number
  /** The items the pass considered. */
  items: BoardItem[]
  /** Errors the ledger returned (one per refused write). */
  errors: string[]
}

/** The board arm's options, or `undefined` when the config does not name
 *  the board arm. */
export function boardRunOf(config: ClerkHookConfig): ClerkBoardRun | undefined {
  return config.run?.board
}

/**
 * Run the board pass: extract the items, diff them against the board's
 * existing rows, and write what is missing.
 *
 * The pass is a pure function of its input (no clock, no I/O of its own):
 * the ledger does the writing. A board the caller cannot reach yields no
 * rows - the ledger refuses the write and the refusal is reported.
 */
export function runBoardClerkPass(input: BoardClerkPassInput): BoardClerkPassResult {
  const caller: BoardClerkCaller = { kind: "session", sessionId: input.sessionId }
  const boardOptions = boardRunOf(input.config)
  const explicitBoard = boardOptions?.boardId
  const boardId = input.ledger.resolveBoardId(caller, explicitBoard)

  const maxItems = boardOptions?.maxItems ?? BOARD_CLERK_DEFAULT_MAX_ITEMS
  const items = extractBoardItems(input.turns, {
    ...(boardOptions?.kinds ? { kinds: boardOptions.kinds } : {}),
  })
  const considered = items.slice(0, maxItems)
  const overLimit = items.length - considered.length

  const existing = input.ledger.list({ boardId, includeClosed: true }, caller)
  const existingNormalized = existing.map(task => normalizeBoardTitle(task.title))

  const result: BoardClerkPassResult = {
    boardId,
    created: 0,
    skipped: overLimit,
    items: considered,
    errors: [],
  }

  for (const item of considered) {
    const normalized = normalizeBoardTitle(item.source)
    if (existingNormalized.some(prev => isSameBoardItem(prev, normalized))) {
      result.skipped++
      continue
    }
    const written = input.ledger.create(
      {
        title: item.title,
        boardId,
        meta: {
          source: "clerk-board",
          kind: item.kind,
          sessionId: input.sessionId,
        },
      },
      caller,
    )
    if (!written.ok) {
      result.skipped++
      if (written.error) result.errors.push(written.error)
      continue
    }
    existingNormalized.push(normalized)
    result.created++
  }

  return result
}

/** Every kind the board arm can extract - re-exported so a caller does
 *  not have to import the config module to name them. */
export { BOARD_ITEM_KINDS }
