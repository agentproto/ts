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
  const lines = text.split(/\r\n|\r|\n/)
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

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine)

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
