/**
 * Typed restart failures: `code` + human `reason` + optional `action`, and
 * the wire payload every transport (`POST /sessions/:id/restart`, the
 * `session_restart` MCP verb, the CLI) turns into a sentence and a button.
 *
 * The sandbox failure PATHS are covered where they run —
 * `session-restart-sandbox.test.ts`. This file is the vocabulary itself:
 * every code has a reason, the blocker strings map onto their code, and the
 * payload only appears for an error that actually carries a code (so an
 * uncoded failure keeps today's `{error:"restart_failed", message}` shape).
 */

import { describe, it, expect } from "vitest"

import {
  RestartOverrideError,
  SESSION_RESTART_REASONS,
  SessionRestartError,
  restartBlockerCode,
  sessionRestartErrorPayload,
  type SessionRestartAction,
  type SessionRestartErrorCode,
} from "../session-restart-core.js"
import { SessionRetiredError } from "../sessions.js"

/** Every code the restart vocabulary promises — the "at least" list. */
const ALL_CODES: SessionRestartErrorCode[] = [
  "sandbox_gone",
  "sandbox_unreachable",
  "sandbox_provider_missing",
  "sandbox_box_start_failed",
  "no_workspace",
  "no_workspace_remote",
  "no_known_branch",
  "adapter_not_found",
  "unsupported_strategy",
  "retired",
  "override_invalid",
]

describe("SESSION_RESTART_REASONS", () => {
  it("carries a distinct English sentence for every code", () => {
    for (const code of ALL_CODES) {
      const reason = SESSION_RESTART_REASONS[code]
      expect(reason, `no reason for ${code}`).toBeTruthy()
      expect(reason.length).toBeGreaterThan(10)
      expect(reason.endsWith("."), `${code} reason must be a sentence: ${reason}`).toBe(true)
    }
    const sentences = ALL_CODES.map(code => SESSION_RESTART_REASONS[code])
    expect(new Set(sentences).size).toBe(sentences.length)
  })
})

describe("restartBlockerCode", () => {
  it("maps each spawnOnFreshBox why-text onto its code", () => {
    expect(
      restartBlockerCode(
        `the session is not tied to a registered workspace, so there is no remote to clone ` +
          `into a new box. Spawn a fresh session on a workspace that has a remote ` +
          "(`agentproto workspace remote set <slug> --url … --token-stdin`).",
      ),
    ).toBe("no_workspace")

    expect(
      restartBlockerCode(
        `workspace "agentproto" has no remote configured and the session recorded no work ` +
          `branch to resume from, so a new box has nothing to clone. Configure one with ` +
          "`agentproto workspace remote set agentproto --url … --token-stdin` and restart the session.",
      ),
    ).toBe("no_workspace_remote")

    expect(
      restartBlockerCode(
        `workspace "scratch" is no longer registered, so a new box has nothing to clone. ` +
          "Configure one with `agentproto workspace remote set scratch --url … --token-stdin`.",
      ),
    ).toBe("no_workspace_remote")

    expect(
      restartBlockerCode(
        `workspace "scratch" has no git remote and no tarball checkpoint was saved before ` +
          `the box died, so there is nothing to restore. Give it a remote ` +
          "(`agentproto workspace remote set scratch --url … --token-stdin`) so future sessions are recoverable.",
      ),
    ).toBe("no_workspace_remote")
  })

  it("names a missing work branch as no_known_branch, and an unrecognised blocker as the lost box", () => {
    expect(
      restartBlockerCode(
        "the session recorded no work branch to resume from, so there is nothing to check out.",
      ),
    ).toBe("no_known_branch")
    expect(restartBlockerCode("something we have never seen before")).toBe("sandbox_gone")
  })
})

describe("SessionRestartError", () => {
  it("defaults its reason from the code and keeps the technical message intact", () => {
    const err = new SessionRestartError("sandbox_gone", "restartAgentSession: sandbox \"sbx_1\" expired")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("SessionRestartError")
    expect(err.code).toBe("sandbox_gone")
    expect(err.reason).toBe(SESSION_RESTART_REASONS.sandbox_gone)
    expect(err.message).toBe('restartAgentSession: sandbox "sbx_1" expired')
    expect(err.status).toBe(500)
    expect(err.action).toBeUndefined()
  })

  it("carries an action hint and a per-throw reason when one is given", () => {
    const action: SessionRestartAction = { kind: "spawn-on-branch", branch: "wt/resume-me" }
    const err = new SessionRestartError("no_known_branch", "detail", {
      reason: "The session recorded no work branch.",
      action,
      status: 409,
    })
    expect(err.reason).toBe("The session recorded no work branch.")
    expect(err.action).toEqual(action)
    expect(err.status).toBe(409)
  })

  it("keeps RestartOverrideError an instanceof of both, at 400", () => {
    const err = new RestartOverrideError("restart access override: no auth profile \"x\" found.")
    expect(err).toBeInstanceOf(RestartOverrideError)
    expect(err).toBeInstanceOf(SessionRestartError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("RestartOverrideError")
    expect(err.code).toBe("override_invalid")
    expect(err.status).toBe(400)
    expect(err.message).toBe('restart access override: no auth profile "x" found.')
  })
})

describe("sessionRestartErrorPayload", () => {
  it("nests code/reason/action/message for a typed restart failure", () => {
    const err = new SessionRestartError("sandbox_gone", "restartAgentSession: sandbox \"sbx_1\" expired", {
      action: { kind: "spawn-fresh" },
    })
    expect(sessionRestartErrorPayload(err)).toEqual({
      error: {
        code: "sandbox_gone",
        reason: SESSION_RESTART_REASONS.sandbox_gone,
        message: 'restartAgentSession: sandbox "sbx_1" expired',
        action: { kind: "spawn-fresh" },
      },
      message: 'restartAgentSession: sandbox "sbx_1" expired',
    })
  })

  it("reports a rejected override as override_invalid with its 400 text", () => {
    const payload = sessionRestartErrorPayload(
      new RestartOverrideError("restart access override: no auth profile \"nope\" found."),
    )
    expect(payload?.error.code).toBe("override_invalid")
    expect(payload?.error.reason).toBe(SESSION_RESTART_REASONS.override_invalid)
    expect(payload?.error.message).toMatch(/no auth profile "nope"/)
    expect(payload?.message).toBe(payload?.error.message)
  })

  it("maps a retired row onto code `retired`, naming the successor when there is one", () => {
    const superseded = new SessionRetiredError("sess_old", "killed", "restartPreferInPlace", "sess_new")
    const payload = sessionRestartErrorPayload(superseded)
    expect(payload?.error.code).toBe("retired")
    expect(payload?.error.reason).toContain("sess_new")
    expect(payload?.error.message).toBe(superseded.message)

    const retired = new SessionRetiredError("sess_old", "killed", "restartPreferInPlace")
    expect(sessionRestartErrorPayload(retired)?.error.reason).toBe(
      SESSION_RESTART_REASONS.retired,
    )
  })

  it("returns undefined for an error with no restart code — the caller keeps today's shape", () => {
    expect(sessionRestartErrorPayload(new Error("spawn ENOENT"))).toBeUndefined()
    expect(sessionRestartErrorPayload("boom")).toBeUndefined()
    expect(sessionRestartErrorPayload(undefined)).toBeUndefined()
  })
})
