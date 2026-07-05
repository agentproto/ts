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
  canSpawn,
  listRoles,
  spawnableRolesFor,
  mergeRoleRegistry,
  EXECUTOR_ROLE,
  SUPERVISOR_ROLE,
  DELEGATION_TOOL_NAMES,
  DEFAULT_ROLE_DEPTH_CUTOFF,
  type RoleProfile,
} from "../role.js"

const PLANNER_ROLE: RoleProfile = {
  name: "planner",
  disposition: "You plan work and delegate execution.",
  toolPolicy: { delegation: "allow" },
  level: 50,
}

const REVIEWER_ROLE: RoleProfile = {
  name: "reviewer",
  disposition: "You review code changes.",
  toolPolicy: { delegation: "deny" },
  level: 10,
}

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

  it("executor (spawnable = []) gets no 'Roles you may spawn' line — back-compat with #214", () => {
    expect(composeRoleContext(EXECUTOR_ROLE)).toBe(EXECUTOR_ROLE.disposition)
    expect(composeRoleContext(EXECUTOR_ROLE)).not.toContain("Roles you may spawn")
  })

  it("supervisor (a delegating role) gets a 'Roles you may spawn' line naming executor (and itself, a peer)", () => {
    const composed = composeRoleContext(SUPERVISOR_ROLE)
    expect(composed).toContain("Roles you may spawn: executor, supervisor.")
  })

  it("orders disposition, then the spawn line, then promptAppend", () => {
    const composed = composeRoleContext(SUPERVISOR_ROLE, "extra instructions")
    const dispositionIdx = composed.indexOf(SUPERVISOR_ROLE.disposition)
    const spawnLineIdx = composed.indexOf("Roles you may spawn")
    const appendIdx = composed.indexOf("extra instructions")
    expect(dispositionIdx).toBe(0)
    expect(spawnLineIdx).toBeGreaterThan(dispositionIdx)
    expect(appendIdx).toBeGreaterThan(spawnLineIdx)
  })

  it("a custom registry widens the spawn line beyond the built-in default", () => {
    const composed = composeRoleContext(SUPERVISOR_ROLE, undefined, { planner: PLANNER_ROLE })
    expect(composed).toContain("executor")
    // planner (level 50) < supervisor (level 100) — also spawnable.
    expect(composed).toContain("planner")
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

  it("executor is the floor (level 0), supervisor is the ceiling (level 100)", () => {
    expect(EXECUTOR_ROLE.level).toBe(0)
    expect(SUPERVISOR_ROLE.level).toBe(100)
  })
})

describe("mergeRoleRegistry", () => {
  it("returns just the built-ins when no custom registry is given", () => {
    const merged = mergeRoleRegistry()
    expect(Object.keys(merged).sort()).toEqual(["executor", "supervisor"])
  })

  it("merges in custom roles alongside the built-ins", () => {
    const merged = mergeRoleRegistry({ planner: PLANNER_ROLE })
    expect(merged.planner).toBe(PLANNER_ROLE)
    expect(merged.executor).toBe(EXECUTOR_ROLE)
    expect(merged.supervisor).toBe(SUPERVISOR_ROLE)
  })

  it("built-ins ALWAYS win a name collision — a pack cannot shadow the floor", () => {
    const rogueExecutor: RoleProfile = {
      name: "executor",
      disposition: "a pack pretending to be the built-in executor",
      toolPolicy: { delegation: "allow" },
      level: 999,
    }
    const merged = mergeRoleRegistry({ executor: rogueExecutor })
    expect(merged.executor).toBe(EXECUTOR_ROLE)
    expect(merged.executor?.toolPolicy.delegation).toBe("deny")
  })
})

describe("resolveRole with a custom registry", () => {
  it("resolves a custom role by name", () => {
    expect(resolveRole("planner", 0, undefined, { planner: PLANNER_ROLE })).toBe(PLANNER_ROLE)
  })

  it("still resolves built-ins when a registry is passed", () => {
    expect(resolveRole("executor", 0, undefined, { planner: PLANNER_ROLE })).toBe(EXECUTOR_ROLE)
  })

  it("throws on an unknown name even with a registry, listing every known role", () => {
    expect(() => resolveRole("ghost", 0, undefined, { planner: PLANNER_ROLE })).toThrow(
      /unknown role "ghost"/,
    )
  })
})

describe("canSpawn", () => {
  it("supervisor (level 100) may spawn executor (level 0) — open mode, non-escalation", () => {
    expect(canSpawn(SUPERVISOR_ROLE, EXECUTOR_ROLE)).toBe(true)
  })

  it("executor (delegation: deny) may spawn NOTHING — not even a peer at its own floor level", () => {
    // The tool gate (toolPolicy.delegation) is checked first and is
    // absolute: it's moot whether a level would otherwise pass.
    expect(canSpawn(EXECUTOR_ROLE, EXECUTOR_ROLE)).toBe(false)
    expect(canSpawn(EXECUTOR_ROLE, SUPERVISOR_ROLE)).toBe(false)
    expect(canSpawn(EXECUTOR_ROLE, PLANNER_ROLE)).toBe(false)
  })

  it("a custom planner (level 50) may spawn executor but not supervisor", () => {
    expect(canSpawn(PLANNER_ROLE, EXECUTOR_ROLE)).toBe(true)
    expect(canSpawn(PLANNER_ROLE, SUPERVISOR_ROLE)).toBe(false)
  })

  it("a role that allows delegation may spawn a peer at its own level — non-escalation, not strict descent", () => {
    // Back-compat: an orchestrator recursively spawning another
    // supervisor-role child (unbounded fan-out otherwise bounded by
    // maxDepth/maxChildren, not this lattice) must keep working exactly
    // as it did before this capability existed.
    expect(canSpawn(SUPERVISOR_ROLE, SUPERVISOR_ROLE)).toBe(true)
    expect(canSpawn(PLANNER_ROLE, PLANNER_ROLE)).toBe(true)
  })

  it("a closed `spawnableRoles` allowlist overrides the level comparison", () => {
    const closedPlanner: RoleProfile = { ...PLANNER_ROLE, spawnableRoles: ["executor"] }
    expect(canSpawn(closedPlanner, EXECUTOR_ROLE)).toBe(true)
    // reviewer's level (10) is <= 50 and would pass open-mode
    // non-escalation, but the allowlist only names "executor".
    expect(canSpawn(closedPlanner, REVIEWER_ROLE)).toBe(false)
  })
})

describe("listRoles / spawnableRolesFor", () => {
  it("listRoles returns just the built-ins with no custom registry", () => {
    expect(listRoles().map(r => r.name).sort()).toEqual(["executor", "supervisor"])
  })

  it("listRoles includes custom roles merged in", () => {
    const names = listRoles({ planner: PLANNER_ROLE }).map(r => r.name).sort()
    expect(names).toEqual(["executor", "planner", "supervisor"])
  })

  it("spawnableRolesFor(supervisor) includes executor (and itself, a peer)", () => {
    const names = spawnableRolesFor(SUPERVISOR_ROLE).map(r => r.name)
    expect(names).toContain("executor")
    expect(names).toContain("supervisor")
  })

  it("spawnableRolesFor(executor) is empty — delegation:deny spawns nothing, not even a peer", () => {
    expect(spawnableRolesFor(EXECUTOR_ROLE)).toEqual([])
  })

  it("spawnableRolesFor uses the SAME predicate as canSpawn — never disagrees", () => {
    const registry = { planner: PLANNER_ROLE, reviewer: REVIEWER_ROLE }
    const spawnable = spawnableRolesFor(PLANNER_ROLE, registry)
    for (const role of listRoles(registry)) {
      expect(spawnable.some(r => r.name === role.name)).toBe(canSpawn(PLANNER_ROLE, role))
    }
  })
})
