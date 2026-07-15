/**
 * Pure line-editor logic for the agent-cli Pseudoterminal's input box. This
 * session shape has no PTY anywhere (see terminalSwitch.logic.ts's
 * `notPtyMessage` doc), so nothing echoes keystrokes back — this hand-rolls
 * just enough state to feel like a normal prompt: buffer + backspace +
 * Enter-to-submit. A full readline (history, cursor movement, arrow-key
 * escape sequences) is explicitly out of scope per the WP5 brief's
 * STOP-if-fork list — arrow keys etc. fall through as inert printable bytes,
 * a deliberate, documented rough edge rather than a bug.
 */

export interface LineEditorState {
  readonly buffer: string
}

export interface LineEditorResult {
  state: LineEditorState
  /** Bytes to write back to the terminal so the user sees what they typed. */
  echo: string
  /** Present when Enter was pressed — the submitted line (state.buffer resets to ""). */
  submit?: string
}

export function createLineEditorState(): LineEditorState {
  return { buffer: "" }
}

const BACKSPACE_CHARS = new Set(["\x7f", "\b"])

/** Feed one raw `handleInput()` chunk through the editor. Paste (multi-char chunks) is supported. */
export function feedLineEditor(state: LineEditorState, data: string): LineEditorResult {
  let buffer = state.buffer
  let echo = ""
  let submit: string | undefined

  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      submit = buffer
      buffer = ""
      echo += "\r\n"
      continue
    }
    if (BACKSPACE_CHARS.has(ch)) {
      if (buffer.length > 0) {
        // Pop a whole code point, not a UTF-16 code unit — `.slice(0, -1)`
        // would split a surrogate pair (e.g. an emoji) and leave a dangling
        // half rendering as U+FFFD.
        const codePoints = Array.from(buffer)
        codePoints.pop()
        buffer = codePoints.join("")
        echo += "\b \b"
      }
      continue
    }
    // Other control bytes (Tab, Ctrl-*, the ESC lead-in of an arrow-key
    // sequence, …) are dropped rather than inserted — see the module doc.
    if (ch < " ") continue
    buffer += ch
    echo += ch
  }

  return submit === undefined
    ? { state: { buffer }, echo }
    : { state: { buffer }, echo, submit }
}
