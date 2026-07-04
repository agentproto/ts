import { describe, it, expect } from "vitest"
import { renderMarkdownLite } from "../markdown-lite.js"

describe("renderMarkdownLite", () => {
  it("renders headers", () => {
    expect(renderMarkdownLite("## Title")).toBe("<h2>Title</h2>")
    expect(renderMarkdownLite("### Sub")).toBe("<h3>Sub</h3>")
  })

  it("renders bold and italic", () => {
    expect(renderMarkdownLite("**bold** and *italic*")).toBe("<p><strong>bold</strong> and <em>italic</em></p>")
  })

  it("renders inline code", () => {
    expect(renderMarkdownLite("use `foo()` here")).toBe("<p>use <code>foo()</code> here</p>")
  })

  it("renders fenced code blocks without interpreting their contents", () => {
    const md = "```\nconst x = **not bold**;\n```"
    expect(renderMarkdownLite(md)).toBe("<pre><code>const x = **not bold**;</code></pre>")
  })

  it("renders bullet lists", () => {
    expect(renderMarkdownLite("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>")
  })

  it("renders numbered lists", () => {
    expect(renderMarkdownLite("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>")
  })

  it("renders pipe tables", () => {
    const md = "|a|b|\n|---|---|\n|1|2|"
    expect(renderMarkdownLite(md)).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    )
  })

  it("renders links", () => {
    expect(renderMarkdownLite("[docs](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>',
    )
  })

  it("escapes raw HTML in text before wrapping generated tags", () => {
    expect(renderMarkdownLite("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")
  })

  it("escapes raw HTML inside emphasis and code", () => {
    expect(renderMarkdownLite("**<img onerror=1>**")).toBe("<p><strong>&lt;img onerror=1&gt;</strong></p>")
    expect(renderMarkdownLite("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>")
  })

  it("joins consecutive paragraph lines with <br>", () => {
    expect(renderMarkdownLite("line one\nline two")).toBe("<p>line one<br>line two</p>")
  })

  it("separates paragraphs on blank lines", () => {
    expect(renderMarkdownLite("first\n\nsecond")).toBe("<p>first</p><p>second</p>")
  })

  it("renders plain text with no markdown as a paragraph", () => {
    expect(renderMarkdownLite("just plain text")).toBe("<p>just plain text</p>")
  })
})
