import { describe, it, expect } from "vitest"
import { makeWorkBoardApp, workBoardApp, workBoardInputSchema } from "../work-board/index.js"
import { WORK_BOARD_HTML } from "../work-board/panel.js"

interface FakeTask {
  taskId: string
  boardId: string
  title: string
  status: string
  owner?: string
  rev: number
}

function fakeTask(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    taskId: "task_1",
    boardId: "ws:default",
    title: "Ship it",
    status: "pending",
    rev: 0,
    ...overrides,
  }
}

describe("workBoardInputSchema", () => {
  it("makes boardId optional", () => {
    expect(workBoardInputSchema.safeParse({}).success).toBe(true)
    expect(workBoardInputSchema.safeParse({ boardId: "tree:sess_abc" }).success).toBe(true)
  })
})

describe("makeWorkBoardApp", () => {
  it("exposes the builtin tool metadata", () => {
    const app = makeWorkBoardApp<FakeTask>({
      listTasks: () => ({ boardId: "ws:default", tasks: [] }),
    })
    expect(app.id).toBe("agentproto_work_board")
    expect(app.title).toBe("Work Board")
    expect(app.inputSchema.shape.boardId).toBeDefined()
    expect(app.html).toBe(WORK_BOARD_HTML)
  })

  it("execute() forwards the requested boardId to ops.listTasks", async () => {
    let seenBoardId: string | undefined
    const app = makeWorkBoardApp<FakeTask>({
      listTasks: (boardId) => {
        seenBoardId = boardId
        return { boardId: boardId ?? "ws:default", tasks: [fakeTask()] }
      },
    })
    const out = await app.execute!({ boardId: "tree:sess_root" })
    expect(seenBoardId).toBe("tree:sess_root")
    expect(out).toEqual({ boardId: "tree:sess_root", tasks: [fakeTask()] })
  })

  it("execute() resolves the caller's default board when boardId is omitted", async () => {
    const app = makeWorkBoardApp<FakeTask>({
      listTasks: (boardId) => ({ boardId: boardId ?? "ws:default", tasks: [] }),
    })
    const out = await app.execute!({})
    expect(out).toEqual({ boardId: "ws:default", tasks: [] })
  })
})

describe("workBoardApp (AppHandle / catalog path)", () => {
  it("is a zero-agent UI-only app whose static ui.html is the board panel", () => {
    expect(workBoardApp.id).toBe("@agentproto/work-board")
    expect(workBoardApp.agents).toEqual([])
    expect(workBoardApp.ui?.html).toBe(WORK_BOARD_HTML)
    expect(workBoardApp.ui?.title).toBe("Work Board")
    expect(workBoardApp.ui?.tools).toEqual([
      "task_list",
      "task_claim",
      "task_update",
      "task_create",
    ])
  })
})

describe("WORK_BOARD_HTML", () => {
  it("is a non-empty self-contained HTML document", () => {
    expect(WORK_BOARD_HTML.length).toBeGreaterThan(0)
    expect(WORK_BOARD_HTML).toContain("<!DOCTYPE html>")
  })

  it("polls task_list with full:true, not the compact projection", () => {
    // Compact `task_list` drops `verification` — the tell this panel exists
    // to render — so the panel must opt out of it explicitly.
    expect(WORK_BOARD_HTML).toContain("full: true")
    expect(WORK_BOARD_HTML).toContain("task_list")
  })

  it("writes go through task_claim/task_update/task_create, no second write path", () => {
    expect(WORK_BOARD_HTML).toContain("task_claim")
    expect(WORK_BOARD_HTML).toContain("task_update")
    expect(WORK_BOARD_HTML).toContain("task_create")
    expect(WORK_BOARD_HTML).not.toMatch(/PATCH\s*\/tasks/)
  })

  it("never renders an unclaimed task as 'pending' — always 'Unclaimed'", () => {
    expect(WORK_BOARD_HTML).toContain("Unclaimed")
  })

  it("renders the verification tell as three distinct labels", () => {
    expect(WORK_BOARD_HTML).toContain("t-gate")
    expect(WORK_BOARD_HTML).toContain("t-self")
    expect(WORK_BOARD_HTML).toContain("t-human")
  })
})
