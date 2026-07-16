import { describe, it, expect } from "vitest"
import { deriveSessionTitle } from "../session-title.js"

describe("deriveSessionTitle", () => {
  it("collapses a fenced code block to a single bounded line", () => {
    const prompt = "```typescript\nfunction foo() {\n  return 1\n}\n```"
    const title = deriveSessionTitle(prompt)
    expect(title).toBeDefined()
    expect(title).not.toContain("\n")
    expect(Array.from(title ?? "").length).toBeLessThanOrEqual(61)
  })

  it("keeps a leading slash-command — it IS what the turn is about", () => {
    expect(deriveSessionTitle("/compact")).toBe("/compact")
  })

  it("trims leading/trailing whitespace and newlines", () => {
    expect(deriveSessionTitle("  \n  hello there  \n\n")).toBe("hello there")
  })

  it("returns a single word as-is", () => {
    expect(deriveSessionTitle("hi")).toBe("hi")
  })

  it("returns undefined for an empty string", () => {
    expect(deriveSessionTitle("")).toBeUndefined()
  })

  it("returns undefined for a whitespace-only string", () => {
    expect(deriveSessionTitle("   \n\t  ")).toBeUndefined()
  })

  it("bounds a 5000-char prompt with no punctuation or spaces, without crashing", () => {
    const prompt = "a".repeat(5000)
    const title = deriveSessionTitle(prompt)
    expect(title).toBeDefined()
    expect(Array.from(title ?? "").length).toBeLessThanOrEqual(61)
    expect(title?.endsWith("…")).toBe(true)
  })

  it("extracts text from an array of content blocks, text block second", () => {
    const prompt = [
      { type: "image", source: { url: "https://example.com/x.png" } },
      { type: "text", text: "look at this screenshot" },
    ]
    expect(deriveSessionTitle(prompt)).toBe("look at this screenshot")
  })

  it("returns undefined for an array with no text blocks at all", () => {
    const prompt = [{ type: "image", source: { url: "https://example.com/x.png" } }]
    expect(deriveSessionTitle(prompt)).toBeUndefined()
  })

  it("extracts text from a single content-block object", () => {
    expect(deriveSessionTitle({ type: "text", text: "single block prompt" })).toBe(
      "single block prompt",
    )
  })

  it("truncates a 200-char first sentence at 60 chars", () => {
    const sentence = "a".repeat(50) + " " + "b".repeat(150)
    const title = deriveSessionTitle(`${sentence}. And a second sentence.`)
    expect(title).toBeDefined()
    expect(Array.from(title ?? "").length).toBeLessThanOrEqual(61)
    expect(title?.startsWith("a".repeat(50))).toBe(true)
  })

  it("does not mangle accented or CJK text short enough to need no truncation", () => {
    expect(deriveSessionTitle("Gère le déploiement s'il te plaît")).toBe(
      "Gère le déploiement s'il te plaît",
    )
    expect(deriveSessionTitle("検証環境のデプロイを手伝って")).toBe("検証環境のデプロイを手伝って")
  })

  it("slices by code point, not UTF-16 unit, so an astral char at the cut isn't split", () => {
    // A naive `.slice(0, 60)` operates on UTF-16 code units: this emoji is a
    // surrogate pair straddling that exact boundary, so a unit-based cut
    // would sever it into an orphan surrogate. Code-point slicing (Array.from)
    // must keep it whole — either fully in or fully out.
    const prompt = "x".repeat(59) + "🎉" + "y".repeat(10) // no spaces/punctuation
    const title = deriveSessionTitle(prompt)
    expect(title).toBeDefined()
    expect(Array.from(title ?? "").length).toBeLessThanOrEqual(61)
    expect(title).not.toMatch(/[\uD800-\uDFFF]/u) // no lone surrogate anywhere
    expect(title).toContain("🎉")
  })

  // A coding agent's prompts are full of periods that aren't sentence ends —
  // filenames, versions — so the sentence-end regex must require trailing
  // whitespace/EOS, not just any '.', '?', or '!'.
  it("does not cut a filename's dot as a sentence end", () => {
    expect(deriveSessionTitle("Read PLAN.md in your cwd")).toBe("Read PLAN.md in your cwd")
  })

  it("does not cut a dotted version number as a sentence end", () => {
    expect(deriveSessionTitle("Update to v1.2.3 and rebuild")).toBe("Update to v1.2.3 and rebuild")
  })

  it("does not cut a trailing filename before a real sentence-ending '?'", () => {
    expect(deriveSessionTitle("why does agentproto-vscode-0.1.0.vsix fail to install?")).toBe(
      "why does agentproto-vscode-0.1.0.vsix fail to install",
    )
  })

  it("still cuts at a real sentence end (terminator followed by whitespace)", () => {
    expect(deriveSessionTitle("Refactor the store. Then add tests.")).toBe(
      "Refactor the store",
    )
    expect(deriveSessionTitle("Hello world. This is the second.")).toBe("Hello world")
  })

  it("returns undefined for a prompt that collapses to pure punctuation", () => {
    expect(deriveSessionTitle("...")).toBeUndefined()
  })
})
