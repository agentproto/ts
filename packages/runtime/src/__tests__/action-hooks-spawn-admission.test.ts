import { describe, expect, it } from "vitest"

import { evaluateSpawnAdmission } from "../action-hooks/spawn-admission.js"

describe("evaluateSpawnAdmission", () => {
  it("claim with no existing claim allows and carries no dedupe source", () => {
    expect(evaluateSpawnAdmission({
      stage: "claim",
      source: "explicit",
      existing: undefined,
    })).toEqual({ decision: { outcome: "allow" } })
  })

  it("claim with an existing successful claim reuses the session and keeps the source", () => {
    expect(evaluateSpawnAdmission({
      stage: "claim",
      source: "implicit",
      existing: { ok: true, sessionId: "session-1" },
    })).toEqual({
      decision: { outcome: "reuse", targetId: "session-1", code: "spawn_claim_hit" },
      dedupeSource: "implicit",
    })
  })

  it("claim with an existing failed claim denies with its code and message", () => {
    expect(evaluateSpawnAdmission({
      stage: "claim",
      source: "explicit",
      existing: { ok: false, code: "agent_spawn_failed", message: "adapter boot failed" },
    })).toEqual({
      decision: {
        outcome: "deny",
        code: "agent_spawn_failed",
        message: "adapter boot failed",
      },
    })
  })

  it("worktree policy without a rejection allows", () => {
    expect(evaluateSpawnAdmission({ stage: "worktree-policy" })).toEqual({
      decision: { outcome: "allow" },
    })
  })

  it("worktree policy with a rejection denies with worktree_disabled and the verbatim message", () => {
    expect(evaluateSpawnAdmission({
      stage: "worktree-policy",
      reject: { message: "worktrees are disabled" },
    })).toEqual({
      decision: {
        outcome: "deny",
        code: "worktree_disabled",
        message: "worktrees are disabled",
      },
    })
  })

  it("sync worktree collision without a session allows", () => {
    expect(evaluateSpawnAdmission({ stage: "worktree-collision-sync" })).toEqual({
      decision: { outcome: "allow" },
    })
  })

  it("sync worktree collision with a session reuses it as worktree-cwd", () => {
    expect(evaluateSpawnAdmission({
      stage: "worktree-collision-sync",
      collisionSessionId: "session-2",
    })).toEqual({
      decision: {
        outcome: "reuse",
        targetId: "session-2",
        code: "worktree_label_cwd_collision",
      },
      dedupeSource: "worktree-cwd",
    })
  })

  it("async worktree collision without a session allows", () => {
    expect(evaluateSpawnAdmission({
      stage: "worktree-collision-async",
      label: "fix login",
      cwd: "/repo/worktree",
    })).toEqual({ decision: { outcome: "allow" } })
  })

  it("async worktree collision with a session denies with the exact refusal message", () => {
    expect(evaluateSpawnAdmission({
      stage: "worktree-collision-async",
      collisionSessionId: "session-3",
      label: "fix login",
      cwd: "/repo/worktree",
    })).toEqual({
      decision: {
        outcome: "deny",
        code: "worktree_label_cwd_collision",
        message:
          'agent_start: refused — another LIVE session ("session-3") already has the ' +
          'same label ("fix login") and cwd ("/repo/worktree") as this worktree spawn. ' +
          "Not starting a second agent in the same worktree.",
      },
    })
  })
})
