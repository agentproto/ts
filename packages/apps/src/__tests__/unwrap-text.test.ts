/**
 * The inline panels peel `app_tool_call`'s nested envelopes with an embedded
 * `unwrapText`. The daemon's result-cap marker must come out of it as a
 * thrown error, never as data: a marker read as data is what made the
 * config Models section, the ops panel and the mail-triage dashboard render
 * an empty list. Each test pulls the function out of the RENDERED panel HTML,
 * so it exercises exactly what the browser runs.
 */

import { describe, expect, it } from "vitest"
import { CONFIG_HTML } from "../config/ui.js"
import { MAIL_TRIAGE_HTML } from "../mail-triage/ui.js"
import { MEDIA_VIEWER_HTML } from "../media-viewer/ui.js"
import { OPS_PANEL_HTML } from "../ops-panel/ui.js"
import { SESSION_VIEWER_HTML } from "../session-viewer/ui.js"

const PANELS: Record<string, string> = {
  config: CONFIG_HTML,
  "mail-triage": MAIL_TRIAGE_HTML,
  "media-viewer": MEDIA_VIEWER_HTML,
  "ops-panel": OPS_PANEL_HTML,
  "session-viewer": SESSION_VIEWER_HTML,
}

/** The panel's `unwrapText`, compiled out of its page script. */
function embeddedUnwrapText(html: string): (result: unknown) => unknown {
  const start = html.search(/var unwrapText = |function unwrapText\(/)
  expect(start).toBeGreaterThan(-1)
  const open = html.indexOf("{", start)
  let depth = 0
  let end = open
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++
    else if (html[end] === "}" && --depth === 0) break
  }
  return new Function(`${html.slice(start, end + 1)}; return unwrapText;`)() as (result: unknown) => unknown
}

const marker = { truncated: true, totalBytes: 104_812, hint: "use limit/cursor/fields" }
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] })

describe.each(Object.entries(PANELS))("panel %s unwrapText", (_name, html) => {
  const unwrapText = embeddedUnwrapText(html)

  it("throws on the error-form marker nested inside app_tool_call's shell", () => {
    // app_tool_call (runtime/src/app-tools.ts) returns the inner envelope
    // JSON-stringified in a successful text result.
    const inner = { content: [{ type: "text", text: JSON.stringify(marker) }], isError: true }
    expect(() => unwrapText(text(inner))).toThrow(/truncated.*104812 bytes/)
  })

  it("throws on the successful marker an older daemon sent", () => {
    expect(() => unwrapText(text(text(marker)))).toThrow(/truncated.*104812 bytes/)
  })

  it("still peels a normal nested result and keeps a plain error text as a string", () => {
    expect(unwrapText(text(text({ routes: [1, 2] })))).toEqual({ routes: [1, 2] })
    const failed = { content: [{ type: "text", text: "unknown daemon tool: config_get" }], isError: true }
    expect(unwrapText(text(failed))).toBe("unknown daemon tool: config_get")
    const partial = { items: [1], total: 9, truncated: true, nextCursor: "c" }
    expect(unwrapText(text(text(partial)))).toEqual(partial)
  })
})
