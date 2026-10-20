import { describe, expect, it } from "vitest"
import { continuedLabel } from "../session-continue-fresh.js"

describe("continuedLabel", () => {
  it("adds the suffix once on the first continuation", () => {
    expect(continuedLabel("pm-agentproto")).toBe("pm-agentproto (continued)")
  })
  it("numbers later generations instead of repeating the suffix", () => {
    expect(continuedLabel("pm-agentproto (continued)")).toBe("pm-agentproto (continued 2)")
    expect(continuedLabel("pm-agentproto (continued 2)")).toBe("pm-agentproto (continued 3)")
  })
  it("collapses the legacy repeated form", () => {
    expect(continuedLabel("sup (continued) (continued) (continued) (continued)")).toBe("sup (continued 5)")
  })
  it("leaves labels that merely contain the word alone", () => {
    expect(continuedLabel("continued-work")).toBe("continued-work (continued)")
  })
})
