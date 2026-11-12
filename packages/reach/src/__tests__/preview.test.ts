import { describe, expect, it } from "vitest"

import { reachContentFromPreview } from "../preview.js"

describe("reachContentFromPreview", () => {
  it("keeps the convention: summary, sections, https links, bare attachment names", () => {
    const content = reachContentFromPreview(
      {
        summary: "Submit the form",
        sections: [{ title: "Letter", text: "Dear..." }, { title: 3, text: "bad" }, "junk"],
        links: [
          { label: "Run", url: "https://example.com/run" },
          { label: "Plain", url: "http://example.com" },
          { label: "Script", url: "javascript:alert(1)" },
          { label: "Broken", url: "not a url" },
        ],
        attachments: ["cv.pdf", { name: "shot.png" }, "../etc/passwd", "a/b.txt", "c\\d.txt", "..", "", "cv.pdf"],
        recipe: "linkedin",
        preview: "legacy text",
      },
      "Fallback title",
    )
    expect(content).toEqual({
      summary: "Submit the form",
      sections: [{ title: "Letter", text: "Dear..." }],
      links: [{ label: "Run", url: "https://example.com/run" }],
      attachments: [{ name: "cv.pdf" }, { name: "shot.png" }],
    })
  })

  it("falls back to the record title when there is no summary, and drops legacy keys", () => {
    expect(reachContentFromPreview({ recipe: "x", tool: "y" }, "linkedin · react")).toEqual({ summary: "linkedin · react" })
    expect(reachContentFromPreview({ summary: "   " }, "T")).toEqual({ summary: "T" })
    expect(reachContentFromPreview("a string preview", "T")).toEqual({ summary: "T" })
    expect(reachContentFromPreview(undefined, "T")).toEqual({ summary: "T" })
  })
})
