/**
 * Guards the embedded <script> of every ui:// panel against two silent-blank
 * failure classes that reached production:
 *
 * 1. Handshake shape — MCP Apps spec 2026-01-26 requires `appInfo` in
 *    ui/initialize params (ext-apps McpUiInitializeRequestSchema). A panel
 *    sending `clientInfo` instead is rejected/dropped by the host: the
 *    iframe renders but stays empty, with no error surfaced anywhere.
 *
 * 2. Template-literal escape eating — the panels are authored as TS template
 *    literals, so `\n`, `\r`, `\'`, `\[` written inside them are consumed at
 *    string creation and the emitted HTML carries the raw character. A raw
 *    newline inside a regex literal (or a broken quote) is a SyntaxError in
 *    the browser: the whole panel script dies before the first statement —
 *    again a blank panel with no error. Escapes must be doubled (`\\n`).
 *    `new Function(js)` compiles (without executing) and catches this.
 */

import { describe, it, expect } from "vitest"
import { PANEL_HTML } from "../sessions-panel.js"
import { SESSION_STORY_PANEL_HTML } from "../session-story-panel.js"
import { BUREAU_SESSIONS_HTML } from "../bureau-sessions-app.js"
import { AGENTS_OVERVIEW_HTML } from "../agents-overview-app.js"

const PANELS: Record<string, string> = {
  "sessions-panel": PANEL_HTML,
  "session-story-panel": SESSION_STORY_PANEL_HTML,
  "bureau-sessions": BUREAU_SESSIONS_HTML,
  "agents-overview": AGENTS_OVERVIEW_HTML,
}

function extractScript(html: string): string {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] ?? "",
  )
  expect(blocks.length).toBeGreaterThan(0)
  return blocks.join("\n")
}

describe.each(Object.entries(PANELS))("panel %s", (_name, html) => {
  const js = extractScript(html)

  it("embeds valid JavaScript (no template-eaten escapes)", () => {
    // Compiles the script without running it — throws on SyntaxError.
    expect(() => new Function(js)).not.toThrow()
  })

  it("sends a spec-correct ui/initialize handshake", () => {
    expect(js).toContain("ui/initialize")
    expect(js).toContain("appInfo")
    // The pre-fix bridges sent `clientInfo`, which hosts reject.
    expect(js).not.toContain("clientInfo")
    // Exactly one bridge copy — the shared panel-bridge.ts one.
    expect(js.match(/function initBridge/g)).toHaveLength(1)
  })

  it("wires the display-mode toggle (fullscreen/pip)", () => {
    // The app must advertise all three modes, else the host never offers them.
    expect(js).toContain("['inline', 'fullscreen', 'pip']")
    expect(js).toContain("ui/request-display-mode")
    // Host context plumbing feeding syncBtn.
    expect(js).toContain("ui/notifications/host-context-changed")
    expect(js).toContain("availableDisplayModes")
    // The two injected buttons (same ids as guilde's canvas reference).
    expect(js).toContain("'dm'")
    expect(js).toContain("'pin'")
  })

  if (_name === "session-story-panel") {
    it("renders feed/transcript text through the markdown renderer, not raw esc()", () => {
      // Regression guard: assistant/tool text is Markdown. Before the fix it
      // was injected via esc(it.text) — raw `## `/`**bold**`/`|table|` showed
      // up literally in the panel instead of rendered HTML.
      expect(js).toContain("function renderMd(")
      expect(js).toMatch(/'<div class="d-text">'\+renderMd\(it\.text\)\+'<\/div>'/)
      expect(js).not.toMatch(/'<div class="d-text">'\+esc\(it\.text\)/)
    })

    it("wires the full-panel deep-link to the current session on open, opening in a new tab", () => {
      expect(html).toContain('id="fullPanelLink"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener"')
      expect(js).toContain(
        "$('fullPanelLink').href='https://cli.agentproto.sh/panel?session='+encodeURIComponent(id);",
      )
    })
  }
})
