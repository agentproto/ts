/**
 * Derives a short human-readable title from a session's first prompt, for
 * UI surfaces (sessions tree, transcript tab) that would otherwise show the
 * adapter's argv or a raw session id. See `deriveSessionTitle` below.
 */

const MAX_LENGTH = 60

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
 * (never `""`) when nothing usable survives, so the caller's
 * `label ?? title ?? command` chain falls through to `command`.
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
