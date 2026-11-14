/**
 * The text of a Telegram approval card, as Telegram HTML (`parse_mode: HTML`).
 *
 * Everything that comes from the approval is escaped. Markdown in a summary,
 * a section or a field (headings, bold, code, links, tables) is turned into
 * the matching HTML or dropped, so no raw `#`, `**` or pipe table reaches the
 * reader.
 *
 * The card is a summary: Telegram caps a message at 4096 characters, and the
 * full text lives on the approval page (the "Voir" button). When a text does
 * not fit, it is cut on a line or word boundary and the cut is announced right
 * there with the number of characters left out. Nothing is cut silently.
 */

import type { ApprovalRecord } from "./types.js"

// Telegram rejects text over 4096 characters (counted after the HTML is
// parsed). The body leaves room for the outcome line appended on close.
export const MAX_BODY_CHARS = 3800
const MAX_FIELD_CHARS = 3000
// Caps for the `{ summary, sections, links }` preview convention, the same
// ones the session-chat approval page applies.
const MAX_SUMMARY_CHARS = 600
const MAX_TITLE_CHARS = 80
const MAX_CARD_TITLE_CHARS = 300
const MAX_KIND_CHARS = 100
const MAX_SECTIONS = 20
const MAX_LABEL_CHARS = 120
const MAX_LINKS = 20
const MAX_URL_CHARS = 2048
const MAX_LINKS_CHARS = 1200
const MAX_EXTRA_CHARS = 300
const MAX_EXTRAS = 20
// A shorter value is never dropped as a duplicate: "5" occurs inside "Send 15
// invoices", and a field missing from an approval card is worse than a repeat.
const MIN_DEDUPE_CHARS = 20
// Compact card (a preview that carries the convention): a notification, the
// full text lives on the approval page.
export const MAX_COMPACT_CHARS = 1800
const COMPACT_SECTION_CHARS = 280
const COMPACT_MAX_SECTIONS = 5
const COMPACT_EXTRA_VALUE_CHARS = 40
const COMPACT_MAX_EXTRAS = 6
/** Room kept for one cut notice when sharing the card between texts. */
const NOTICE_RESERVE = 90

/** One line of the card's Attachments block. */
export interface AttachmentLine {
  name: string
  /** Set when the file was sent as a Telegram document or photo. */
  sent?: { size: string }
  /** Set when it was not: why. */
  problem?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Bold, inline code and https links of one already-escaped line. A link text
 *  never spans a tag, so the tags produced here are always properly nested. */
function inlineHtml(escaped: string): string {
  return escaped
    .split(/(`[^`\n]+`)/)
    .map(part => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return `<code>${part.slice(1, -1)}</code>`
      return part
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(
          /\[([^\]\n<>]+)\]\((https:\/\/[^\s)<>]+)\)/g,
          (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
        )
    })
    .join("")
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** Markdown or plain text to Telegram HTML. Plain text comes out unchanged
 *  apart from the escaping. */
export function textToHtml(text: string): string {
  const out: string[] = []
  let fence: string[] | undefined
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        if (fence.length > 0) out.push(`<pre>${fence.join("\n")}</pre>`)
        fence = undefined
      } else {
        fence = []
      }
      continue
    }
    if (fence) {
      fence.push(escapeHtml(line))
      continue
    }
    // A table separator or a horizontal rule: layout only.
    if (TABLE_RULE.test(line)) continue
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`<b>${inlineHtml(escapeHtml(heading[1]!.replace(/\*\*/g, "").replace(/\s+#+\s*$/, "")))}</b>`)
      continue
    }
    const row = /^\s*\|(.*)\|\s*$/.exec(line)
    const body = row
      ? row[1]!
          .split("|")
          .map(cell => cell.trim())
          .join(" | ")
      : line.replace(/^\s*>\s?/, "").replace(/^(\s*)\*\s+/, "$1- ")
    out.push(inlineHtml(escapeHtml(body)))
  }
  if (fence && fence.length > 0) out.push(`<pre>${fence.join("\n")}</pre>`)
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
}

/** The card as plain text: what is sent when Telegram refuses the HTML. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_, url: string, label: string) =>
      label === url ? url : `${label}: ${url}`,
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

/** Length Telegram counts: the text once the tags are parsed away. */
function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|quot|amp);/g, "x").length
}

interface Cut {
  text: string
  /** Characters of the original left out of `text`. */
  hidden: number
}

/** Keep at most `max` characters, ending on a line or word boundary when one
 *  is close, and never in the middle of a surrogate pair. */
export function cutText(text: string, max: number): Cut {
  if (text.length <= max) return { text, hidden: 0 }
  if (max <= 0) return { text: "", hidden: text.length }
  let end = max
  const floor = Math.floor(max * 0.8)
  const newline = text.lastIndexOf("\n", end)
  const space = text.lastIndexOf(" ", end)
  if (newline >= floor) end = newline
  else if (space >= floor) end = space
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  const kept = text.slice(0, end).replace(/\s+$/, "")
  return { text: kept, hidden: text.length - kept.length }
}

export function cutNoticeText(hidden: number): string {
  return `[cut here: ${hidden} more characters. Full text on the approval page ("Voir").]`
}

function notice(cut: Cut): string {
  return cut.hidden > 0 ? `<i>${escapeHtml(cutNoticeText(cut.hidden))}</i>` : ""
}

/** `text` as HTML, followed by the cut notice when it was cut. */
function cutHtml(cut: Cut, inline = false): string {
  const html = textToHtml(cut.text)
  const mark = notice(cut)
  if (!mark) return html
  return html ? `${html}${inline ? " " : "\n"}${mark}` : mark
}

/** Water-filling split of `budget` over the texts: a short text keeps its
 *  full length, the long ones share what is left equally. */
function splitBudget(lengths: readonly number[], budget: number): number[] {
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length)
  const alloc: number[] = lengths.map(() => 0)
  let left = Math.max(0, budget)
  order.forEach(({ length, index }, i) => {
    const share = Math.floor(left / (order.length - i))
    alloc[index] = Math.min(length, share)
    left -= alloc[index]!
  })
  return alloc
}

/** Share `room` characters between the texts, keeping room for the notice of
 *  each one that has to be cut. */
function fitTexts(texts: readonly string[], room: number): Cut[] {
  const lengths = texts.map(t => t.length)
  let alloc = splitBudget(lengths, room)
  const cuts = lengths.filter((length, i) => length > alloc[i]!).length
  if (cuts > 0) alloc = splitBudget(lengths, room - cuts * NOTICE_RESERVE)
  return texts.map((t, i) => cutText(t, alloc[i]!))
}

interface ConventionSection {
  title: string
  text: string
}

interface ConventionPreview {
  summary: string | undefined
  sections: ConventionSection[]
  links: Array<{ label: string; url: string }>
  /** Links left off the card (over the count or the size allowance). */
  moreLinks: number
  /** Sections past the cap, left to the approval page. */
  moreSections: number
  /** Top-level keys the convention did not consume, rendered as `key: value`. */
  rest: Array<[string, unknown]>
}

function clipLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

/** The `{ summary?, sections?, links? }` convention the approval page renders,
 *  or undefined when the preview carries none of its three keys. */
function readConvention(preview: Record<string, unknown>): ConventionPreview | undefined {
  const summary = typeof preview.summary === "string" ? preview.summary : undefined
  const sectionsRaw = Array.isArray(preview.sections) ? preview.sections : undefined
  const linksRaw = Array.isArray(preview.links) ? preview.links : undefined
  if (summary === undefined && !sectionsRaw && !linksRaw) return undefined

  const sections: ConventionSection[] = []
  let moreSections = 0
  for (const item of sectionsRaw ?? []) {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.text !== "string") continue
    if (sections.length >= MAX_SECTIONS) {
      moreSections++
      continue
    }
    sections.push({ title: clipLabel(item.title, MAX_TITLE_CHARS), text: item.text })
  }

  const links: Array<{ label: string; url: string }> = []
  let moreLinks = 0
  let linkChars = 0
  for (const item of linksRaw ?? []) {
    if (!isRecord(item) || typeof item.url !== "string" || item.url.length > MAX_URL_CHARS) continue
    let https = false
    try {
      https = new URL(item.url).protocol === "https:"
    } catch {
      https = false
    }
    if (!https) continue
    const label = clipLabel(
      typeof item.label === "string" && item.label.length > 0 ? item.label : item.url,
      MAX_LABEL_CHARS,
    )
    if (links.length >= MAX_LINKS || linkChars + label.length + item.url.length > MAX_LINKS_CHARS) {
      moreLinks++
      continue
    }
    linkChars += label.length + item.url.length
    links.push({ label, url: item.url })
  }

  const rest = Object.entries(preview).filter(([key]) => {
    if (key === "summary") return summary === undefined
    if (key === "sections") return !sectionsRaw
    if (key === "links") return !linksRaw
    return true
  })
  return { summary, sections, links, moreLinks, moreSections, rest }
}

function linkHtml(link: { label: string; url: string }): string {
  const href = escapeHtml(link.url).replace(/"/g, "&quot;")
  return `<a href="${href}">${escapeHtml(link.label)}</a>`
}

/** The names of files that are on the approval page but were not sent. */
export interface FileNames {
  names: readonly string[]
  /** Names past the cap. */
  more?: number
}

function filesBlock(files: FileNames): string | undefined {
  if (files.names.length === 0) return undefined
  const names = files.names.map(n => escapeHtml(clipLabel(n, MAX_LABEL_CHARS)))
  if (files.more && files.more > 0) names.push(`+${files.more} more`)
  return `Files: ${names.join(", ")} (on the approval page)`
}

function attachmentsBlock(attachments: readonly AttachmentLine[]): string | undefined {
  if (attachments.length === 0) return undefined
  const lines = attachments.map(a =>
    a.sent
      ? `${escapeHtml(a.name)} (${escapeHtml(a.sent.size)}), sent above`
      : `${escapeHtml(a.name)}: <b>NOT attached</b>, ${escapeHtml(a.problem ?? "not sent")}`,
  )
  return `<b>Attachments</b>\n${lines.join("\n")}`
}

function headHtml(record: ApprovalRecord): string {
  const title = clipLabel(record.title, MAX_CARD_TITLE_CHARS)
  return `<b>Approval needed: ${escapeHtml(title)}</b>\nKind: ${escapeHtml(clipLabel(record.kind, MAX_KIND_CHARS))}`
}

function conventionHtml(
  record: ApprovalRecord,
  conv: ConventionPreview,
  attachments: string | undefined,
  tail: string,
  budget: number,
): string {
  const summary = conv.summary ? cutHtml(cutText(conv.summary, MAX_SUMMARY_CHARS)) : undefined
  const seen = [conv.summary ?? "", ...conv.sections.map(s => s.text)]
  const extraParts: string[] = []
  let moreExtras = 0
  for (const [key, value] of conv.rest) {
    if (value === undefined || value === null) continue
    if (typeof value === "string" && value.length >= MIN_DEDUPE_CHARS && seen.some(text => text.includes(value))) continue
    const rendered = renderValue(value)
    if (
      extraParts.length >= COMPACT_MAX_EXTRAS ||
      (typeof value === "string" && value.length > COMPACT_EXTRA_VALUE_CHARS)
    ) {
      moreExtras++
      continue
    }
    extraParts.push(
      `<b>${escapeHtml(clipLabel(key, MAX_LABEL_CHARS))}</b>: ${escapeHtml(clipLabel(rendered, COMPACT_EXTRA_VALUE_CHARS))}`,
    )
  }
  const extras: string[] = []
  if (extraParts.length > 0) extras.push(extraParts.join(" · "))
  if (moreExtras > 0) extras.push(`<i>+${moreExtras} more details on the approval page ("Voir").</i>`)

  const shown = conv.sections.slice(0, COMPACT_MAX_SECTIONS)
  const moreSections = conv.moreSections + (conv.sections.length - shown.length)

  const assemble = (bodies: readonly string[]): string => {
    const blocks: string[] = [headHtml(record)]
    if (summary) blocks.push(summary)
    shown.forEach((section, i) => {
      const title = `<b>${escapeHtml(section.title)}</b>`
      blocks.push(bodies[i] ? `${title}\n${bodies[i]}` : title)
    })
    if (moreSections > 0) {
      blocks.push(`<i>${moreSections} more sections on the approval page ("Voir").</i>`)
    }
    if (conv.links.length > 0 || conv.moreLinks > 0) {
      const lines = conv.links.map(linkHtml)
      if (conv.moreLinks > 0) lines.push(`<i>${conv.moreLinks} more links on the approval page ("Voir").</i>`)
      blocks.push(lines.join("\n"))
    }
    if (extras.length > 0) blocks.push(extras.join("\n"))
    if (attachments) blocks.push(attachments)
    return `${blocks.join("\n\n")}\n${tail}`
  }

  const nonEmpty = shown.filter(sec => sec.text.length > 0).length
  const room = budget - visibleLength(assemble(shown.map(() => ""))) - nonEmpty
  const capped = shown.map(sec => cutText(sec.text, COMPACT_SECTION_CHARS))
  const cuts = fitTexts(
    capped.map(c => c.text),
    room,
  ).map((cut, i) => ({ text: cut.text, hidden: cut.hidden + capped[i]!.hidden }))
  return assemble(cuts.map(cut => cutHtml(cut)))
}

function plainPreviewHtml(
  record: ApprovalRecord,
  preview: unknown,
  attachments: string | undefined,
  tail: string,
  budget: number,
): string {
  const fields: Array<{ key: string | undefined; text: string }> = []
  if (isRecord(preview)) {
    for (const [key, value] of Object.entries(preview)) {
      if (value === undefined || value === null) continue
      fields.push({ key: clipLabel(key, MAX_LABEL_CHARS), text: renderValue(value) })
    }
  } else if (preview !== undefined && preview !== null) {
    fields.push({ key: undefined, text: renderValue(preview) })
  }

  const assemble = (bodies: readonly string[]): string => {
    const lines = [headHtml(record)]
    fields.forEach((field, i) => {
      if (field.key === undefined) lines.push("", bodies[i]!)
      else lines.push(`<b>${escapeHtml(field.key)}</b>: ${bodies[i]}`)
    })
    if (attachments) lines.push("", attachments)
    return `${lines.join("\n")}\n${tail}`
  }

  const room = budget - visibleLength(assemble(fields.map(() => "")))
  const capped = fields.map(f => cutText(f.text, MAX_FIELD_CHARS))
  const cuts = fitTexts(
    capped.map(c => c.text),
    room,
  ).map((cut, i) => ({ text: cut.text, hidden: cut.hidden + capped[i]!.hidden }))
  return assemble(cuts.map((cut, i) => cutHtml(cut, fields[i]!.key !== undefined && !cut.text.includes("\n"))))
}

/**
 * The card for one approval, as Telegram HTML whose parsed text is at most
 * `MAX_BODY_CHARS` characters. `attachments` are the lines of the Attachments
 * block (what was sent, what was not and why); the `attachments` key they come
 * from is then not printed a second time as a field.
 */
export function describeApproval(
  record: ApprovalRecord,
  attachments: readonly AttachmentLine[] = [],
  files?: FileNames,
): string {
  const by = record.requestedBy
  const footer = ["", "sessionId" in by ? `Session: ${escapeHtml(by.sessionId)}` : "Requested by the operator"]
  if (record.expiresAt) footer.push(`Expires: ${escapeHtml(record.expiresAt)}`)
  const tail = footer.join("\n")
  const block = attachmentsBlock(attachments) ?? (files ? filesBlock(files) : undefined)

  let preview = record.preview
  if (block && isRecord(preview)) {
    const { attachments: _sent, ...others } = preview
    preview = others
  }
  const conv = isRecord(preview) ? readConvention(preview) : undefined
  const limit = conv ? MAX_COMPACT_CHARS : MAX_BODY_CHARS
  const render = (budget: number): string =>
    conv
      ? conventionHtml(record, conv, block, tail, budget)
      : plainPreviewHtml(record, preview, block, tail, budget)

  // The shares are computed on the source text, whose rendering is normally
  // shorter. When it is not, shrink the budget by the overshoot and retry.
  let budget = limit
  let html = render(budget)
  for (let i = 0; i < 4; i++) {
    const over = visibleLength(html) - limit
    if (over <= 0) return html
    budget -= over + NOTICE_RESERVE
    html = render(budget)
  }
  if (visibleLength(html) <= limit) return html
  // Fixed parts alone overflow (a pathological preview): keep the head of the
  // plain text, say so, and keep Session and Expires.
  const plain = htmlToPlain(html)
  const plainTail = htmlToPlain(tail)
  const head = plain.slice(0, plain.length - plainTail.length)
  const cut = cutText(head, limit - plainTail.length - NOTICE_RESERVE - 2)
  return `${escapeHtml(cut.text)}\n${notice(cut)}\n${tail}`
}
