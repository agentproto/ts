import { describe, it, expect, vi } from "vitest"
import type { ApprovalRequest } from "@agentproto/workflow-runtime"
import { makeApprove } from "../approve.js"

const req: ApprovalRequest = { stepId: "approval", prompt: "Gate passed. Approve worktree cleanup?", approvers: [] }

describe("makeApprove", () => {
  it("--yes auto-approves without touching the tty", async () => {
    const ask = vi.fn()
    const hasTty = vi.fn(() => true)
    const approve = makeApprove({ yes: true }, { hasTty, ask })
    await expect(approve(req)).resolves.toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it("no TTY attached (non-interactive) does not approve", async () => {
    const ask = vi.fn()
    const hasTty = vi.fn(() => false)
    const approve = makeApprove({ yes: false }, { hasTty, ask })
    await expect(approve(req)).resolves.toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it("prompts on the tty and approves on 'y'", async () => {
    const ask = vi.fn(async () => "y")
    const hasTty = vi.fn(() => true)
    const approve = makeApprove({ yes: false }, { hasTty, ask })
    await expect(approve(req)).resolves.toBe(true)
    expect(ask).toHaveBeenCalledWith(expect.stringContaining(req.prompt))
  })

  it("prompts on the tty and rejects on anything but y/yes", async () => {
    const hasTty = vi.fn(() => true)
    for (const answer of ["n", "no", "", "nah"]) {
      const ask = vi.fn(async () => answer)
      const approve = makeApprove({ yes: false }, { hasTty, ask })
      await expect(approve(req)).resolves.toBe(false)
    }
  })
})
