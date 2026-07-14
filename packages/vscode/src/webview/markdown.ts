/**
 * Minimal hand-rolled Markdown → HTML renderer for the transcript webview.
 *
 * Supported subset:
 *   - Headings (# … ######)
 *   - Bold (**text**) and italic (*text*)
 *   - Inline code (`text`)
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

function inlineFormat(text: string): string {
  let out = ""
  let buf = ""
  let inCode = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "`") {
      if (inCode) {
        out += `<code>${buf}</code>`
        buf = ""
        inCode = false
      } else {
        out += formatSegment(buf)
        buf = ""
        inCode = true
      }
      continue
    }
    buf += ch
  }

  if (inCode) {
    out += "`" + formatSegment(buf)
  } else {
    out += formatSegment(buf)
  }

  return out
}

function formatSegment(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
}
