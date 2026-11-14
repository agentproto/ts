/**
 * The approval card page is what a human reads in "card" mode: a mail
 * preview renders as an email, any other preview as a clean label/value
 * list, everything from an approval is written as text (never markup), and
 * errors map to plain copy. The page renders client-side, so these tests run
 * its script against a fake DOM fed by the real `approval_card_list` tool.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { humanizeApprovalError, renderApprovalCardHtml } from "../approvals/card.js"
import { connectCards, FakeNode, runCardPage } from "./helpers/approvals-card-page.js"

let home: string
let engine: ApprovalsEngine
let closeCards: (() => Promise<void>) | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-render-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(async () => {
  await closeCards?.()
  closeCards = undefined
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** Creates the approval, runs its card page, and returns the rendered card. */
async function render(preview: unknown, title = "Send this email") {
  const id = engine.request({ kind: "send", title, preview, payload: { x: 1 } }, { sessionId: "sess_abc" }).id
  const host = await connectCards(engine)
  closeCards = host.close
  const page = runCardPage(renderApprovalCardHtml(id), { callTool: host.callTool })
  await page.flush()
  const card = page.cards()[0]!
  const rows = (cls: string) => card.findAll(n => n.tag === "dl" && n.className === cls)[0]
  const pairs = (dl: FakeNode | undefined) => {
    const out: Array<[string, string]> = []
    const kids = dl?.children ?? []
    for (let i = 0; i + 1 < kids.length; i += 2) out.push([kids[i]!.textContent, kids[i + 1]!.textContent])
    return out
  }
  return { page, card, id, rows, pairs, text: card.textContent }
}

describe("readable approval card", () => {
  it("renders a mail preview as an email, without a JSON dump", async () => {
    const { rows, pairs, card, text } = await render({
      kind: "mail",
      to: ["ana@example.com"],
      cc: [],
      subject: "Invoice for October",
      body: "Hello,\nPlease find the invoice attached.",
      attachments: [{ fileName: "invoice.pdf", sizeBytes: 2048 }],
    })
    expect(pairs(rows("mail"))).toEqual([
      ["To", "ana@example.com"],
      ["Subject", "Invoice for October"],
    ])
    expect(card.findAll(n => n.className === "body")[0]!.textContent).toBe("Hello,\nPlease find the invoice attached.")
    expect(card.findAll(n => n.tag === "li").map(n => n.textContent)).toEqual(["invoice.pdf (2 KB)"])
    expect(text).not.toContain("Cc")
    expect(text).not.toContain("{")
  })

  it("shows Cc only when it has recipients", async () => {
    const { rows, pairs } = await render({ kind: "mail", to: "a@x.io", cc: ["b@x.io"], subject: "s", body: "b" })
    expect(pairs(rows("mail")).map(([k]) => k)).toEqual(["To", "Cc", "Subject"])
  })

  it("writes an injection attempt in the subject and the title as plain text, never as nodes", async () => {
    const attack = `<img src=x onerror=alert(1)><script>alert(2)</script>`
    const { card, pairs, rows, page } = await render({ kind: "mail", to: "a@x.io", subject: attack, body: attack }, attack)
    expect(page.titleOf(card)).toBe(attack)
    expect(pairs(rows("mail")).find(([k]) => k === "Subject")![1]).toBe(attack)
    const tags = new Set(card.findAll(() => true).map(n => n.tag))
    expect(tags.has("img")).toBe(false)
    expect(tags.has("script")).toBe(false)
  })

  it("renders other previews as a humanized label/value list with nested values flattened", async () => {
    const { rows, pairs, text } = await render({
      invoiceNumber: "F-42",
      sent_to: "ana@example.com",
      amount: { value: 12, currency: "EUR" },
      tags: ["a", "b"],
      urgent: true,
      nothing: null,
    })
    expect(pairs(rows("list"))).toEqual([
      ["Invoice number", "F-42"],
      ["Sent to", "ana@example.com"],
      ["Amount / Value", "12"],
      ["Amount / Currency", "EUR"],
      ["Tags", "a, b"],
      ["Urgent", "Yes"],
    ])
    expect(text).not.toContain("Nothing")
    expect(text).not.toContain("{")
  })

  it("writes label/value pairs from untrusted previews as text", async () => {
    const { rows, pairs, card } = await render({ "<b>k</b>": "<i>v</i>" })
    expect(pairs(rows("list"))).toEqual([["<b>k</b>", "<i>v</i>"]])
    const tags = new Set(card.findAll(() => true).map(n => n.tag))
    expect(tags.has("b")).toBe(false)
    expect(tags.has("i")).toBe(false)
  })

  it("a long value carries its full text in the tooltip and a hidden span; a short one stays plain", async () => {
    const long = "x".repeat(120)
    const { rows } = await render({ note: long, short: "ok" })
    const dds = rows("list")!.children.filter(n => n.tag === "dd")
    expect(dds[0]!.getAttribute("title")).toBe(long)
    expect(dds[0]!.children.map(c => [c.className, c.textContent])).toEqual([
      ["", long],
      ["sr-only", long],
    ])
    expect(dds[0]!.children[0]!.getAttribute("aria-hidden")).toBe("true")
    expect(dds[1]!.getAttribute("title")).toBeNull()
    expect(dds[1]!.textContent).toBe("ok")
  })

  it("a script-breaking approval id cannot close the inline script", () => {
    const html = renderApprovalCardHtml("</script><b>x")
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain("\\u003c/script>")
  })

  it("has no ticket or approval text in the HTML, and never uses innerHTML", () => {
    const html = renderApprovalCardHtml("apr_1")
    expect(html).not.toContain("innerHTML")
    expect(html).not.toContain("var TICKET")
  })
})

describe("humanizeApprovalError", () => {
  const FORBIDDEN = /ticket|agentproto|daemon|session|mcp|_|:|—/i

  it.each([
    ["ticket_invalid: expired", "This card was refreshed. Click again to decide."],
    ["ticket_invalid: used", "This card was refreshed. Click again to decide."],
    ["ticket_invalid: mismatch", "This card was refreshed. Click again to decide."],
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
