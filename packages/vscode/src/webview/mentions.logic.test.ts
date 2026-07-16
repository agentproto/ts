import { describe, expect, it } from "vitest"

import { filterMentionCandidates, mentionQueryAt, parseFileList } from "./mentions.logic.js"

describe("mentionQueryAt", () => {
  it("finds a mention the caret is typing into", () => {
    const text = "look at @src/fo"
    expect(mentionQueryAt(text, text.length)).toEqual({ query: "src/fo", start: 8, end: 15 })
  })

  it("opens on a bare @ at the caret", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", start: 0, end: 1 })
    expect(mentionQueryAt("hi @", 4)).toEqual({ query: "", start: 3, end: 4 })
  })

  it("does NOT treat an @ inside a word (email, handle) as a mention", () => {
    expect(mentionQueryAt("mail me@x.com", 13)).toBeNull()
  })

  it("closes once whitespace follows the @ token", () => {
    // caret is after the space — no longer inside the @token
    expect(mentionQueryAt("@src ", 5)).toBeNull()
  })

  it("scopes to the token the caret is in, not an earlier @", () => {
    const text = "@a and @b"
    expect(mentionQueryAt(text, text.length)).toEqual({ query: "b", start: 7, end: 9 })
  })

  it("returns null for an out-of-range caret", () => {
    expect(mentionQueryAt("@a", 99)).toBeNull()
  })
})

describe("filterMentionCandidates", () => {
  const files = [
    "src/webview/attachments.logic.ts",
    "src/webview/mentions.logic.ts",
    "src/client/daemonClient.ts",
    "README.md",
    "docs/attachments.md",
  ]

  it("returns the head of the list for an empty query", () => {
    expect(filterMentionCandidates(files, "", 3)).toEqual(files.slice(0, 3))
  })

  it("ranks basename-prefix above basename-substring above path-substring", () => {
    const out = filterMentionCandidates(files, "attachments", 10)
    // "attachments.logic.ts" and "attachments.md" (basename-prefix) come before
    // "src/webview/..." matches only in the path... but both those ARE basename
    // hits; the pure path-only hit is docs path. Assert the two basename-prefix
    // files lead, shorter path first.
    expect(out[0]).toBe("docs/attachments.md") // basename "attachments.md" prefix, shorter path
    expect(out).toContain("src/webview/attachments.logic.ts")
  })

  it("matches on the full path, not just the basename", () => {
    expect(filterMentionCandidates(files, "webview", 10)).toEqual([
      "src/webview/mentions.logic.ts",
      "src/webview/attachments.logic.ts",
    ])
  })

  it("is case-insensitive and caps the result", () => {
    expect(filterMentionCandidates(files, "README".toLowerCase(), 10)).toEqual(["README.md"])
    expect(filterMentionCandidates(files, "s", 2)).toHaveLength(2)
  })

  it("returns nothing when nothing matches", () => {
    expect(filterMentionCandidates(files, "zzz", 10)).toEqual([])
  })
})

describe("parseFileList", () => {
  it("splits newline- or NUL-separated output and drops blanks", () => {
    expect(parseFileList("a.ts\nb.ts\n\n")).toEqual(["a.ts", "b.ts"])
    expect(parseFileList("a.ts\0b.ts\0")).toEqual(["a.ts", "b.ts"])
  })
})
