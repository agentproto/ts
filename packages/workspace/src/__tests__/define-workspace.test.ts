import { describe, it, expect } from "vitest"
import { defineWorkspace } from "../define-workspace.js"

function validDef() {
  return {
    schema: "workspace/v1" as const,
    id: "@acme/reviewers",
    version: "0.1.0",
    name: "Acme Reviewers",
    owner: { type: "guild" as const, id: "guild_123", slug: "acme" },
    storage: { inline: { provider: "local-fs", config: {} } },
  }
}

describe("defineWorkspace (AIP-34)", () => {
  it("imports cleanly", () => {
    expect(typeof defineWorkspace).toBe("function")
  })

  it("accepts a spec-compliant scoped id `@owner/workspace`", () => {
    // Regression: the generic DEFAULT_ID_PATTERN is a bare kebab slug and
    // rejected the `@`/`/` the AIP-34 schema mandates, so constructDoctype
    // threw before validate() on every valid id. `idPattern` now mirrors
    // the schema.
    const ws = defineWorkspace(validDef())
    expect(ws.schema).toBe("workspace/v1")
    expect(ws.id).toBe("@acme/reviewers")
    expect(ws.owner.slug).toBe("acme")
    expect(ws.storage).toEqual({ inline: { provider: "local-fs", config: {} } })
  })

  it("rejects a bare (unscoped) id", () => {
    expect(() => defineWorkspace({ ...validDef(), id: "reviewers" })).toThrow(
      /defineWorkspace \(AIP-34\): invalid id/,
    )
  })

  it("surfaces AIP-34 field errors from the zod schema", () => {
    // A scoped id passes the id gate and reaches validate(), so a bad
    // (but type-valid) field — here a non-semver version — fails with the
    // schema diagnostic rather than the id gate.
    expect(() =>
      defineWorkspace({ ...validDef(), version: "not-semver" }),
    ).toThrow(/defineWorkspace \(AIP-34\): version/)
  })
})
