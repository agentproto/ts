import { describe, it, expect } from "vitest"

import { elicitationToQuestion, resolutionToElicitationResponse } from "../client/elicitation.js"
import { ASK_TWO } from "./fixtures/claude-agent-acp-elicitation.js"
import { CODEX_ASK_TWO } from "./fixtures/codex-acp-elicitation.js"

// codex-acp's `request_user_input` form: question text in `title`, header in
// `description`, free text in a `<id>_note` companion tagged
// `_meta.codex.role: "user_note"`.

describe("codex-acp request_user_input elicitation", () => {
  it("maps each question to one field, prompt from title and header from description", () => {
    const mapped = elicitationToQuestion(CODEX_ASK_TWO)!
    const fields = mapped.question.fields!
    expect(fields.map(f => f.id)).toEqual(["couleur", "cibles"])
    expect(fields[0]).toMatchObject({
      input: "single",
      prompt: "Quelle couleur ?",
      header: "Couleur",
      allowFreeText: true,
      required: true,
    })
    expect(fields[1]).toMatchObject({ input: "single", prompt: "Quelles cibles ?", header: "Cibles", allowFreeText: true })
    expect(fields[0]!.choices!.map(c => c.value)).toEqual(["Bleu", "Vert", "Orange", "Other"])
  })

  it("treats the user_note property as the free-text companion, not a field", () => {
    const mapped = elicitationToQuestion(CODEX_ASK_TWO)!
    expect(mapped.question.fields!.some(f => f.id.endsWith("_note"))).toBe(false)
    expect(mapped.companions.get("couleur")).toBe("couleur_note")
    expect(mapped.companions.get("cibles")).toBe("cibles_note")
  })

  it("sends answers back under the codex keys, free text under the note key", () => {
    const mapped = elicitationToQuestion(CODEX_ASK_TWO)!
    const response = resolutionToElicitationResponse(mapped, {
      answers: {
        couleur: { selected: ["Vert"], text: "plutot vert d'eau" },
        cibles: { selected: ["Web"] },
      },
    })
    expect(response).toEqual({
      action: "accept",
      content: { couleur: "Vert", couleur_note: "plutot vert d'eau", cibles: "Web" },
    })
  })

  it("keeps the claude-agent-acp mapping (header from title, prompt from description)", () => {
    const mapped = elicitationToQuestion(ASK_TWO)!
    for (const field of mapped.question.fields!) {
      expect(field.header).toBeDefined()
      expect(field.prompt).not.toBe(field.header)
      expect(field.prompt.length).toBeGreaterThan(field.header!.length)
    }
  })
})
