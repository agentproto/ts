import { describe, expect, it } from "vitest"

import { ansiToHtml, stripAnsi } from "./ansi.js"
import { escapeHtml } from "./markdown.js"

/** The real host escaper, so these tests exercise the shipped pairing. */
const html = (s: string): string => ansiToHtml(s, escapeHtml)

describe("ansiToHtml — the lines the daemon actually emits", () => {
  // Verbatim shapes from projectEvent (runtime/src/sessions.ts:1392+).
  it("renders a [tool] line's cyan as a themed span, not literal escape codes", () => {
    const out = html("\x1b[36m[tool] Read src/foo.ts\x1b[0m")
    expect(out).toBe(
      '<span style="color:var(--vscode-terminal-ansiCyan)">[tool] Read src/foo.ts</span>',
    )
    expect(out).not.toContain("\x1b")
    expect(out).not.toContain("[36m")
  })

  it("renders a [thought] line's dim as opacity", () => {
    expect(html("\x1b[2m[thought] hmm\x1b[0m")).toBe(
      '<span style="opacity:0.7">[thought] hmm</span>',
    )
  })

  it("renders a [tool-error] line's red", () => {
    expect(html("\x1b[31m[tool-error] boom\x1b[0m")).toBe(
      '<span style="color:var(--vscode-terminal-ansiRed)">[tool-error] boom</span>',
    )
  })

  it("renders a [permission] line's yellow", () => {
    expect(html("\x1b[33m[permission] Bash\x1b[0m")).toBe(
      '<span style="color:var(--vscode-terminal-ansiYellow)">[permission] Bash</span>',
    )
  })
})

describe("ansiToHtml — safety", () => {
  it("escapes HTML in the text, styled or not", () => {
    expect(html("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    )
    expect(html("\x1b[31m<img onerror=x>\x1b[0m")).toBe(
      '<span style="color:var(--vscode-terminal-ansiRed)">&lt;img onerror=x&gt;</span>',
    )
  })

  it("escapes a quote that would otherwise break out of the style attribute", () => {
    // The text run is escaped, never interpolated raw next to the attribute.
    expect(html('\x1b[31m"><b>x\x1b[0m')).not.toContain('"><b>')
  })

  it("never emits a raw ESC byte, whatever comes in", () => {
    const nasty = "\x1b[36mok\x1b[2J\x1b[1;1H\x1b]0;title\x07done\x1b[0m"
    const out = html(nasty)
    expect(out).not.toContain("\x1b")
  })
})

describe("ansiToHtml — unsupported sequences are dropped, not leaked", () => {
  it("strips cursor movement and screen clears (a stray PTY byte)", () => {
    // This is not a terminal emulator — a real TUI belongs in the terminal view.
    expect(html("\x1b[2J\x1b[1;1Hhello")).toBe("hello")
  })

  it("strips an OSC window-title sequence", () => {
    expect(html("\x1b]0;my title\x07after")).toBe("after")
  })

  it("ignores an unknown SGR code rather than guessing", () => {
    // 256-color: ESC[38;5;n m — the daemon never emits it.
    expect(html("\x1b[38;5;208mtext\x1b[0m")).toBe("text")
  })
})

describe("ansiToHtml — state machine", () => {
  it("leaves plain text untouched (the cheap common path)", () => {
    expect(html("just text")).toBe("just text")
    expect(html("")).toBe("")
  })

  it("carries style across an unstyled run and resets on 0m", () => {
    expect(html("plain \x1b[36mcyan\x1b[0m plain")).toBe(
      'plain <span style="color:var(--vscode-terminal-ansiCyan)">cyan</span> plain',
    )
  })

  it("combines attributes and colors in one span", () => {
    expect(html("\x1b[1;31mbold red\x1b[0m")).toBe(
      '<span style="color:var(--vscode-terminal-ansiRed);font-weight:bold">bold red</span>',
    )
  })

  it("treats a bare ESC[m as a reset", () => {
    expect(html("\x1b[36mc\x1b[mplain")).toBe(
      '<span style="color:var(--vscode-terminal-ansiCyan)">c</span>plain',
    )
  })

  it("honours the selective resets (22/23/24/39/49)", () => {
    expect(html("\x1b[1mB\x1b[22mplain")).toBe('<span style="font-weight:bold">B</span>plain')
    expect(html("\x1b[36mc\x1b[39mplain")).toBe(
      '<span style="color:var(--vscode-terminal-ansiCyan)">c</span>plain',
    )
  })

  it("renders a background color", () => {
    expect(html("\x1b[41mred bg\x1b[0m")).toBe(
      '<span style="background-color:var(--vscode-terminal-ansiRed)">red bg</span>',
    )
  })

  it("survives an unterminated sequence at end of line", () => {
    expect(html("text\x1b[36m")).toBe("text")
  })
})

describe("stripAnsi", () => {
  it("removes SGR and leaves the text", () => {
    expect(stripAnsi("\x1b[36m[tool] Read foo\x1b[0m")).toBe("[tool] Read foo")
  })

  it("removes cursor/OSC sequences too", () => {
    expect(stripAnsi("\x1b[2J\x1b]0;t\x07hi")).toBe("hi")
  })

  it("passes plain text through untouched", () => {
    expect(stripAnsi("plain")).toBe("plain")
  })
})
