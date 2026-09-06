import { describe, expect, it } from "vitest"

import {
  ASK_LONG_CHARS,
  buildBook,
  chapterDurationMs,
  formatChapterDuration,
  htmlToText,
  TITLE_MAX_CHARS,
} from "./conversationBook.logic.js"
import type {
  PresentedActivitySegment,
  PresentedSegment,
  PresentedToolSegment,
  PresentedTurn,
} from "./conversation.js"

// ── segment/turn builders ────────────────────────────────────────────────
function userTurn(id: string, html: string, startedAt?: string): PresentedTurn {
  return {
    id,
    role: "user",
    segments: [{ kind: "user", id: id + "-u", html }],
    ...(startedAt ? { startedAt } : {}),
  }
}

function assistantTurn(id: string, segments: PresentedSegment[], startedAt?: string): PresentedTurn {
  return { id, role: "assistant", segments, ...(startedAt ? { startedAt } : {}) }
}

function text(id: string, html: string): PresentedSegment {
  return { kind: "assistant-text", id, html }
}

function tool(id: string, status: PresentedToolSegment["status"] = "ok"): PresentedToolSegment {
  return { kind: "tool", id, toolName: "bash", isError: status === "error", status }
}

function activity(id: string, children: PresentedActivitySegment["children"], status: PresentedActivitySegment["status"] = "ok"): PresentedActivitySegment {
  return { kind: "activity", id, children, summary: "", count: children.length, status }
}

describe("buildBook — chapter segmentation", () => {
  it("returns no chapters for an empty timeline", () => {
    expect(buildBook([])).toEqual([])
  })

  it("groups a user prompt and its answering assistant turn into ONE chapter", () => {
    const chapters = buildBook([
      userTurn("turn-1", "Fix the bug"),
      assistantTurn("turn-2", [text("s2", "Done, the shell was lying.")]),
    ])
    expect(chapters).toHaveLength(1)
    expect(chapters[0]!.origin).toBe("you")
    expect(chapters[0]!.id).toBe("turn-1")
    expect(chapters[0]!.ask?.html).toBe("Fix the bug")
    expect(chapters[0]!.narration.map(n => n.id)).toEqual(["s2"])
  })

  it("splits a second assistant turn (a turn-end split, no new prompt) into its OWN agent chapter", () => {
    const chapters = buildBook([
      userTurn("turn-1", "Do it"),
      assistantTurn("turn-2", [text("s2", "First answer.")]),
      assistantTurn("turn-4", [text("s4", "Second, unprompted.")]),
    ])
    expect(chapters).toHaveLength(2)
    expect(chapters[0]!.origin).toBe("you")
    expect(chapters[1]!.origin).toBe("agent")
    expect(chapters[1]!.ask).toBeUndefined()
    expect(chapters[1]!.narration.map(n => n.id)).toEqual(["s4"])
  })

  it("opens a fresh chapter on every user prompt, even back-to-back", () => {
    const chapters = buildBook([
      userTurn("turn-1", "First ask"),
      userTurn("turn-2", "Second ask"),
    ])
    expect(chapters.map(c => c.id)).toEqual(["turn-1", "turn-2"])
    expect(chapters.every(c => c.origin === "you")).toBe(true)
    // The first chapter never got an assistant turn — ask-only, no narration.
    expect(chapters[0]!.narration).toEqual([])
  })

  it("keeps a live user chapter (prompt with no answer yet) as ask-only", () => {
    const chapters = buildBook([userTurn("turn-1", "Working on it?")])
    expect(chapters).toHaveLength(1)
    expect(chapters[0]!.ask?.html).toBe("Working on it?")
    expect(chapters[0]!.narration).toEqual([])
  })
})

describe("buildBook — step tally + partitioning", () => {
  it("folds activity/tool/reasoning into steps and keeps plan/error/question as notices", () => {
    const chapter = buildBook([
      userTurn("turn-1", "go"),
      assistantTurn("turn-2", [
        text("t", "Narration."),
        activity("a", [tool("a1", "ok"), tool("a2", "error"), tool("a3", "ok")]),
        { kind: "tool", id: "lone", toolName: "read", isError: false, status: "ok" },
        { kind: "plan", id: "p", entries: [], done: 0, total: 0 },
        { kind: "error", id: "e", text: "boom" },
        { kind: "agent-question", id: "q", options: ["yes", "no"] },
      ]),
    ])[0]!
    expect(chapter.narration.map(n => n.id)).toEqual(["t"])
    expect(chapter.steps.segments.map(s => s.id)).toEqual(["a", "lone"])
    expect(chapter.steps.count).toBe(4) // 3 in the activity + 1 lone tool
    expect(chapter.steps.failed).toBe(1) // one errored tool inside the activity
    expect(chapter.notices.map(s => s.id)).toEqual(["p", "e", "q"])
  })

  it("counts a lone errored tool toward failed", () => {
    const chapter = buildBook([
      assistantTurn("turn-1", [tool("only", "error")]),
    ])[0]!
    expect(chapter.steps.count).toBe(1)
    expect(chapter.steps.failed).toBe(1)
  })
})

describe("buildBook — titles", () => {
  it("takes the first narration sentence, dropping the trailing period", () => {
    const chapter = buildBook([
      assistantTurn("turn-1", [text("s", "The shell was lying. Then more detail follows here.")]),
    ])[0]!
    expect(chapter.title).toBe("The shell was lying")
  })

  it("clamps a long first sentence to ~70 chars with an ellipsis", () => {
    const long = "x".repeat(120) + "."
    const chapter = buildBook([assistantTurn("turn-1", [text("s", long)])])[0]!
    expect(chapter.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(chapter.title.endsWith("…")).toBe(true)
  })

  it("strips markdown HTML tags out of the title", () => {
    const chapter = buildBook([
      assistantTurn("turn-1", [text("s", "The <code>zsh -ic</code> fix worked.")]),
    ])[0]!
    expect(chapter.title).toBe("The zsh -ic fix worked")
  })

  it("titles from ALL narration blocks joined, so a split fragment never titles a chapter alone", () => {
    // Defense in depth for the debounce-split bug: even if a reducer upstream
    // left a sentence split around a tool card, the title sees the joined
    // narration — never just the first (fragment) block.
    const chapter = buildBook([
      assistantTurn("turn-1", [text("s1", "Bien re"), tool("t1"), text("s2", "çu — suite.")]),
    ])[0]!
    expect(chapter.title).toBe("Bien re çu — suite")
  })

  it("never titles a chapter with the ask — a no-narration chapter shows the generic marker", () => {
    // The human's prompt is its own pinned block above the chapter; a response
    // chapter that hasn't narrated yet must not borrow the user's words as its
    // title (that conflation is exactly what dissociating the ask fixes).
    const chapter = buildBook([userTurn("turn-1", "Diagnose the boot failure please.")])[0]!
    expect(chapter.title).toBe("Working…")
  })

  it("falls back to a generic marker when there is nothing to title", () => {
    const chapter = buildBook([assistantTurn("turn-1", [tool("t", "ok")])])[0]!
    expect(chapter.title).toBe("Working…")
  })
})

describe("buildBook — ask.source", () => {
  it("carries the turn's promptSource onto the ask; absent for a human turn", () => {
    const supervised: PresentedTurn = {
      ...userTurn("turn-1", "status?"),
      promptSource: "agent:sess_boss1",
    }
    const chapters = buildBook([supervised, userTurn("turn-2", "a human turn")])
    expect(chapters[0]!.ask?.source).toBe("agent:sess_boss1")
    expect(chapters[1]!.ask?.source).toBeUndefined()
  })
})

describe("buildBook — ask.long", () => {
  it("flags a long ask as truncatable and a short one as not", () => {
    const short = buildBook([userTurn("turn-1", "short")])[0]!
    expect(short.ask?.long).toBe(false)
    const long = buildBook([userTurn("turn-2", "y".repeat(ASK_LONG_CHARS + 1))])[0]!
    expect(long.ask?.long).toBe(true)
  })
})

describe("chapterDurationMs", () => {
  const chapters = buildBook([
    userTurn("turn-1", "a", "2026-01-01T00:00:00Z"),
    assistantTurn("turn-2", [text("s", "x.")], "2026-01-01T00:00:05Z"),
    userTurn("turn-3", "b", "2026-01-01T00:01:09Z"),
    assistantTurn("turn-4", [text("s4", "y.")], "2026-01-01T00:01:20Z"),
  ])

  it("measures the gap from a chapter's start to the next chapter's start", () => {
    // turn-1 -> turn-3 = 69s
    expect(chapterDurationMs(chapters, 0)).toBe(69_000)
  })

  it("returns undefined for the last chapter (unknown end)", () => {
    expect(chapterDurationMs(chapters, chapters.length - 1)).toBeUndefined()
  })

  it("returns undefined when a start time is missing", () => {
    const noTs = buildBook([userTurn("turn-1", "a"), userTurn("turn-2", "b")])
    expect(chapterDurationMs(noTs, 0)).toBeUndefined()
  })
})

describe("formatChapterDuration", () => {
  it("formats seconds, minutes, and hours per the mock", () => {
    expect(formatChapterDuration(18_000)).toBe("18s")
    expect(formatChapterDuration(64_000)).toBe("1m 04s")
    expect(formatChapterDuration(3_720_000)).toBe("1h 02m")
  })
})

describe("htmlToText", () => {
  it("undoes tags, entities, and collapses whitespace", () => {
    expect(htmlToText("<p>a &amp;&nbsp;b   <b>c</b></p>")).toBe("a & b c")
  })
})
