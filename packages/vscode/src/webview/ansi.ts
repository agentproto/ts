/**
 * ANSI (SGR) → safe HTML, for raw-mode transcript lines.
 *
 * Why this exists: the daemon's `/stream` lines and `/preview` lines are NOT
 * plain text — `projectEvent` (runtime/src/sessions.ts:1392) deliberately
 * authors them pre-colored, e.g.
 *   `\x1b[36m[tool] Read src/foo.ts\x1b[0m`
 *   `\x1b[2m[thought] …\x1b[0m`
 *   `\x1b[31m[tool-error] …\x1b[0m`
 * because they're meant for a terminal. Raw mode fed them through
 * `renderMarkdown` (which HTML-escapes but never interprets ESC) and through
 * `.textContent` on the live path — so the escape codes rendered as literal
 * garbage in both. This turns them into styled spans instead.
 *
 * Runs on the HOST, never in the webview: the webview's safety contract is
 * that it only ever assigns already-escaped HTML and never parses daemon
 * content. So `escapeHtml` is applied to every text run BEFORE any markup is
 * added here, and the webview just assigns the result.
 *
 * Scope, deliberately narrow: the SGR subset the daemon actually emits (reset,
 * bold, dim, italic, underline, the 8+8 foreground colors, and 8 background
 * colors), mapped onto VS Code's own terminal theme tokens so it matches the
 * user's theme in both light and dark. Every OTHER escape sequence — cursor
 * movement, alt-screen, OSC titles, anything a stray PTY byte might carry — is
 * STRIPPED, not rendered. This is not a terminal emulator: a real TUI belongs
 * in the Pseudoterminal-backed terminal view, which renders bytes natively.
 */

/** VS Code terminal theme tokens — these track the user's theme. */
const FG: Readonly<Record<number, string>> = {
  30: "terminal.ansiBlack",
  31: "terminal.ansiRed",
  32: "terminal.ansiGreen",
  33: "terminal.ansiYellow",
  34: "terminal.ansiBlue",
  35: "terminal.ansiMagenta",
  36: "terminal.ansiCyan",
  37: "terminal.ansiWhite",
  90: "terminal.ansiBrightBlack",
  91: "terminal.ansiBrightRed",
  92: "terminal.ansiBrightGreen",
  93: "terminal.ansiBrightYellow",
  94: "terminal.ansiBrightBlue",
  95: "terminal.ansiBrightMagenta",
  96: "terminal.ansiBrightCyan",
  97: "terminal.ansiBrightWhite",
}

const BG: Readonly<Record<number, string>> = {
  40: "terminal.ansiBlack",
  41: "terminal.ansiRed",
  42: "terminal.ansiGreen",
  43: "terminal.ansiYellow",
  44: "terminal.ansiBlue",
  45: "terminal.ansiMagenta",
  46: "terminal.ansiCyan",
  47: "terminal.ansiWhite",
}

interface SgrState {
  fg?: string
  bg?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

function emptyState(): SgrState {
  return { bold: false, dim: false, italic: false, underline: false }
}

function isStyled(s: SgrState): boolean {
  return Boolean(s.fg || s.bg || s.bold || s.dim || s.italic || s.underline)
}

/** Inline style for the current SGR state, using VS Code theme vars. */
function styleFor(s: SgrState): string {
  const parts: string[] = []
  if (s.fg) parts.push(`color:var(--vscode-${s.fg.replace(/\./g, "-")})`)
  if (s.bg) parts.push(`background-color:var(--vscode-${s.bg.replace(/\./g, "-")})`)
  if (s.bold) parts.push("font-weight:bold")
  // Dim is the daemon's most-used code ([thought], [tool-result]); opacity
  // reads closer to a terminal's faint than a theme color swap would.
  if (s.dim) parts.push("opacity:0.7")
  if (s.italic) parts.push("font-style:italic")
  if (s.underline) parts.push("text-decoration:underline")
  return parts.join(";")
}

/** Apply one SGR parameter list to the running state. */
function applySgr(state: SgrState, params: number[]): void {
  // A bare `ESC[m` means `ESC[0m`.
  const codes = params.length === 0 ? [0] : params
  for (const code of codes) {
    if (code === 0) {
      const fresh = emptyState()
      state.fg = fresh.fg
      state.bg = fresh.bg
      state.bold = false
      state.dim = false
      state.italic = false
      state.underline = false
      continue
    }
    if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4) state.underline = true
    else if (code === 22) {
      state.bold = false
      state.dim = false
    } else if (code === 23) state.italic = false
    else if (code === 24) state.underline = false
    else if (code === 39) state.fg = undefined
    else if (code === 49) state.bg = undefined
    else if (FG[code]) state.fg = FG[code]
    else if (BG[code]) state.bg = BG[code]
    // Unknown SGR (256-color/truecolor sequences, anything else) — ignored
    // rather than guessed at. The daemon never emits them.
  }
}

/**
 * Matches ANY escape sequence, so unsupported ones can be dropped rather than
 * leaked as literal text:
 *   - CSI  `ESC [ … final`   (SGR is the `m` final; everything else stripped)
 *   - OSC  `ESC ] … BEL|ST`  (window titles etc.)
 *   - two-char `ESC <char>`  (e.g. `ESC c` reset)
 */
const ESCAPE_RE = /\x1b(?:\[([0-9;?]*)([ -/]*[@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g

/**
 * Convert a line of possibly-ANSI text to safe HTML.
 *
 * `escapeHtml` is applied to every literal text run before markup is added, so
 * the result is safe to assign to innerHTML. Unsupported escape sequences are
 * dropped. A line with no ANSI at all comes back as plain escaped text with no
 * wrapper — the common case stays cheap.
 */
export function ansiToHtml(text: string, escapeHtml: (s: string) => string): string {
  if (!text.includes("\x1b")) return escapeHtml(text)

  const state = emptyState()
  let html = ""
  let lastIndex = 0
  let open = false

  const closeSpan = (): void => {
    if (open) {
      html += "</span>"
      open = false
    }
  }
  const writeRun = (run: string): void => {
    if (!run) return
    const style = isStyled(state) ? styleFor(state) : ""
    if (style) {
      html += `<span style="${style}">${escapeHtml(run)}</span>`
    } else {
      html += escapeHtml(run)
    }
  }

  ESCAPE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ESCAPE_RE.exec(text)) !== null) {
    writeRun(text.slice(lastIndex, match.index))
    lastIndex = ESCAPE_RE.lastIndex
    const params = match[1]
    const final = match[2]
    // Only SGR (`m`) changes styling; every other sequence is dropped.
    if (final === "m" && params !== undefined) {
      applySgr(
        state,
        params
          .split(";")
          .filter(p => p !== "")
          .map(p => Number.parseInt(p, 10))
          .filter(n => Number.isFinite(n)),
      )
    }
  }
  writeRun(text.slice(lastIndex))
  closeSpan()
  return html
}

/** Strip every escape sequence, leaving plain text. For tooltips/logs. */
export function stripAnsi(text: string): string {
  if (!text.includes("\x1b")) return text
  ESCAPE_RE.lastIndex = 0
  return text.replace(ESCAPE_RE, "")
}
