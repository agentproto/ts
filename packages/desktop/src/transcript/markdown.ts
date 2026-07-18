// Minimal, dependency-free, safe markdown → HTML for the transcript.
//
// The daemon's events.jsonl carries plain text/markdown. The reducer's
// presentation layer escapes everything BEFORE any HTML is produced, so what
// reaches dangerouslySetInnerHTML is already escaped; the only tags introduced
// here are the ones this module adds (<p>/<code>/<strong>/<em>/<br>) around that
// escaped text. No raw daemon content is ever interpolated unescaped.

/** Escape the five HTML-significant characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Apply a small set of inline markdown transforms to already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>")
}

/**
 * Render markdown to safe HTML: escape first, split on blank lines into
 * paragraphs, apply inline code/bold/italic + single-newline breaks. Not a full
 * CommonMark implementation — deliberately just the inline set a chat transcript
 * needs, kept small so it can't introduce an injection vector.
 */
export function renderMarkdown(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  return trimmed
    .split(/\n\s*\n/)
    .map((para) => `<p>${inline(escapeHtml(para))}</p>`)
    .join("")
}
