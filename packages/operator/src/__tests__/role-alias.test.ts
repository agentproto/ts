import { describe, expect, it } from "vitest"
import { defineOperator } from "../define-operator.js"
import { operatorFromManifest, parseOperatorManifest } from "../manifest/index.js"

const fromMd = (frontmatter: string, options?: Parameters<typeof operatorFromManifest>[1]) =>
  operatorFromManifest(parseOperatorManifest(`---\n${frontmatter}\n---\nbody\n`), options)

const BASE = `id: atlas\nname: Atlas\npersona_summary: Keeps the research desk honest.`

const codes = (op: { warnings: readonly { code: string }[] }) =>
  op.warnings.map((w) => w.code)

describe("operator without `role` (AIP-9 §Alias period)", () => {
  it("a legacy file with no role falls back to metadata.roleSlug and warns role_fallback", () => {
    const op = fromMd(`${BASE}\nmetadata:\n  roleSlug: research`)
    expect(op.role).toEqual({ ref: "research" })
    expect(op.warnings).toEqual([
      expect.objectContaining({
        code: "role_fallback",
        source: "metadata.roleSlug",
        role: "research",
      }),
    ])
  })

  it("an operator with no resolvable role gets role_missing and no default role", () => {
    const op = fromMd(`${BASE}\nprofile:\n  role: Lead researcher at the desk.`, {
      // Even a host where every slug resolves must not turn free text into a role.
      roleExists: () => true,
    })
    expect(op.role).toBeUndefined()
    expect(codes(op)).toEqual(["role_missing"])
  })

  it("never invents a default role, whatever the host offers", () => {
    const op = defineOperator(
      { id: "atlas", name: "Atlas", persona_summary: "x" },
      { roleExists: () => true },
    )
    expect(op.role).toBeUndefined()
    expect(codes(op)).toContain("role_missing")
  })

  it("reads profile.role as a role only when it is a slug that resolves", () => {
    const md = `${BASE}\nprofile:\n  role: lawyer`
    const resolves = fromMd(md, { roleExists: (s) => s === "lawyer" })
    expect(resolves.role).toEqual({ ref: "lawyer" })
    expect(resolves.warnings).toEqual([
      expect.objectContaining({ code: "role_fallback", source: "profile.role" }),
    ])
    const unknown = fromMd(md, { roleExists: () => false })
    expect(unknown.role).toBeUndefined()
    expect(codes(unknown)).toEqual(["role_missing"])
    // No predicate from the host: the prose is never read as a role.
    expect(fromMd(md).role).toBeUndefined()
  })

  it("prefers metadata.roleSlug over a resolvable profile.role", () => {
    const op = fromMd(
      `${BASE}\nmetadata:\n  roleSlug: editor\nprofile:\n  role: lawyer`,
      { roleExists: () => true },
    )
    expect(op.role?.ref).toBe("editor")
    expect(op.warnings[0]).toMatchObject({ source: "metadata.roleSlug" })
  })

  it("an explicit role wins and raises neither fallback nor missing", () => {
    const op = fromMd(`${BASE}\nrole: ws://roles/pm\nmetadata:\n  roleSlug: other`)
    expect(op.role).toEqual({ ref: "ws://roles/pm" })
    expect(op.warnings).toEqual([])
  })

  it("keeps the bind and with of a structured role", () => {
    const op = fromMd(
      `${BASE}\nrole:\n  ref: pm\n  bind:\n    board: ws://collections/b\n  with:\n    language: fr`,
    )
    expect(op.role).toEqual({
      ref: "pm",
      bind: { board: "ws://collections/b" },
      with: { language: "fr" },
    })
    expect(op.warnings).toEqual([])
  })
})
