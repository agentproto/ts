import { describe, expect, it } from "vitest"

import { escapeHtml, renderMarkdown } from "./markdown.js"

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  it("leaves plain text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world")
  })
})

describe("renderMarkdown", () => {
  it("renders headings", () => {
    const md = "# H1\n## H2\n###### H6"
    const html = renderMarkdown(md)
    expect(html).toContain("<h1>H1</h1>")
    expect(html).toContain("<h2>H2</h2>")
    expect(html).toContain("<h6>H6</h6>")
  })

  it("renders paragraphs", () => {
    const html = renderMarkdown("Hello\n\nWorld")
    expect(html).toContain("<p>Hello</p>")
    expect(html).toContain("<p>World</p>")
  })

  it("escapes raw HTML", () => {
    const html = renderMarkdown("<script>alert('x')</script>")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("renders bold and italic", () => {
    const html = renderMarkdown("**bold** and *italic*")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<em>italic</em>")
  })

  it("renders inline code", () => {
    const html = renderMarkdown("use `npm install` here")
    expect(html).toContain("<code>npm install</code>")
  })

  it("does not format inside inline code", () => {
    const html = renderMarkdown("`**not bold**`")
    expect(html).toContain("<code>**not bold**</code>")
    expect(html).not.toContain("<strong>not bold</strong>")
  })

  it("renders fenced code blocks", () => {
    const md = "```\nconst x = 1\nconst y = 2\n```"
    const html = renderMarkdown(md)
    expect(html).toContain("<pre><code>")
    expect(html).toContain("const x = 1")
    expect(html).toContain("const y = 2")
  })

  it("escapes HTML inside code blocks", () => {
    const md = "```\n<div>\n```"
    const html = renderMarkdown(md)
    expect(html).toContain("&lt;div&gt;")
    expect(html).not.toContain("<div>")
  })

  it("renders unordered lists", () => {
    const html = renderMarkdown("- one\n- two\n* three")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<li>three</li>")
  })

  it("renders ordered lists", () => {
    const html = renderMarkdown("1. first\n2. second")
    expect(html).toContain("<ol>")
    expect(html).toContain("<li>first</li>")
  })

  it("renders blockquotes", () => {
    const html = renderMarkdown("> quoted\n> line")
    expect(html).toContain("<blockquote>")
    expect(html).toContain("<p>quoted<br>line</p>")
  })

  it("separates adjacent list and paragraph", () => {
    const html = renderMarkdown("- item\n\npara")
    expect(html).toContain("<li>item</li>")
    expect(html).toContain("<p>para</p>")
  })
})
