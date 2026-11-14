import { describe, expect, it } from "vitest"

import { attachmentNameOf, reachContentFromPreview } from "../preview.js"

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

  it("reads the job kit shape: objects with filename and mimeType", () => {
    const content = reachContentFromPreview(
      {
        attachments: [
          { filename: "cv.pdf", mimeType: "application/pdf" },
          { filename: "submit-page.png", mimeType: "image/png" },
        ],
      },
      "T",
    )
    expect(content.attachments).toEqual([{ name: "cv.pdf" }, { name: "submit-page.png" }])
  })

  it("drops an object whose name is not a bare file name or that has no name", () => {
    expect(reachContentFromPreview({ attachments: [{ filename: "../x" }, { mimeType: "a/b" }] }, "T")).toEqual({ summary: "T" })
    expect(reachContentFromPreview({ attachments: ["cv.pdf", { name: "a.png" }] }, "T").attachments).toEqual([
      { name: "cv.pdf" },
      { name: "a.png" },
    ])
  })

  it("attachmentNameOf takes name, then filename, then fileName, first non-empty string", () => {
    expect(attachmentNameOf("a.pdf")).toBe("a.pdf")
    expect(attachmentNameOf({ name: "", filename: "b", fileName: "c" })).toBe("b")
    expect(attachmentNameOf({ name: "a", filename: "b" })).toBe("a")
    expect(attachmentNameOf({ fileName: "c" })).toBe("c")
    expect(attachmentNameOf({ name: "../x", filename: "cv.pdf" })).toBe("cv.pdf")
    expect(attachmentNameOf({ name: "  ", filename: "cv.pdf" })).toBe("cv.pdf")
    expect(attachmentNameOf({ name: "../x" })).toBeUndefined()
    expect(attachmentNameOf({ name: 3 })).toBeUndefined()
    expect(attachmentNameOf(null)).toBeUndefined()
  })
})
