import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restartInPlaceEligible } from "../session-restart-core.js"
import {
  createSessionsRegistry,
  type AgentSessionResumer,
  type SessionDescriptor,
} from "../sessions.js"

/**
 * Regression: a provider-box session's `cwd` is a path INSIDE the box
 * (`/home/user/...`). The in-place resume path re-spawns the adapter on the
 * HOST with that cwd, so Node fails with `spawn <absolute npx> ENOENT` (a
 * missing working directory reports the same ENOENT as a missing binary), and
 * the restart then falls back to the new-id sandbox restart. Both gates below
 * must refuse the host spawn instead.
 */
describe("provider-box sessions are never resumed in place on the host", () => {
  const base = (over: Partial<SessionDescriptor> = {}): SessionDescriptor => ({
    id: "sess_box",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "opencode (agent)",
    pid: null,
    status: "killed",
    endedReason: "daemon-restart",
    startedAt: "2026-07-23T00:00:00Z",
    adapterSlug: "opencode",
    adapterSessionId: "acp-box",
    cwd: "/home/user/agentproto",
    ...over,
  })

  const box = base({ remote: true, sandboxId: "box_123", sandboxProvider: "e2b" })

  it("restartInPlaceEligible refuses a provider-box row", () => {
    expect(restartInPlaceEligible(box)).toBe(false)
    // A local row with the same shape stays eligible.
    expect(restartInPlaceEligible(base())).toBe(true)
    // A remote CLOUD row (no provider sandbox id) still resumes in place.
    expect(restartInPlaceEligible(base({ remote: true }))).toBe(true)
  })

  describe("lazy resume-on-prompt", () => {
    let tmp: string
    let persistPath: string

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "box-in-place-"))
      persistPath = join(tmp, "sessions.json")
    })

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true })
    })

    function seedBoxRow(): string {
      const id = "sess_box"
      writeFileSync(
        persistPath,
        JSON.stringify({
          savedAt: "2026-07-23T00:00:00Z",
          sessions: [
            {
              ...box,
              id,
              status: "running",
              busy: false,
            },
          ],
        }),
      )
      return id
    }

    it("does not spawn the adapter on the host for a box cwd", async () => {
      const id = seedBoxRow()
      const resumer = vi.fn(async () => {
        throw new Error("adapter must not be spawned for a box cwd")
      }) as unknown as AgentSessionResumer
      const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
      try {
        await expect(reg.sendPrompt(id, "continue")).rejects.toThrow(/provider sandbox|session_restart/)
        expect(resumer).not.toHaveBeenCalled()
      } finally {
        reg.shutdown()
      }
    })
  })
})
