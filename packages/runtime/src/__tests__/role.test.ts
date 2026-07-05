/**
 * Unit coverage for the pure role resolver (role.ts) — name lookup for
 * the two built-ins, unknown-name error, and depth-derived fallback
 * with/without a cutoff override. No fs, no daemon wiring — see
 * session-spawn.test.ts for the tool-gate enforcement at spawn time.
 */

import { describe, it, expect } from "vitest"
import {
  resolveRole,
  composeRoleContext,
  EXECUTOR_ROLE,
  SUPERVISOR_ROLE,
  DELEGATION_TOOL_NAMES,
  DEFAULT_ROLE_DEPTH_CUTOFF,
} from "../role.js"

describe("resolveRole", () => {
  it("resolves 'executor' by name regardless of depth", () => {
    expect(resolveRole("executor", 0)).toBe(EXECUTOR_ROLE)
    expect(resolveRole("executor", 5)).toBe(EXECUTOR_ROLE)
  })

  it("resolves 'supervisor' by name regardless of depth", () => {
    expect(resolveRole("supervisor", 0)).toBe(SUPERVISOR_ROLE)
    expect(resolveRole("supervisor", 5)).toBe(SUPERVISOR_ROLE)
  })

  it("throws a clear error on an unknown role name", () => {
    expect(() => resolveRole("reviewer", 0)).toThrow(/unknown role "reviewer"/)
  })

  it("derives supervisor below the default cutoff, executor at/above it", () => {
    expect(resolveRole(undefined, 0)).toBe(SUPERVISOR_ROLE)
    expect(resolveRole(undefined, 1)).toBe(EXECUTOR_ROLE)
    expect(resolveRole(undefined, 2)).toBe(EXECUTOR_ROLE)
  })

  it("respects an explicit cutoff override", () => {
    expect(resolveRole(undefined, 1, 2)).toBe(SUPERVISOR_ROLE)
    expect(resolveRole(undefined, 2, 2)).toBe(EXECUTOR_ROLE)
    expect(resolveRole(undefined, 0, 0)).toBe(EXECUTOR_ROLE)
  })

  it("default cutoff constant matches the documented value", () => {
    expect(DEFAULT_ROLE_DEPTH_CUTOFF).toBe(1)
  })
})

describe("composeRoleContext", () => {
  it("returns just the disposition when no promptAppend is given", () => {
    expect(composeRoleContext(EXECUTOR_ROLE)).toBe(EXECUTOR_ROLE.disposition)
  })

  it("layers promptAppend on top of the disposition, never replacing it", () => {
    const composed = composeRoleContext(EXECUTOR_ROLE, "focus on the CLI package")
    expect(composed.startsWith(EXECUTOR_ROLE.disposition)).toBe(true)
    expect(composed).toContain("focus on the CLI package")
  })
})

describe("DELEGATION_TOOL_NAMES", () => {
  it("includes at minimum the spawn + drive surface", () => {
    expect(DELEGATION_TOOL_NAMES).toContain("agent_start")
    expect(DELEGATION_TOOL_NAMES).toContain("agent_prompt")
  })
})

describe("built-in role shapes", () => {
  it("executor denies delegation", () => {
    expect(EXECUTOR_ROLE.toolPolicy.delegation).toBe("deny")
  })

  it("supervisor allows delegation", () => {
    expect(SUPERVISOR_ROLE.toolPolicy.delegation).toBe("allow")
  })
})
