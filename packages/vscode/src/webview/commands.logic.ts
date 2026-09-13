/**
 * Pure logic for the `/`-command popup — no `vscode` import, so caret
 * detection and filtering are unit-testable without a webview.
 *
 * Unlike `@file` mentions (mentions.logic.ts), a slash command only opens at
 * the very START of the composer (position 0) — mid-message `/` is just a
 * character, not a trigger. The trigger closes the instant the user types
 * past the command name (a space), since a command's arguments aren't part
 * of the name being filtered.
 */

/**
 * Find the active `/`-token when the caret sits inside the leading command
 * name (no whitespace yet typed between `/` and the caret). Returns the query
 * (text after `/`) and the token's [start,end) so a selection can replace
 * exactly it. Null when the input doesn't start with `/`, or the caret has
 * moved past the command name into its arguments.
 */
export function commandQueryAt(
  text: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  if (caret <= 0 || caret > text.length) return null
  if (text.charAt(0) !== "/") return null
  for (let i = 1; i < caret; i++) {
    if (/\s/.test(text[i]!)) return null
  }
  return { query: text.slice(1, caret), start: 0, end: caret }
}

/** End index (exclusive) of the leading `/command` token — up to the first
 *  whitespace, or the end of the string. Used to park the caret there when
 *  the `[/]` button opens the popup on an already-`/`-prefixed input. */
export function leadingCommandEnd(text: string): number {
  let i = 1
  while (i < text.length && !/\s/.test(text[i]!)) i++
  return i
}

export interface CommandCandidate {
  /** Bare name inserted after `/` (e.g. "plan" for "/plan"). */
  name: string
  description?: string
}

/**
 * Filter+rank commands against a query. Empty query returns every command
 * as-is. A match is scored so the most obvious hits float up: name-prefix
 * beats name-substring; ties break on the shorter name then lexically.
 */
export function filterCommands(
  commands: readonly CommandCandidate[],
  query: string,
): CommandCandidate[] {
  const q = query.toLowerCase()
  if (q.length === 0) return commands.slice()
  const scored: Array<{ c: CommandCandidate; score: number }> = []
  for (const c of commands) {
    const name = c.name.toLowerCase()
    let score: number
    if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else continue
    scored.push({ c, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.c.name.length !== b.c.name.length) return a.c.name.length - b.c.name.length
    return a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0
  })
  return scored.map(s => s.c)
}
