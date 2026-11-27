/**
 * `defaults.permissionGrants`: which Claude Code allow rules a session gets
 * from its label. The built-in default grants the host-guard escalation
 * session `agentproto host stop-process`, and nothing else.
 */

import { describe, expect, it } from "vitest"

import {
  DEFAULT_PERMISSION_GRANTS,
  HOST_STOP_PROCESS_RULE,
  permissionAllowFor,
} from "../permission-grants.js"
import { agentprotoConfigSchema } from "../config-schema.js"

describe("permissionAllowFor", () => {
  const local = { adapter: "claude-code", label: "host-guard-escalation" }

  it("grants the escalation session the stop-process command by default", () => {
    expect(permissionAllowFor(undefined, local)).toEqual([HOST_STOP_PROCESS_RULE])
    expect(DEFAULT_PERMISSION_GRANTS["host-guard-escalation"]).toEqual(["Bash(agentproto host stop-process:*)"])
  })

  it("grants nothing to any other label, adapter, or a sandbox spawn", () => {
    expect(permissionAllowFor(undefined, { adapter: "claude-code", label: "worker" })).toBeUndefined()
    expect(permissionAllowFor(undefined, { adapter: "claude-code", label: undefined })).toBeUndefined()
    expect(permissionAllowFor(undefined, { adapter: "codex", label: "host-guard-escalation" })).toBeUndefined()
    expect(permissionAllowFor(undefined, { ...local, sandbox: { provider: "e2b" } })).toBeUndefined()
  })

  it("an operator's setting replaces the default; {} removes every grant", () => {
    expect(permissionAllowFor({ permissionGrants: {} }, local)).toBeUndefined()
    expect(
      permissionAllowFor({ permissionGrants: { reviewer: ["Bash(gh pr view:*)"] } }, { adapter: "claude-code", label: "reviewer" }),
    ).toEqual(["Bash(gh pr view:*)"])
    expect(permissionAllowFor({ permissionGrants: { reviewer: ["Bash(gh pr view:*)"] } }, local)).toBeUndefined()
  })

  it("drops a malformed rule", () => {
    expect(
      permissionAllowFor({ permissionGrants: { x: ["Bash(ok:*)", "not a rule", "Bash(a\nb)"] } }, { adapter: "claude-code", label: "x" }),
    ).toEqual(["Bash(ok:*)"])
  })

  it("the config schema accepts well-formed grants and refuses a malformed rule", () => {
    expect(
      agentprotoConfigSchema.safeParse({ defaults: { permissionGrants: { "host-guard-escalation": [HOST_STOP_PROCESS_RULE] } } }).success,
    ).toBe(true)
    expect(agentprotoConfigSchema.safeParse({ defaults: { permissionGrants: { x: ["rm -rf /"] } } }).success).toBe(false)
  })
})
