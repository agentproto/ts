/**
 * Derives a short human-readable title from a session's first prompt, for
 * UI surfaces (sessions tree, transcript tab) that would otherwise show the
 * adapter's argv or a raw session id. See `deriveSessionTitle` below.
 */

/** Max code points a session's derived title — and an operator-supplied
 *  title/label — may carry. Exported so the rename write-path
 *  (`SessionsRegistry.renameSession`) caps to the SAME bound the derivation
 *  uses, rather than inventing a second limit. */
export const MAX_LENGTH = 60

/** Structural narrowing for an `unknown` prompt payload — no `as` casts.
 *  `Record<string, unknown>` lets property access type-check without
 *  claiming to know the shape beyond "it's an object". */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** A single ACP content block, as sent over `POST /sessions/:id/prompt`
 *  (`http-server.ts:2174`): `{type:"text", text:"..."}`, or an image/other
 *  block we don't have text for. */
function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
}

/** Pulls the plain text out of a prompt payload, which per the HTTP route
 *  is a string, a single content block, or an array of content blocks.
 *  Non-text blocks (images, etc.) are dropped; array blocks are joined
 *  with a space so a multi-block prompt still reads as one title. */
function extractText(message: unknown): string | undefined {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    const texts = message.filter(isTextBlock).map(b => b.text)
    return texts.length > 0 ? texts.join(" ") : undefined
  }
  return isTextBlock(message) ? message.text : undefined
}

/** Truncates `text` (already known to be longer than `maxLength` code
 *  points) to the last word boundary at or before `maxLength`, then
 *  appends an ellipsis — avoids cutting mid-word when a boundary is
 *  cheaply available. Falls back to a hard cut (e.g. one long unbroken
 *  token, or non-space-delimited scripts like CJK) when there is none.
 *  Slices by code point, not UTF-16 code unit, so an astral character
 *  (emoji, rare CJK) at the boundary isn't split into an orphan surrogate. */
function truncate(text: string, maxLength: number): string {
  const codePoints = Array.from(text)
  const sliced = codePoints.slice(0, maxLength).join("")
  const lastSpace = sliced.lastIndexOf(" ")
  const cut = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced
  return `${cut}…`
}

/**
 * Derives a session title from its first prompt. Returns `undefined`
 * (never `""`) when nothing usable survives, so `sessionDisplayName` below
 * falls through to the spawn label / friendly `adapter · id` fallback.
 */
export function deriveSessionTitle(message: unknown): string | undefined {
  const raw = extractText(message)
  if (raw === undefined) return undefined
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed === "") return undefined
  // Cut at the first sentence end — precedent: session-story.ts's
  // `classifyRoute` does the same for chapter titles, at 42 chars; a tree
  // row and a tab have more room than a story chapter, so this uses 60.
  // UNLIKE that precedent, the terminator must be followed by whitespace
  // or end-of-string: a coding agent's prompts are full of periods that
  // aren't sentence ends — filenames (`PLAN.md`), versions (`v1.2.3`) — and
  // a bare `[.?!].*$` (session-story.ts's rule) guillotines those at the
  // first dot, e.g. "Read PLAN.md" → "Read PLAN". Don't copy that pattern
  // here without this anchor.
  const sentence = collapsed.replace(/[.?!](\s.*)?$/, "").trim()
  if (sentence === "" || !/[\p{L}\p{N}]/u.test(sentence)) return undefined
  return Array.from(sentence).length > MAX_LENGTH ? truncate(sentence, MAX_LENGTH) : sentence
}

/**
 * A short, stable tail of a session id for the friendly fallback name —
 * enough to tell two same-adapter sessions apart without printing the full
 * `sess_…` handle. Short ids (test fixtures like `s1`) are returned whole;
 * longer real ids collapse to their last 6 chars. Mirror of the VS Code
 * `shortSessionId` (packages/vscode/src/client/sessionName.ts) — keep in sync.
 */
export function shortSessionId(id: string): string {
  return id.length <= 8 ? id : id.slice(-6)
}

/** The display-fields subset `sessionDisplayName` reads. */
export interface SessionNameFields {
  id: string
  kind: string
  label?: string
  title?: string
  renamedByUser?: boolean
  adapterSlug?: string
}

/**
 * The ONE precedence the daemon and every client resolve a session's
 * human-facing name through. Order:
 *
 *   1. a **user-renamed label** — a `label` a human wrote via `session_rename`,
 *      flagged `renamedByUser`. A deliberate rename always wins.
 *   2. the derived **title** — the first sentence of the caller's ask
 *      (`deriveSessionTitle`). This now OUTRANKS a spawn label, fixing the
 *      shadowing where a slug ("auto-title-precedence-fix") hid the useful
 *      title forever.
 *   3. the spawn **label** — a spawner-supplied slug, shown only when there's
 *      no derived title to prefer.
 *   4. `<adapterSlug ?? kind> · <short id>` — a friendly fallback, never a bare
 *      `sess_…` handle or raw argv.
 *
 * Back-compat: a session persisted before `renamedByUser` existed carries a
 * `label` and NO flag. The pre-flag rename write-path also targeted `label`,
 * so an old spawn slug and an old user rename are indistinguishable on disk —
 * an absent flag on a labelled session is therefore treated as "user-renamed"
 * so no prior rename is lost. Only NEW spawns (which stamp `renamedByUser:
 * false`) let the derived title win over their label.
 *
 * The VS Code mirror (`sessionName.ts`) hand-copies this chain — keep both in
 * sync.
 */
export function sessionDisplayName(session: SessionNameFields): string {
  const userRenamed = session.renamedByUser ?? session.label !== undefined
  if (userRenamed && session.label !== undefined) return session.label
  if (session.title !== undefined) return session.title
  if (session.label !== undefined) return session.label
  return `${session.adapterSlug ?? session.kind} · ${shortSessionId(session.id)}`
}
