import { describe, expect, it } from "vitest"

import type { SessionEventRecord } from "../data/types"
import { escapeHtml, renderMarkdown } from "./markdown"
import { presentConversation, reduceConversation } from "./conversation"

let seq = 0
const rec = (r: Partial<SessionEventRecord> & { kind: string }): SessionEventRecord => ({
  seq: ++seq,
  ts: "2026-10-28T10:00:00Z",
  ...r,
})
const present = (records: SessionEventRecord[]) =>
  presentConversation(reduceConversation("s1", records), { renderMarkdown, escapeHtml })
const segments = (records: SessionEventRecord[]) => present(records).turns.flatMap((t) => t.segments)

describe("mode-changed", () => {
  it("renders a compact row for a caller switch", () => {
    seq = 0
    expect(
      segments([rec({ kind: "mode-changed", modeId: "execute", previousModeId: "plan", cause: "caller" })]),
    ).toEqual([{ kind: "mode-changed", id: "seg-1", text: "Mode: plan -> execute" }])
  })

  it("says by agent and carries the reason", () => {
    seq = 0
    expect(
      segments([
        rec({
          kind: "mode-changed",
          modeId: "execute",
          previousModeId: "plan",
          cause: "agent",
          reason: "plan approved",
        }),
      ]),
    ).toEqual([{ kind: "mode-changed", id: "seg-1", text: "Mode: plan -> execute · by agent · plan approved" }])
  })

  it("keeps the row in order between the agent's text", () => {
    seq = 0
    const out = segments([
      rec({ kind: "text-delta", text: "before\n" }),
      rec({ kind: "mode-changed", modeId: "execute", previousModeId: "plan", cause: "agent" }),
      rec({ kind: "text-delta", text: "after\n" }),
    ])
    expect(out.map((s) => s.kind)).toEqual(["assistant-text", "mode-changed", "assistant-text"])
  })

  it("ignores a record with no mode id", () => {
    seq = 0
    expect(segments([rec({ kind: "mode-changed", cause: "agent" })])).toEqual([])
  })
})

describe("agent-prompt", () => {
  const options = [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ]

  it("renders a legacy prompt exactly as before", () => {
    seq = 0
    expect(segments([rec({ kind: "agent-prompt", toolCallId: "p1", options })])).toEqual([
      { kind: "agent-question", id: "seg-1", options: ["Allow", "Deny"] },
    ])
  })

  it("renders an explicit tool-permission prompt exactly as before", () => {
    seq = 0
    expect(
      segments([rec({ kind: "agent-prompt", toolCallId: "p1", options, request: "tool-permission" })]),
    ).toEqual([{ kind: "agent-question", id: "seg-1", options: ["Allow", "Deny"] }])
  })

  it("carries the question text and choices of a question prompt", () => {
    seq = 0
    const [seg] = segments([
      rec({
        kind: "agent-prompt",
        toolCallId: "p1",
        request: "question",
        options: [
          { optionId: "answer:0", name: "Yes", kind: "allow_once" },
          { optionId: "decline", name: "Decline to answer", kind: "reject_once" },
        ],
        question: { prompt: "Ship it?", choices: [{ optionId: "answer:0", label: "Yes" }], allowFreeText: false },
      }),
    ])
    expect(seg).toMatchObject({
      kind: "agent-question",
      options: ["Yes", "Decline to answer"],
      prompt: { request: "question", text: "Ship it?", choices: ["Yes"], freeText: false },
    })
  })

  it("marks a free-text question", () => {
    seq = 0
    const [seg] = segments([
      rec({
        kind: "agent-prompt",
        toolCallId: "p1",
        request: "question",
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
        question: { prompt: "Which branch?", choices: [], allowFreeText: true, freeTextOptionId: "answer" },
      }),
    ])
    expect(seg).toMatchObject({ prompt: { request: "question", text: "Which branch?", choices: [], freeText: true } })
  })

  it("renders the plan of a plan-approval prompt as safe markdown, with its target mode", () => {
    seq = 0
    const [seg] = segments([
      rec({
        kind: "agent-prompt",
        toolCallId: "p1",
        request: "plan-approval",
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        planApproval: {
          plan: "**Step 1** <script>x</script>",
          targetModeId: "execute",
          approveOptionId: "approve",
          rejectOptionId: "reject",
        },
      }),
    ])
    expect(seg).toMatchObject({
      kind: "agent-question",
      prompt: {
        request: "plan-approval",
        planHtml: "<p><strong>Step 1</strong> &lt;script&gt;x&lt;/script&gt;</p>",
        targetModeId: "execute",
      },
    })
  })

  it("falls back to the legacy row when the typed payload is malformed", () => {
    seq = 0
    expect(
      segments([rec({ kind: "agent-prompt", toolCallId: "p1", options, request: "question", question: { prompt: 1 } })]),
    ).toEqual([{ kind: "agent-question", id: "seg-1", options: ["Allow", "Deny"] }])
  })
})
