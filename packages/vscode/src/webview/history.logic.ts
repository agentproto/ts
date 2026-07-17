/**
 * Pure logic for the composer's prompt history (↑/↓) — no `vscode` import,
 * so the recall reducer is unit-testable without a webview.
 *
 * Both exports here are injected BY VALUE into the webview's inline script
 * (see `transcriptPanel.ts`'s `injectedHelpers` — the script has no import
 * mechanism, only `.toString()`), so neither may reference anything outside
 * its own function body: no shared module-level constants, no calls to
 * other helpers in this file. That is why the 100-entry cap below is
 * inlined as a literal instead of a named constant.
 */

/** oldest → newest. `index: null` means "not currently navigating" —
 *  typing (or sending) exits navigation back to this state. `draft` is
 *  the text that was in the box when navigation started, restored when
 *  ↓ steps past the newest entry. */
export interface PromptHistoryState {
  entries: string[]
  index: number | null
  draft: string
}

/**
 * Step the history cursor and return the text to paint into the composer,
 * or null when the key press should fall through to normal caret movement
 * (the caller only calls this once the caret rule already says to recall —
 * see the keydown wiring in transcriptPanel.ts — so null here specifically
 * means "there is nothing further to recall in this direction").
 *
 * "prev" (↑): from `index: null`, saves `current` as the draft and jumps to
 * the newest entry. From an index, steps one older. At the oldest entry,
 * returns null rather than wrapping — wrapping would make it impossible to
 * tell you've hit the end.
 *
 * "next" (↓): steps one newer. Stepping past the newest entry restores the
 * saved draft and exits navigation (`index: null`). From `index: null`
 * (not navigating), returns null — there is nothing to step forward from.
 */
export function recallHistory(
  state: PromptHistoryState,
  direction: "prev" | "next",
  current: string,
): { state: PromptHistoryState; value: string } | null {
  if (direction === "prev") {
    if (state.index === null) {
      if (state.entries.length === 0) return null
      const index = state.entries.length - 1
      return { state: { ...state, index, draft: current }, value: state.entries[index]! }
    }
    if (state.index === 0) return null
    const index = state.index - 1
    return { state: { ...state, index }, value: state.entries[index]! }
  }
  if (state.index === null) return null
  const index = state.index + 1
  if (index >= state.entries.length) {
    return { state: { ...state, index: null }, value: state.draft }
  }
  return { state: { ...state, index }, value: state.entries[index]! }
}

/**
 * Append a just-sent prompt, ready for the next ↑. Skips a consecutive
 * duplicate (re-sending the same thing twice shouldn't need two ↑ to get
 * past it) and caps at 100 entries, dropping the oldest. Always resets
 * navigation — a real send always ends whatever ↑/↓ browsing was underway.
 */
export function pushHistoryEntry(state: PromptHistoryState, prompt: string): PromptHistoryState {
  if (!prompt) return { ...state, index: null, draft: "" }
  const last = state.entries[state.entries.length - 1]
  if (last === prompt) return { ...state, index: null, draft: "" }
  const entries =
    state.entries.length >= 100 ? [...state.entries.slice(1), prompt] : [...state.entries, prompt]
  return { entries, index: null, draft: "" }
}
