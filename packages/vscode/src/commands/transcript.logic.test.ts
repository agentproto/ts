import { describe, expect, it } from "vitest"

import { splitTranscriptLines, transcriptChannelName } from "./transcript.logic.js"

describe("transcriptChannelName", () => {
  it("prefers label over id", () => {
    expect(transcriptChannelName({ label: "sales-analysis", id: "s1" })).toBe("agentproto: sales-analysis")
  })

  it("falls back to id when label is absent", () => {
    expect(transcriptChannelName({ id: "s1" })).toBe("agentproto: s1")
  })
})

describe("splitTranscriptLines", () => {
  it("splits on \\n and drops one trailing empty line", () => {
    expect(splitTranscriptLines("a\nb\nc\n")).toEqual(["a", "b", "c"])
  })

  it("keeps a final non-empty line", () => {
    expect(splitTranscriptLines("a\nb")).toEqual(["a", "b"])
  })

  it("handles CRLF line endings", () => {
    expect(splitTranscriptLines("a\r\nb\r\n")).toEqual(["a", "b"])
  })

  it("returns a single empty-string element for empty content", () => {
    expect(splitTranscriptLines("")).toEqual([])
  })
})
