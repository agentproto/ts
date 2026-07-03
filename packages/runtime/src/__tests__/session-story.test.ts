import { describe, it, expect } from "vitest"
import { buildStory, classifyKind, classifyRoute } from "../session-story.js"
import type { ExportedMessage } from "../transcript-export.js"

describe("classifyKind", () => {
  it("classifies edit/write tool calls as edit", () => {
    expect(classifyKind([{ name: "Edit" }])).toBe("edit")
    expect(classifyKind([{ name: "Write" }])).toBe("edit")
  })
  it("classifies bash/terminal/command tool calls as bash", () => {
    expect(classifyKind([{ name: "Bash" }])).toBe("bash")
    expect(classifyKind([{ name: "terminal_start" }])).toBe("bash")
    expect(classifyKind([{ name: "command_execute" }])).toBe("bash")
  })
  it("classifies read/grep/glob tool calls as read", () => {
    expect(classifyKind([{ name: "Read" }])).toBe("read")
    expect(classifyKind([{ name: "Grep" }])).toBe("read")
    expect(classifyKind([{ name: "Glob" }])).toBe("read")
  })
  it("falls back to text for unknown tools or no tool calls", () => {
    expect(classifyKind([{ name: "WebSearch" }])).toBe("text")
    expect(classifyKind(undefined)).toBe("text")
    expect(classifyKind([])).toBe("text")
  })
})

describe("classifyRoute", () => {
  it("routes plain continuation text as cont", () => {
    expect(classifyRoute("Merci, ça marche bien.").route).toBe("cont")
  })
  it("routes new-chapter keywords as newt with a truncated title", () => {
    expect(classifyRoute("Peux-tu aussi gérer le cas vide ?").route).toBe("newt")
  })
  it("recognizes accented keywords (gère, plutôt, après ça)", () => {
    expect(classifyRoute("Gère le cas où le fichier est absent.").route).toBe("newt")
    expect(classifyRoute("Plutôt utiliser une autre approche.").route).toBe("newt")
    expect(classifyRoute("Après ça il faudra nettoyer.").route).toBe("newt")
  })
  it("truncates the title at the first sentence end, capped at 42 chars", () => {
    const { title } = classifyRoute(
      "Il faudrait aussi gérer un très long message qui dépasse la limite. Et une suite.",
    )
    expect(title).toBeDefined()
    expect(title!.length).toBeLessThanOrEqual(42)
    expect(title).not.toContain(".")
  })
})

function userMsg(text: string, ts?: number): ExportedMessage {
  return { role: "user", text, ...(ts !== undefined ? { ts } : {}) }
}

describe("buildStory — folding", () => {
  it("folds an assistant message + its tool results into one step", () => {
    const messages: ExportedMessage[] = [
      userMsg("Explore le repo stp"),
      {
        role: "assistant",
        toolCalls: [{ name: "Bash", args: JSON.stringify({ command: "ls -R pricing/" }) }],
      },
      { role: "tool", toolName: "Bash", text: "pricing/\n  summary.ts\n  loader.ts" },
    ]
    const story = buildStory(messages)
    expect(story.steps).toHaveLength(2)
    const toolStep = story.steps[1]!
    expect(toolStep.kind).toBe("bash")
    expect(toolStep.count).toBe(1)
    expect(toolStep.items).toHaveLength(1)
    expect(toolStep.items[0]).toMatchObject({ h: expect.stringContaining("ls -R pricing/") })
  })

  it("groups multiple tool calls from one assistant message into a single step with count > 1", () => {
    const messages: ExportedMessage[] = [
      userMsg("Scaffold les fichiers"),
      {
        role: "assistant",
        toolCalls: [
          { name: "Edit", args: JSON.stringify({ file_path: "a.json" }) },
          { name: "Edit", args: JSON.stringify({ file_path: "b.json" }) },
        ],
      },
      { role: "tool", toolName: "Edit", text: "File created, 10 lines." },
      { role: "tool", toolName: "Edit", text: "File created, 4 lines." },
    ]
    const story = buildStory(messages)
    const toolStep = story.steps[1]!
    expect(toolStep.kind).toBe("edit")
    expect(toolStep.count).toBe(2)
    expect(toolStep.items).toHaveLength(2)
    expect(toolStep.raw1).toContain("×2")
  })

  it("uses the assistant's own text as the summary when present, ignoring tool calls", () => {
    const messages: ExportedMessage[] = [
      userMsg("Vérifie le typecheck"),
      {
        role: "assistant",
        text: "Je vérifie le typecheck maintenant.",
        toolCalls: [{ name: "Bash", args: JSON.stringify({ command: "pnpm check-types" }) }],
      },
      { role: "tool", toolName: "Bash", text: "tsc — 0 errors\nExit code 0" },
    ]
    const story = buildStory(messages)
    const step = story.steps[1]!
    expect(step.sum).toBe("Je vérifie le typecheck maintenant.")
  })

  it("renders a pure-text assistant message (no tool calls) as kind text", () => {
    const messages: ExportedMessage[] = [
      userMsg("Explique-moi le plan"),
      { role: "assistant", text: "Voici le plan : d'abord X, puis Y." },
    ]
    const story = buildStory(messages)
    expect(story.steps[1]!.kind).toBe("text")
    expect(story.steps[1]!.raw1).toContain("assistant")
  })

  it("extracts facts from tool results via formatToolResult", () => {
    const messages: ExportedMessage[] = [
      userMsg("check"),
      {
        role: "assistant",
        toolCalls: [{ name: "Bash", args: JSON.stringify({ command: "pnpm check-types" }) }],
      },
      { role: "tool", toolName: "Bash", text: "tsc — 0 errors\nExit code 0" },
    ]
    const story = buildStory(messages)
    expect(story.steps[1]!.facts.length).toBeGreaterThan(0)
  })
})

describe("buildStory — chapter routing", () => {
  it("opens 'Cadrage' as the first chapter for the opening user message", () => {
    const story = buildStory([userMsg("Construis le pricing book")])
    expect(story.chapters).toHaveLength(1)
    expect(story.chapters[0]).toMatchObject({ id: "c1", title: "Cadrage", status: "cur" })
    expect(story.steps[0]!.chap).toBe("c1")
    expect(story.steps[0]!.route).toBeUndefined()
  })

  it("keeps a continuation message in the same chapter, tagged route=cont", () => {
    const story = buildStory([
      userMsg("Construis le pricing book"),
      { role: "assistant", text: "OK, je m'y mets." },
      userMsg("Merci, ça marche bien."),
    ])
    expect(story.chapters).toHaveLength(1)
    expect(story.steps[2]!.chap).toBe("c1")
    expect(story.steps[2]!.route).toBe("cont")
    expect(story.chapters[0]!.status).toBe("cur")
  })

  it("opens a new chapter on a new-chapter keyword, closing the previous one", () => {
    const story = buildStory([
      userMsg("Construis le pricing book"),
      { role: "assistant", text: "OK." },
      userMsg("Gère aussi le cas pricing.json vide stp"),
    ])
    expect(story.chapters).toHaveLength(2)
    expect(story.chapters[0]).toMatchObject({ id: "c1", status: "done" })
    expect(story.chapters[1]).toMatchObject({ id: "c2", status: "cur" })
    expect(story.steps[2]!.chap).toBe("c2")
    expect(story.steps[2]!.route).toBe("newt")
  })

  it("attaches non-user steps to the current chapter", () => {
    const story = buildStory([
      userMsg("Construis le pricing book"),
      {
        role: "assistant",
        toolCalls: [{ name: "Read", args: JSON.stringify({ path: "a.ts" }) }],
      },
      { role: "tool", toolName: "Read", text: "contents" },
      userMsg("Gère aussi le cas vide"),
      {
        role: "assistant",
        toolCalls: [{ name: "Edit", args: JSON.stringify({ file_path: "b.ts" }) }],
      },
      { role: "tool", toolName: "Edit", text: "1 addition, 0 deletions." },
    ])
    expect(story.steps.map(s => s.chap)).toEqual(["c1", "c1", "c2", "c2"])
  })

  it("handles an accented new-chapter keyword ('gère')", () => {
    const story = buildStory([
      userMsg("Construis le pricing book"),
      userMsg("Gère le cas où le fichier est vide."),
    ])
    expect(story.steps[1]!.route).toBe("newt")
    expect(story.chapters).toHaveLength(2)
  })
})
