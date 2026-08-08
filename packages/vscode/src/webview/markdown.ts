/**
 * Minimal hand-rolled Markdown → HTML renderer for the transcript webview.
 *
 * Supported subset:
 *   - Headings (# … ######)
 *   - Bold (**text**) and italic (*text*), which compose: either can span an
 *     inline code span, and can nest inside each other
 *   - Inline code (`text`), whose contents are always literal — never
 *     re-scanned for bold/italic markers, even `**this**`
 *   - Fenced code blocks (``` optionally with language)
 *   - Unordered lists (-, *, +) and ordered lists (1.)
 *   - Blockquotes (>)
 *   - GFM pipe tables (a header row, a `|---|` separator row with optional
 *     `:` alignment markers, and body rows) — inline formatting still applies
 *     inside cells, `\|` and pipes inside code spans don't split cells, and a
 *     block that only looks table-ish (no valid separator row) stays plain text
 *
 * All HTML is escaped before formatting is applied; no external markdown
 * library is used, keeping the webview dependency-free.
 */

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] ?? ch)
}

export function renderMarkdown(text: string): string {
  const rawLines = text.split(/\r\n|\r|\n/)
  // Escape once up front so table look-ahead and the per-line paths agree on
  // what a cell's contents are (inlineFormat expects pre-escaped input).
  const lines = rawLines.map(escapeHtml)
  const out: string[] = []

  let codeBuffer: string[] | undefined
  let codeLang: string | undefined
  let listBuffer: { marker: "ul" | "ol"; items: string[] } | undefined
  let quoteBuffer: string[] | undefined
  let paraBuffer: string[] | undefined

  function flushBlockquote(): void {
    if (quoteBuffer && quoteBuffer.length > 0) {
      const inner = quoteBuffer.map(inlineFormat).join("<br>")
      out.push(`<blockquote><p>${inner}</p></blockquote>`)
      quoteBuffer = undefined
    }
  }

  function flushList(): void {
    if (listBuffer && listBuffer.items.length > 0) {
      const tag = listBuffer.marker
      const items = listBuffer.items.map(item => `<li>${inlineFormat(item)}</li>`).join("")
      out.push(`<${tag}>${items}</${tag}>`)
      listBuffer = undefined
    }
  }

  function flushParagraph(): void {
    if (paraBuffer && paraBuffer.length > 0) {
      out.push(`<p>${paraBuffer.map(inlineFormat).join("<br>")}</p>`)
      paraBuffer = undefined
    }
  }

  function flushAll(): void {
    flushParagraph()
    flushList()
    flushBlockquote()
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = rawLines[idx]!
    const line = lines[idx]!

    // Code fence
    const fenceMatch = /^```(.*)$/.exec(line)
    if (fenceMatch) {
      if (codeBuffer) {
        out.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`)
        codeBuffer = undefined
        codeLang = undefined
      } else {
        flushAll()
        codeBuffer = []
        codeLang = fenceMatch[1]?.trim()
        if (codeLang) {
          // language is stored but not rendered as a class in this minimal subset
        }
      }
      continue
    }

    if (codeBuffer) {
      codeBuffer.push(line)
      continue
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      flushAll()
      const level = headingMatch[1]!.length
      out.push(`<h${level}>${inlineFormat(headingMatch[2]!)}</h${level}>`)
      continue
    }

    // Blank line
    if (line.trim() === "") {
      flushAll()
      continue
    }

    // Blockquote
    const quoteMatch = /^>\s?(.*)$/.exec(rawLine)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quoteBuffer = quoteBuffer ?? []
      quoteBuffer.push(escapeHtml(quoteMatch[1]!))
      continue
    }

    // Unordered list
    const ulMatch = /^[-*+]\s+(.+)$/.exec(line)
    if (ulMatch) {
      flushParagraph()
      flushBlockquote()
      if (listBuffer && listBuffer.marker !== "ul") {
        flushList()
      }
      listBuffer = listBuffer ?? { marker: "ul", items: [] }
      listBuffer.items.push(ulMatch[1]!)
      continue
    }

    // Ordered list
    const olMatch = /^(\d+)\.\s+(.+)$/.exec(line)
    if (olMatch) {
      flushParagraph()
      flushBlockquote()
      if (listBuffer && listBuffer.marker !== "ol") {
        flushList()
      }
      listBuffer = listBuffer ?? { marker: "ol", items: [] }
      listBuffer.items.push(olMatch[2]!)
      continue
    }

    // GFM pipe table (a header row immediately followed by a separator row).
    // Checked before the paragraph fallback so a table interrupts pending
    // prose; a block with no valid separator row falls through as plain text.
    const table = tryParseTable(lines, idx)
    if (table) {
      flushAll()
      out.push(table.html)
      idx = table.next - 1
      continue
    }

    // Regular paragraph line
    flushList()
    flushBlockquote()
    paraBuffer = paraBuffer ?? []
    paraBuffer.push(line)
  }

  // Flush trailing blocks
  if (codeBuffer) {
    out.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`)
  }
  flushAll()

  return out.join("\n")
}

interface Cursor {
  pos: number
}

interface ScanResult {
  html: string
  closed: boolean
}

function inlineFormat(text: string): string {
  return scanInline(text, { pos: 0 }, null).html
}

/**
 * Splitting on backticks before formatting (the previous approach) leaves
 * `**bold with ` and ` inside**` as two fragments, neither of which contains
 * a full `**…**` pair, so the markers survive as literal text. Formatting
 * before splitting has the opposite failure: it emphasizes text inside a
 * code span's contents, which must stay literal.
 *
 * A single scan avoids both: it walks the string once, and whichever of
 * {code span, bold, italic} starts first is resolved on the spot. A code
 * span's content is sliced out verbatim (never recursed into); bold/italic
 * recurse on their inner text so nesting and code-span-spanning fall out for
 * free instead of needing another pass.
 */
function scanInline(text: string, cursor: Cursor, closer: "**" | "*" | null): ScanResult {
  let out = ""

  while (cursor.pos < text.length) {
    if (closer === "**" && text.startsWith("**", cursor.pos)) {
      cursor.pos += 2
      return { html: out, closed: true }
    }
    if (closer === "*" && text[cursor.pos] === "*" && text[cursor.pos + 1] !== "*") {
      cursor.pos += 1
      return { html: out, closed: true }
    }

    if (text[cursor.pos] === "`") {
      const close = text.indexOf("`", cursor.pos + 1)
      if (close === -1) {
        // No closing backtick anywhere ahead: this backtick can't start a
        // code span, so treat it as a literal character and keep scanning
        // normally (bold/italic still apply to what follows).
        out += "`"
        cursor.pos += 1
        continue
      }
      out += `<code>${text.slice(cursor.pos + 1, close)}</code>`
      cursor.pos = close + 1
      continue
    }

    if (text.startsWith("**", cursor.pos)) {
      cursor.pos += 2
      const inner = scanInline(text, cursor, "**")
      out += inner.closed ? `<strong>${inner.html}</strong>` : `**${inner.html}`
      continue
    }

    if (text[cursor.pos] === "*") {
      cursor.pos += 1
      const inner = scanInline(text, cursor, "*")
      out += inner.closed ? `<em>${inner.html}</em>` : `*${inner.html}`
      continue
    }

    out += text[cursor.pos]
    cursor.pos += 1
  }

  return { html: out, closed: false }
}

type Alignment = "left" | "right" | "center" | null

/** A separator cell is only hyphens with an optional leading/trailing colon. */
const SEPARATOR_CELL = /^:?-+:?$/

/**
 * Split one HTML-escaped table row into trimmed cell strings. A `\|` is an
 * escaped literal pipe (unescaped to `|` here) and a `|` inside a backtick code
 * span is literal too — neither splits a cell. A leading/trailing delimiter
 * pipe produces one empty edge cell, which is dropped so `| a | b |` and
 * `a | b` both yield two cells.
 */
function splitTableCells(line: string): string[] {
  const cells: string[] = []
  let cur = ""
  let inCode = false
  const s = line.trim()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "\\" && s[i + 1] === "|" && !inCode) {
      cur += "|"
      i += 1
      continue
    }
    if (ch === "`") {
      inCode = !inCode
      cur += ch
      continue
    }
    if (ch === "|" && !inCode) {
      cells.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(cur)
  if (cells.length > 1 && cells[0] === "") cells.shift()
  if (cells.length > 1 && cells[cells.length - 1] === "") cells.pop()
  return cells.map(c => c.trim())
}

/**
 * Parse a separator row into per-column alignments, or null if it isn't a valid
 * separator. Requires a `|` (so a bare `---` setext underline is never mistaken
 * for a one-column table) and every cell to be the hyphen/colon form.
 */
function parseSeparator(line: string): Alignment[] | null {
  if (!line.includes("|")) return null
  const cells = splitTableCells(line)
  if (cells.length === 0) return null
  const aligns: Alignment[] = []
  for (const cell of cells) {
    if (!SEPARATOR_CELL.test(cell)) return null
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null)
  }
  return aligns
}

function tableCell(tag: "th" | "td", content: string, align: Alignment): string {
  const style = align ? ` style="text-align:${align}"` : ""
  return `<${tag}${style}>${inlineFormat(content)}</${tag}>`
}

/**
 * If the (HTML-escaped) lines at `idx` are a table header + separator, render
 * the whole table and report the index just past its last body row. Body rows
 * are the consecutive non-blank lines containing a pipe; each is padded or
 * truncated to the column count. Returns null when it isn't a table.
 */
function tryParseTable(lines: string[], idx: number): { html: string; next: number } | null {
  const header = lines[idx]
  const separator = lines[idx + 1]
  if (header === undefined || separator === undefined) return null
  if (!header.includes("|")) return null

  const aligns = parseSeparator(separator)
  if (!aligns) return null

  const headerCells = splitTableCells(header)
  if (headerCells.length !== aligns.length) return null

  const bodyRows: string[][] = []
  let j = idx + 2
  while (j < lines.length) {
    const row = lines[j]!
    if (row.trim() === "" || !row.includes("|")) break
    const cells = splitTableCells(row)
    const normalized: string[] = []
    for (let c = 0; c < aligns.length; c++) normalized.push(cells[c] ?? "")
    bodyRows.push(normalized)
    j += 1
  }

  const thead = `<thead><tr>${headerCells
    .map((cell, i) => tableCell("th", cell, aligns[i] ?? null))
    .join("")}</tr></thead>`
  const tbody =
    bodyRows.length > 0
      ? `<tbody>${bodyRows
          .map(
            cells =>
              `<tr>${cells.map((cell, i) => tableCell("td", cell, aligns[i] ?? null)).join("")}</tr>`,
          )
          .join("")}</tbody>`
      : ""

  return { html: `<table>${thead}${tbody}</table>`, next: j }
}
