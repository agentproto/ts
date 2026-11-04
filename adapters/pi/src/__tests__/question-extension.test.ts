import { describe, expect, it, vi } from "vitest"

import { QUESTION_ASK_TITLE, questionTool } from "../question-extension.js"

const params = {
  questions: [
    {
      header: "Couleur",
      question: "Quelle couleur ?",
      options: [{ label: "Bleu" }, { label: "Vert" }, { label: "Orange" }],
    },
    {
      header: "Cibles",
      question: "Quelles cibles ?",
      options: [{ label: "Web" }, { label: "iOS" }, { label: "Android" }],
      multiSelect: true,
    },
  ],
}

async function run(editorValue: string | undefined) {
  const editor = vi.fn(async () => editorValue)
  const execute = questionTool().execute as unknown as (
    id: string,
    p: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: { ui: { editor: typeof editor } },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>
  const result = await execute("call-1", params, undefined, undefined, { ui: { editor } })
  return { editor, text: result.content[0]?.text }
}

describe("adapter-pi question extension", () => {
  it("asks through one marker editor dialog carrying the questions", async () => {
    const { editor } = await run(undefined)
    expect(editor).toHaveBeenCalledTimes(1)
    const [title, prefill] = editor.mock.calls[0] as unknown as [string, string]
    expect(title).toBe(QUESTION_ASK_TITLE)
    expect(JSON.parse(prefill).questions).toHaveLength(2)
  })

  it("formats selected answers, a free-text-only answer and a note", async () => {
    const { text } = await run(
      JSON.stringify({
        answers: [
          { header: "Couleur", question: "Quelle couleur ?", selected: [], text: "vert d'eau" },
          { header: "Cibles", question: "Quelles cibles ?", selected: ["Web", "iOS"], text: "surtout iOS" },
        ],
      }),
    )
    expect(text).toBe("Couleur: vert d'eau\nCibles: Web, iOS (note: surtout iOS)")
  })

  it("reports a skip when the dialog is cancelled or skipped", async () => {
    expect((await run(undefined)).text).toBe("The user skipped the question.")
    expect((await run(JSON.stringify({ skipped: true }))).text).toBe("The user skipped the question.")
  })
})
