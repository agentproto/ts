import { describe, expect, it } from "vitest"

import type { TaskRecord } from "../client/types.js"
import { buildWorkWebviewModel, relativeAgeFrom, verificationTell } from "./workWebview.logic.js"

const NOW = Date.parse("2026-09-12T12:00:00Z")

function task(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    boardId: "ws:ws",
    title: `Task ${overrides.taskId}`,
    status: "pending",
    createdBy: "operator",
    rev: 1,
    createdAt: "2026-09-12T11:00:00Z",
    updatedAt: "2026-09-12T11:50:00Z",
    ...overrides,
  } as TaskRecord
}

describe("verificationTell", () => {
  it("renders the four-way tell honestly", () => {
    expect(verificationTell({ status: "done", verification: { kind: "gate", ts: "" } })).toBe("✓ gate")
    expect(verificationTell({ status: "done", verification: { kind: "self-report", by: "s1", ts: "" } })).toBe(
      "self-report",
    )
    expect(verificationTell({ status: "done", verification: { kind: "human", ts: "" } })).toBe("human")
  })

  it("a declared verify with nothing verified is a grey gated tag, not a green check", () => {
    expect(verificationTell({ status: "in_progress", verify: { command: "pnpm test" } })).toBe("gated")
    expect(verificationTell({ status: "in_progress" })).toBe("")
  })

  it("never throws on a malformed payload", () => {
    expect(verificationTell(undefined)).toBe("")
    expect(verificationTell(null)).toBe("")
    expect(verificationTell(42 as unknown as TaskRecord)).toBe("")
    expect(verificationTell({ status: "done", verification: { kind: "mystery" } } as unknown as TaskRecord)).toBe("")
  })
})

describe("relativeAgeFrom", () => {
  it("formats the four buckets", () => {
    expect(relativeAgeFrom(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now")
    expect(relativeAgeFrom(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe("4m ago")
    expect(relativeAgeFrom(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago")
    expect(relativeAgeFrom(new Date(NOW - 6 * 86_400_000).toISOString(), NOW)).toBe("6d ago")
  })

  it("yields empty on unparseable input instead of throwing", () => {
    expect(relativeAgeFrom(undefined, NOW)).toBe("")
    expect(relativeAgeFrom("not-a-date", NOW)).toBe("")
  })
})

describe("buildWorkWebviewModel", () => {
  it("groups in the fixed order Unclaimed · In progress · Done · Failed", () => {
    const model = buildWorkWebviewModel({
      tasks: [
        task({ taskId: "t1", status: "done" }),
        task({ taskId: "t2", status: "in_progress", owner: "sess_a" }),
        task({ taskId: "t3", status: "pending" }),
        task({ taskId: "t4", status: "failed" }),
      ],
      now: NOW,
    })
    expect(model.groups.map(g => g.key)).toEqual(["unclaimed", "in_progress", "done", "failed"])
    expect(model.groups.map(g => g.label)).toEqual(["Unclaimed", "In progress", "Done", "Failed"])
    expect(model.shownCount).toBe(4)
  })

  it("renders pending as Unclaimed — never as Pending", () => {
    const model = buildWorkWebviewModel({ tasks: [task({ taskId: "t1" })], now: NOW })
    expect(model.groups[0]!.label).toBe("Unclaimed")
    expect(JSON.stringify(model)).not.toContain("Pending")
    expect(model.groups[0]!.rows[0]!.owner).toBeUndefined()
  })

  it("folds cancelled into Failed, tagged distinctly — the board app's own fold", () => {
    const model = buildWorkWebviewModel({
      tasks: [task({ taskId: "c1", status: "cancelled" }), task({ taskId: "f1", status: "failed" })],
      now: NOW,
    })
    const failed = model.groups.find(g => g.key === "failed")!
    expect(failed.rows.map(r => r.taskId)).toEqual(["c1", "f1"])
    expect(failed.rows.find(r => r.taskId === "c1")!.cancelled).toBe(true)
  })

  it("carries owner, tell and relative age on each row", () => {
    const model = buildWorkWebviewModel({
      tasks: [
        task({
          taskId: "t1",
          status: "in_progress",
          owner: "sess_a",
          verify: { command: "pnpm test" },
          updatedAt: new Date(NOW - 2 * 60_000).toISOString(),
        }),
      ],
      now: NOW,
    })
    const row = model.groups.find(g => g.key === "in_progress")!.rows[0]!
    expect(row.owner).toBe("sess_a")
    expect(row.tell).toBe("gated")
    expect(row.age).toBe("2m ago")
  })

  it("sorts rows newest-updated first within a group", () => {
    const model = buildWorkWebviewModel({
      tasks: [
        task({ taskId: "old", updatedAt: new Date(NOW - 60_000).toISOString() }),
        task({ taskId: "new", updatedAt: new Date(NOW - 1_000).toISOString() }),
      ],
      now: NOW,
    })
    expect(model.groups[0]!.rows.map(r => r.taskId)).toEqual(["new", "old"])
  })

  it("never throws on malformed input; empty input yields the four empty groups", () => {
    expect(buildWorkWebviewModel({ tasks: undefined, now: NOW }).shownCount).toBe(0)
    expect(buildWorkWebviewModel({ tasks: [null, 42] as unknown as TaskRecord[], now: NOW }).shownCount).toBe(0)
    const empty = buildWorkWebviewModel({ tasks: [], now: NOW })
    expect(empty.groups.map(g => g.key)).toEqual(["unclaimed", "in_progress", "done", "failed"])
  })
})
