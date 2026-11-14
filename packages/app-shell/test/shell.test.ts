import { describe, expect, it } from "vitest"
import { escapeHtml, navCount, renderShell, renderTopbar } from "../src/index.js"

const base = { brand: "Acme Desk", logo: "AD" }

describe("renderShell", () => {
  it("renders the brand, logo and home it is given", () => {
    const html = renderShell("inbox", {}, { ...base, home: "inbox" })
    expect(html).toContain('<a class="brand" href="#/inbox">')
    expect(html).toContain('<span class="logo">AD</span><b>Acme Desk</b>')
  })

  it("requires brand and logo", () => {
    // @ts-expect-error brand and logo are required
    expect(() => renderShell("a", {}, {})).toThrow(/brand is required/)
    // @ts-expect-error logo is required
    expect(() => renderShell("a", {}, { brand: "Acme" })).toThrow(/logo is required/)
  })

  it("uses neutral defaults for labels and footer", () => {
    const html = renderShell("a", {}, base)
    expect(html).toContain('aria-label="Main navigation"')
    expect(html).toContain('<a class="brand" href="#/">')
    expect(html).toContain('<div class="side-foot"></div>')
  })

  it("renders the labels it is given", () => {
    const options = {
      ...base,
      navLabel: "Navigation principale",
      liveCaption: "Données locales",
      idleCaption: "Aperçu",
    }
    expect(renderShell("a", {}, { ...options, live: true })).toContain(
      '<div class="side-foot">Données locales</div>'
    )
    const idle = renderShell("a", {}, options)
    expect(idle).toContain('<div class="side-foot">Aperçu</div>')
    expect(idle).toContain('aria-label="Navigation principale"')
  })

  it("escapes brand, logo and captions", () => {
    const html = renderShell("a", {}, { brand: "A&B <i>", logo: '"x"', live: true, liveCaption: "<b>" })
    expect(html).toContain("<b>A&amp;B &lt;i&gt;</b>")
    expect(html).toContain("&quot;x&quot;")
    expect(html).toContain('<div class="side-foot">&lt;b&gt;</div>')
  })

  it("renders nav items, the active one, counts and soon placeholders", () => {
    const html = renderShell(
      "inbox",
      { inbox: 3 },
      {
        ...base,
        navItems: [
          { route: "inbox", label: "Inbox", count: "inbox" },
          { route: "sent", label: "Sent", count: 12 },
          { label: "Reports" },
        ],
      }
    )
    expect(html).toContain(
      '<a href="#/inbox" class="active" aria-current="page">Inbox<span class="count">03</span></a>'
    )
    expect(html).toContain('<a href="#/sent">Sent<span class="count">12</span></a>')
    expect(html).toContain('<a href="#" data-soon="Reports">Reports</a>')
  })
})

describe("renderTopbar", () => {
  it("renders the title and the built-in kit switcher with default labels", () => {
    const html = renderTopbar({ title: "Inbox" })
    expect(html).toContain("<h1>Inbox</h1>")
    expect(html).toContain('<label class="tiny muted">Kit <select class="kit-switch" aria-label="Visual kit">')
    expect(html).toContain('<option value="paper-light">Paper light</option>')
    expect(html).not.toContain("demo-label")
  })

  it("renders the labels and kits it is given", () => {
    const html = renderTopbar({
      title: "Boîte",
      demoLabel: "Preview data",
      kitLabel: "Thème",
      kitAriaLabel: "Thème visuel",
      kits: [{ value: "acme-dark", label: "Acme dark" }],
    })
    expect(html).toContain('<span class="demo-label">Preview data</span>')
    expect(html).toContain("Thème <select")
    expect(html).toContain('aria-label="Thème visuel"')
    expect(html).toContain('<option value="acme-dark">Acme dark</option>')
    expect(html).not.toContain("paper-light")
  })
})

describe("helpers", () => {
  it("escapeHtml escapes markup and tolerates nullish values", () => {
    expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;")
    expect(escapeHtml(null)).toBe("")
  })

  it("navCount pads and ignores missing counts", () => {
    expect(navCount(5, undefined)).toBe('<span class="count">05</span>')
    expect(navCount("k", { k: 7 })).toBe('<span class="count">07</span>')
    expect(navCount("k", {})).toBe("")
    expect(navCount(undefined, {})).toBe("")
  })
})
