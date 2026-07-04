/**
 * Minimal, dependency-free Markdown → HTML renderer for the session-story
 * panel's transcript feed. Assistant text arrives as raw Markdown (headers,
 * bold/italic, lists, pipe tables, links, code) and was previously injected
 * as escaped plain text, so the feed showed literal `## ` / `**bold**` /
 * `|cell|` markup instead of a rendered view.
 *
 * All raw text is HTML-escaped before any generated tag is wrapped around
 * it, so untrusted tool/assistant text can never inject markup — the panel
 * iframe is sandboxed, but this is the last line of defense.
 *
 * Not a full CommonMark implementation: it covers exactly what agent
 * transcripts use (headers, emphasis, inline/fenced code, bullet/numbered
 * lists, pipe tables, links) and nothing more.
 */

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  )
}

function renderInline(text: string): string {
  let out = escapeHtml(text)
  // Inline code first so bold/italic/link patterns inside a code span are
  // left untouched (already escaped, never re-parsed).
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
  return out
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(c => c.trim())
}

/** Renders a Markdown string to a safe HTML fragment. */
export function renderMarkdownLite(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join("<br>")}</p>`)
      para = []
    }
  }
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul"
      out.push(`<${tag}>${list.items.map(i => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`)
      list = null
    }
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // fenced code block
    const fence = line.match(/^\s*```/)
    if (fence) {
      flushAll()
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        code.push(lines[i]!)
        i += 1
      }
      i += 1 // skip closing fence
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
      continue
    }

    // header
    const header = line.match(/^(#{1,6})\s+(.*)$/)
    if (header) {
      flushAll()
      const level = header[1]!.length
      out.push(`<h${level}>${renderInline(header[2]!.trim())}</h${level}>`)
      i += 1
      continue
    }

    // pipe table (header row + separator row)
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      flushAll()
      const headCells = splitRow(line)
      i += 2
      const bodyRows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        bodyRows.push(splitRow(lines[i]!))
        i += 1
      }
      out.push(
        "<table>" +
          `<thead><tr>${headCells.map(c => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${bodyRows.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>` +
          "</table>",
      )
      continue
    }

    // list item
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/)
    if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      const item = (bullet ?? numbered)![1]!
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(item)
      i += 1
      continue
    }

    // blank line: paragraph/list boundary
    if (line.trim() === "") {
      flushAll()
      i += 1
      continue
    }

    flushList()
    para.push(line)
    i += 1
  }
  flushAll()
  return out.join("")
}
