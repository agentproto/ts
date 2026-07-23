import { describe, expect, it, vi } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  canResumeInPlace,
  describeResume,
  resumeInputBox,
  resumeInterruptedNotice,
  runResumeInPlace,
} from "./sessionResume.logic.js"

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess_ghost1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: null,
    status: "killed",
    startedAt: "2026-01-01T00:00:00Z",
    endedReason: "daemon-restart",
    ...overrides,
  }
}

describe("canResumeInPlace", () => {
  it("is true for a daemon-restart agent-cli ghost", () => {
    expect(canResumeInPlace(session())).toBe(true)
  })
  it("is false for exited / error / plain user-killed rows", () => {
    expect(canResumeInPlace(session({ status: "exited", endedReason: undefined }))).toBe(false)
    expect(canResumeInPlace(session({ status: "error", endedReason: undefined }))).toBe(false)
    expect(canResumeInPlace(session({ status: "killed", endedReason: undefined }))).toBe(false)
  })
  it("is false for a live session", () => {
    expect(canResumeInPlace(session({ status: "running", endedReason: undefined }))).toBe(false)
  })
  it("is false for a pty ghost", () => {
    expect(canResumeInPlace(session({ pty: true }))).toBe(false)
  })
})

describe("resumeInterruptedNotice", () => {
  it("returns the NOT-re-run notice when the turn was interrupted", () => {
    const notice = resumeInterruptedNotice(session({ interrupted: true }))
    expect(notice).toBeTypeOf("string")
    expect(notice).toContain("NOT re-run")
  })
  it("is undefined when the ghost was idle at death (nothing lost)", () => {
    expect(resumeInterruptedNotice(session({ interrupted: false }))).toBeUndefined()
    expect(resumeInterruptedNotice(session())).toBeUndefined()
  })
})

describe("resumeInputBox", () => {
  it("folds the interrupted notice into the prompt line when the turn was dropped", () => {
    const box = resumeInputBox(session({ interrupted: true }))
    expect(box.prompt).toContain("NOT re-run")
    expect(box.placeHolder).toContain("continue the interrupted turn")
  })
  it("omits the notice for an idle-at-death ghost", () => {
    const box = resumeInputBox(session())
    expect(box.prompt).not.toContain("NOT re-run")
  })
})

describe("describeResume", () => {
  it("names the SAME id and states no new id was minted", () => {
    const message = describeResume(session({ id: "sess_ghost1" }))
    expect(message).toContain("sess_ghost1")
    expect(message).toContain("same id")
  })
})

describe("runResumeInPlace", () => {
  it("sends a PLAIN prompt to the SAME session id (not a new-id restart)", async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const getInput = vi.fn().mockResolvedValue("keep going")
    const s = session({ id: "sess_ghost1" })

    const outcome = await runResumeInPlace(s, { getInput, sendPrompt })

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    // The whole point of resume-in-place: the id is unchanged.
    expect(sendPrompt).toHaveBeenCalledWith("sess_ghost1", "keep going")
    expect(outcome).toEqual({ resumed: true, id: "sess_ghost1", text: "keep going" })
  })

  it("does nothing when the user cancels the input box", async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const getInput = vi.fn().mockResolvedValue(undefined)

    const outcome = await runResumeInPlace(session(), { getInput, sendPrompt })

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(outcome).toEqual({ resumed: false })
  })

  it("does nothing on an empty prompt (no accidental empty resume)", async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const getInput = vi.fn().mockResolvedValue("")

    const outcome = await runResumeInPlace(session(), { getInput, sendPrompt })

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(outcome).toEqual({ resumed: false })
  })

  it("surfaces the interrupted notice through the input box it presents", async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const getInput = vi.fn().mockResolvedValue("continue")

    await runResumeInPlace(session({ interrupted: true }), { getInput, sendPrompt })

    const box = getInput.mock.calls[0]![0]
    expect(box.prompt).toContain("NOT re-run")
  })
})
