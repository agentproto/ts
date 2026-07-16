/**
 * Pure logic for `@file` mentions — no `vscode` import, so the query detection
 * and the candidate ranking are unit-testable without a webview or a live repo.
 *
 * The mention list is scoped to the SESSION's cwd, not the editor window
 * (`vscode.workspace.findFiles` is window-scoped and can point at a different
 * root than the session runs in). The host lists files with `git ls-files`
 * there, which honors `.gitignore` for free; these helpers only parse and rank.
 */

/**
 * Find the active `@`-token the caret is sitting in, so typing `@src/fo|` opens
 * a filtered list. Scans back from the caret to an `@` that is either at the
 * start or preceded by whitespace, with no whitespace between it and the caret.
 * Returns the query (text after `@`) and the token's [start,end) so a selection
 * can replace exactly it. Null when the caret isn't in a mention.
 */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (ch === "@") {
      const before = i > 0 ? text[i - 1]! : ""
      // An `@` only opens a mention at the very start or after whitespace —
      // not the `@` inside an email or a path fragment.
      if (i === 0 || /\s/.test(before)) {
        return { query: text.slice(i + 1, caret), start: i, end: caret }
      }
      return null
    }
    // Whitespace before hitting an `@` means the caret isn't in a mention token.
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export interface MentionCandidate {
  /** Absolute path inserted into the composer (the agent reads this). */
  path: string
  /** Repo-relative path shown in the popup. */
  label: string
}

/**
 * Rank repo-relative paths against a query and cap the result. Empty query
 * returns the first `cap` paths as-is (the initial list). A match is scored so
 * the most obvious hits float up: basename-prefix beats basename-substring
 * beats full-path-substring; ties break on the shorter path (closer to root)
 * then lexically for stability.
 */
export function filterMentionCandidates(
  relPaths: readonly string[],
  query: string,
  cap: number,
): string[] {
  const q = query.toLowerCase()
  if (q.length === 0) return relPaths.slice(0, cap)
  const scored: Array<{ rel: string; score: number }> = []
  for (const rel of relPaths) {
    const lower = rel.toLowerCase()
    const base = lower.split("/").pop() ?? lower
    let score: number
    if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    else continue
    scored.push({ rel, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  })
  return scored.slice(0, cap).map(s => s.rel)
}

/** Split `git ls-files` (newline-separated) into clean relative paths. NUL is
 *  tolerated too so a `-z` invocation parses, but the default newline form is
 *  the common case. */
export function parseFileList(stdout: string): string[] {
  return stdout
    .split(/\r?\n|\0/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
}
