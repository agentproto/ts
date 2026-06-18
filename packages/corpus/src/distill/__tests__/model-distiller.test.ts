import { describe, it, expect } from "vitest"
import { modelDistiller } from "../model-distiller.js"
import type { ReportModelPort } from "../../report/model.js"

const input = {
  title: "A talk on pricing",
  body: "Charge for value, not time. Anchor high. Offer three tiers.",
  tags: ["pricing"],
}

describe("modelDistiller", () => {
  it("drives the model with the distill prompt and parses the JSON array", async () => {
    let seenPrompt = ""
    const model: ReportModelPort = {
      async complete({ prompt }) {
        seenPrompt = prompt
        return {
          result: JSON.stringify([
            { kind: "principle", title: "Charge for value", body: "Price on outcome.", confidence: 0.8 },
          ]),
        }
      },
    }
    const items = await modelDistiller(model).distill(input)
    expect(seenPrompt).toContain("A talk on pricing")
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("principle")
    expect(items[0]?.title).toBe("Charge for value")
  })

  it("coerces a non-string result and tolerates fenced / prose-wrapped output", async () => {
    const model: ReportModelPort = {
      async complete() {
        return {
          result:
            "Here you go:\n```json\n[{\"kind\":\"pattern\",\"title\":\"Three tiers\",\"body\":\"Offer good/better/best.\"}]\n```",
        }
      },
    }
    const items = await modelDistiller(model).distill(input)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("pattern")
  })

  it("passes maxItems into the prompt", async () => {
    let seen = ""
    const model: ReportModelPort = {
      async complete({ prompt }) {
        seen = prompt
        return { result: "[]" }
      },
    }
    await modelDistiller(model, { maxItems: 3 }).distill(input)
    expect(seen).toContain("max 3 items")
  })
})
