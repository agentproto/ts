import { describe, expect, it } from "vitest"

import {
  buildPermissionTooltip,
  diffNewPermissionIds,
  formatAge,
  permissionAgeMs,
  permissionDescription,
  permissionLabel,
  type EnrichedPermission,
} from "./permissionsTree.logic.js"
import type { PendingPermission } from "../client/types.js"

function perm(over: Partial<EnrichedPermission> = {}): EnrichedPermission {
  return {
    id: "p1",
    sessionId: "s1",
    toolCallId: "p1",
    text: "Allow running `rm -rf foo`?",
    options: [],
    requestedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe("permissionLabel", () => {
  it("prefers toolName", () => {
    expect(permissionLabel(perm({ toolName: "Bash" }))).toBe("Bash")
  })

  it("falls back to the first line of text", () => {
    expect(permissionLabel(perm({ toolName: undefined, text: "Allow X?\nmore detail" }))).toBe(
      "Allow X?",
    )
  })

  it("falls back to a generic label when text is blank", () => {
    expect(permissionLabel(perm({ toolName: undefined, text: "" }))).toBe("Permission request")
  })
})

describe("formatAge", () => {
  it("renders seconds under a minute", () => {
    expect(formatAge(45_000)).toBe("45s ago")
  })

  it("renders minutes under an hour", () => {
    expect(formatAge(5 * 60_000)).toBe("5m ago")
  })

  it("renders hours under a day", () => {
    expect(formatAge(3 * 3_600_000)).toBe("3h ago")
  })

  it("renders days beyond that", () => {
    expect(formatAge(2 * 86_400_000)).toBe("2d ago")
  })
})

describe("permissionAgeMs", () => {
  it("prefers the daemon's precomputed ageMs", () => {
    expect(permissionAgeMs(perm({ ageMs: 1234 }), Date.now())).toBe(1234)
  })

  it("falls back to now - requestedAt", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z")
    expect(permissionAgeMs(perm({ requestedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(60_000)
  })

  it("clamps to zero for an invalid requestedAt", () => {
    expect(permissionAgeMs(perm({ requestedAt: "not-a-date" }), Date.now())).toBe(0)
  })
})

describe("permissionDescription", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z")

  it("uses sessionLabel when present", () => {
    expect(
      permissionDescription(
        perm({ sessionLabel: "sales-analysis", requestedAt: "2026-01-01T00:00:00.000Z" }),
        now,
      ),
    ).toBe("sales-analysis · 1m ago")
  })

  it("falls back to a shortened session id", () => {
    expect(
      permissionDescription(
        perm({ sessionId: "abcdefghijk", requestedAt: "2026-01-01T00:00:00.000Z" }),
        now,
      ),
    ).toBe("abcdefgh… · 1m ago")
  })
})

describe("buildPermissionTooltip", () => {
  it("includes the tool, session, age, request text, and options", () => {
    const md = buildPermissionTooltip(
      perm({
        toolName: "Bash",
        sessionLabel: "sales-analysis",
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      }),
      Date.parse("2026-01-01T00:00:30.000Z"),
    )
    expect(md).toContain("**Bash**")
    expect(md).toContain("sales-analysis")
    expect(md).toContain("30s ago")
    expect(md).toContain("Allow running `rm -rf foo`?")
    expect(md).toContain("- Allow once (`allow_once`)")
  })

  it("omits the options section when there are none", () => {
    const md = buildPermissionTooltip(perm(), Date.now())
    expect(md).not.toContain("Options:")
  })
})

describe("diffNewPermissionIds", () => {
  it("returns ids not present in the previous set", () => {
    const previous = new Set(["p1"])
    const current: PendingPermission[] = [perm({ id: "p1" }), perm({ id: "p2" })]
    expect(diffNewPermissionIds(previous, current)).toEqual(["p2"])
  })

  it("returns nothing when nothing changed", () => {
    const previous = new Set(["p1", "p2"])
    const current: PendingPermission[] = [perm({ id: "p1" }), perm({ id: "p2" })]
    expect(diffNewPermissionIds(previous, current)).toEqual([])
  })

  it("returns every id on the first snapshot when seeded from empty", () => {
    const previous = new Set<string>()
    const current: PendingPermission[] = [perm({ id: "p1" })]
    expect(diffNewPermissionIds(previous, current)).toEqual(["p1"])
  })
})
