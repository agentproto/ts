/**
 * The approval card's HTML is what a human reads in "card" mode: a mail
 * preview renders as an email, any other preview as a clean label/value
 * list, untrusted values are escaped, and errors map to plain copy.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { humanizeApprovalError, renderApprovalCardHtml } from "../approvals/card.js"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-render-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

function request(preview: unknown, title = "Send this email"): string {
  return engine.request({ kind: "send", title, preview, payload: { x: 1 } }, { sessionId: "sess_abc" }).id
}

/** Visible markup only: drop the style and script blocks. */
function visible(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, "")
}

describe("readable approval card", () => {
  it("renders a mail preview as an email, without a JSON dump", () => {
    const id = request({
      kind: "mail",
      to: ["ana@example.com"],
      cc: [],
      subject: "Invoice for October",
      body: "Hello,\nPlease find the invoice attached.",
      attachments: [{ fileName: "invoice.pdf", sizeBytes: 2048 }],
    })
    const html = renderApprovalCardHtml(engine, id)
    const page = visible(html)
    expect(page).toContain("ana@example.com")
    expect(page).toContain("Invoice for October")
    expect(page).toContain("Hello,\nPlease find the invoice attached.")
    expect(page).toContain("invoice.pdf (2 KB)")
    expect(page).not.toContain("Cc")
    expect(page).not.toContain("{")
    expect(page).not.toContain("&quot;")
  })

  it("shows Cc only when it has recipients", () => {
    const id = request({ kind: "mail", to: "a@x.io", cc: ["b@x.io"], subject: "s", body: "b" })
    expect(visible(renderApprovalCardHtml(engine, id))).toContain("b@x.io")
  })

  it("escapes an injection attempt in the subject and the title", () => {
    const attack = `<img src=x onerror=alert(1)><script>alert(2)</script>`
    const id = request({ kind: "mail", to: "a@x.io", subject: attack, body: attack }, attack)
    const page = visible(renderApprovalCardHtml(engine, id))
    expect(page).not.toContain("<img")
    expect(page).not.toContain("<script")
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  it("renders other previews as a humanized label/value list with nested values flattened", () => {
    const id = request({
      invoiceNumber: "F-42",
      sent_to: "ana@example.com",
      amount: { value: 12, currency: "EUR" },
      tags: ["a", "b"],
      urgent: true,
      nothing: null,
    })
    const page = visible(renderApprovalCardHtml(engine, id))
    expect(page).toContain("<dt>Invoice number</dt><dd>F-42</dd>")
    expect(page).toContain("<dt>Sent to</dt>")
    expect(page).toContain("<dt>Amount / Value</dt><dd>12</dd>")
    expect(page).toContain("<dt>Amount / Currency</dt><dd>EUR</dd>")
    expect(page).toContain("<dt>Tags</dt><dd>a, b</dd>")
    expect(page).toContain("<dt>Urgent</dt><dd>Yes</dd>")
    expect(page).not.toContain("Nothing")
    expect(page).not.toContain("{")
  })

  it("escapes label/value pairs from untrusted previews", () => {
    const id = request({ "<b>k</b>": "<i>v</i>" })
    const page = visible(renderApprovalCardHtml(engine, id))
    expect(page).not.toContain("<b>")
    expect(page).not.toContain("<i>")
  })

  it("a script-breaking approval id cannot close the inline script", () => {
    const id = request({ a: 1 })
    expect(renderApprovalCardHtml(engine, id)).toContain('var TICKET = "')
  })

  it("an unknown or already decided approval shows the neutral message", () => {
    expect(renderApprovalCardHtml(engine, "missing")).toContain("This request is no longer waiting for a decision.")
    const id = request({ a: 1 })
    const { ticket } = engine.mintCardTicket(id)
    return engine.decideByCard(id, "approve", ticket, { ipAddress: "t", userAgent: "t" }).then(() => {
      const page = visible(renderApprovalCardHtml(engine, id))
      expect(page).toContain("This request is no longer waiting for a decision.")
      expect(page).not.toMatch(/already|approved/i)
    })
  })
})

describe("humanizeApprovalError", () => {
  const FORBIDDEN = /ticket|agentproto|daemon|session|mcp|_|:|—/i

  it.each([
    ["ticket_invalid: expired", "This card has expired. Open it again to decide."],
    ["ticket_invalid: used", "This card has expired. Open it again to decide."],
    ["ticket_invalid: mismatch", "This card has expired. Open it again to decide."],
    ['approval is "approved", not pending', "This request is no longer waiting for a decision."],
    ["no approval apr_123", "This request is no longer waiting for a decision."],
    ["Approval apr_123 was not found.", "This request is no longer waiting for a decision."],
    ["boom: ECONNRESET", "Something went wrong. Try again."],
    ["", "Something went wrong. Try again."],
  ])("maps %j", (raw, expected) => {
    const out = humanizeApprovalError(new Error(raw))
    expect(out).toBe(expected)
    expect(out).not.toMatch(FORBIDDEN)
  })

  it("never echoes an unknown value", () => {
    expect(humanizeApprovalError({ code: "secret_code" })).toBe("Something went wrong. Try again.")
  })
})
