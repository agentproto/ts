import { describe, expect, it } from "vitest"
import {
  defineRole,
  mergeRoles,
  resolveRole,
  validateRoleBinding,
  BuiltinRoleSource,
  type RoleHandle,
  type RoleSlots,
} from "../index.js"
import { parseRoleManifest } from "../manifest/index.js"

const baseRole = {
  schema: "role/v1" as const,
  name: "pm",
  title: "Project manager",
  description: "Runs a project.",
  version: "1.0.0",
  seniority: "mid" as const,
  mission: "Keep the project moving.",
  responsibilities: ["Plan the work"] as [string, ...string[]],
}

const slots: RoleSlots = {
  board: { aip: 18, description: "The work board" },
  skill_pack: { collection: "skills", optional: true },
  product_tools: { tool: "mcp", optional: true },
  one_tool: { tool: "ref", optional: true },
  language: { scalar: "string", enum: ["fr", "en"], default: "fr" },
  retries: { scalar: "number", optional: true },
}

const codes = (r: { errors: readonly { code: string }[] }) =>
  r.errors.map((e) => e.code)

describe("validateRoleBinding (AIP-47 §Validating a binding)", () => {
  it("accepts a complete, well typed binding", () => {
    const r = validateRoleBinding(slots, {
      bind: {
        board: "ws://collections/katchy-board",
        skill_pack: "skill:seo",
        product_tools: { kind: "mcp", server: "katchy", allow: ["search"] },
        one_tool: "tool:katchy/search",
      },
      with: { language: "en", retries: 3 },
    })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("refuses a binding that leaves a required slot unbound", () => {
    const r = validateRoleBinding(slots, { bind: {}, with: {} })
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([
      expect.objectContaining({ code: "role_slot_unbound", slot: "board" }),
    ])
  })

  it("does not require an optional slot nor a scalar that has a default", () => {
    const r = validateRoleBinding(slots, {
      bind: { board: "aip://18/katchy-board" },
    })
    expect(r.ok).toBe(true)
  })

  it("refuses a value of the wrong AIP-54 family, in every spelling", () => {
    const wrong = [
      "ws://skills/seo", // a skill where an AIP-18 collection is expected
      "skill:seo",
      "aip://3/seo",
      { aip: 3, id: "seo" },
      "local:notes/board.md",
    ]
    for (const value of wrong) {
      const r = validateRoleBinding(slots, { bind: { board: value } })
      expect(codes(r), JSON.stringify(value)).toEqual(["role_slot_type_mismatch"])
      expect(r.errors[0]?.slot).toBe("board")
    }
    const right = [
      "ws://collections/b",
      "collection_doc:b",
      "aip://18/b@1.0.0",
      { aip: 18, id: "b", version: "1.0.0" },
    ]
    for (const value of right) {
      const r = validateRoleBinding(slots, { bind: { board: value } })
      expect(r.errors, JSON.stringify(value)).toEqual([])
    }
  })

  it("matches a collection slot on the kind of the ref, base collections included", () => {
    const s: RoleSlots = { who: { collection: "identity" }, doc: { collection: "file" } }
    expect(
      validateRoleBinding(s, {
        bind: { who: "ws://operators/atlas", doc: "github:agentproto/ts:README.md" },
      }).ok,
    ).toBe(true)
    expect(
      codes(
        validateRoleBinding(s, {
          bind: { who: "ws://skills/x", doc: "operator:atlas" },
        }),
      ),
    ).toEqual(["role_slot_type_mismatch", "role_slot_type_mismatch"])
  })

  it("refuses an unknown bind key, an unknown with key, and a key in the wrong block", () => {
    const r = validateRoleBinding(slots, {
      bind: { board: "ws://collections/b", nope: "ws://wikis/x", language: "fr" },
      with: { ghost: 1, board: "x" },
    })
    expect(codes(r)).toEqual([
      "role_slot_unknown",
      "role_slot_unknown",
      "role_slot_unknown",
      "role_slot_unknown",
    ])
    expect(r.errors.map((e) => e.slot).sort()).toEqual(
      ["board", "ghost", "language", "nope"].sort(),
    )
  })

  it("type checks tool and scalar values", () => {
    const r = validateRoleBinding(slots, {
      bind: {
        board: "ws://collections/b",
        product_tools: "katchy", // a string where a structured mcp ref is expected
        one_tool: "search", // a bare name is not a tool ref
      },
      with: { language: "de", retries: "3" },
    })
    expect(codes(r)).toEqual([
      "role_slot_type_mismatch",
      "role_slot_type_mismatch",
      "role_slot_type_mismatch",
      "role_slot_type_mismatch",
    ])
    expect(
      validateRoleBinding(slots, {
        bind: {
          board: "ws://collections/b",
          one_tool: "ws://tools/katchy/search",
          product_tools: { kind: "mcp", server: "has/slash" },
        },
      }).errors.map((e) => e.slot),
    ).toEqual(["product_tools"])
  })

  it("reads refs without fetching: unresolvable is a warning, never an error", () => {
    const r = validateRoleBinding(
      slots,
      { bind: { board: "ws://collections/missing" } },
      { refResolves: () => false },
    )
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "role_slot_unresolvable", slot: "board" }),
    ])
  })

  it("treats a role without slots as one that takes no binding", () => {
    expect(validateRoleBinding(undefined, undefined).ok).toBe(true)
    expect(codes(validateRoleBinding(undefined, { bind: { x: "ws://wikis/x" } }))).toEqual([
      "role_slot_unknown",
    ])
  })
})

describe("role slots declaration", () => {
  it("accepts a slot of each type", () => {
    const role = defineRole({ ...baseRole, slots })
    expect(Object.keys(role.slots ?? {})).toEqual(Object.keys(slots))
  })

  it("refuses a policy-typed slot, by AIP number and by collection", () => {
    // A valid slot is accepted, so the refusals below are about the policy type.
    expect(() => defineRole({ ...baseRole, slots: { b: { aip: 18 } } })).not.toThrow()
    expect(() =>
      defineRole({ ...baseRole, slots: { guard: { aip: 38 } } }),
    ).toThrow(/slot 'guard'.*polic/i)
    expect(() =>
      defineRole({ ...baseRole, slots: { guard: { collection: "policies" } } }),
    ).toThrow(/slot 'guard'.*polic/i)
  })

  it("refuses a slot with two type keys, a bad name, or no type", () => {
    for (const bad of [
      { s: { aip: 18, collection: "wikis" } },
      { Bad: { aip: 18 } },
      { s: {} },
    ]) {
      expect(() => defineRole({ ...baseRole, slots: bad as never })).toThrow(
        /slots\.[A-Za-z_]+/,
      )
    }
  })

  it("keeps the frontmatter strict once slots are accepted", () => {
    expect(() => defineRole({ ...baseRole, slots, stray: 1 } as never)).toThrow(/stray/)
  })

  it("refuses a policy slot written in a ROLE.md too", () => {
    const md = `---\nschema: role/v1\nname: pm\ntitle: PM\ndescription: d\nversion: 1.0.0\nseniority: mid\nmission: m\nresponsibilities: [a]\nslots:\n  guard: { aip: 38 }\n---\nbody\n`
    expect(() => parseRoleManifest(md)).toThrow(/polic/i)
  })

  it("merges slots by key across extends: the child's redeclaration replaces", () => {
    const parent = defineRole({
      ...baseRole,
      slots: { board: { aip: 18 }, lang: { scalar: "string", default: "fr" } },
    })
    const { role } = mergeRoles(parent, {
      ...baseRole,
      name: "child",
      slots: { board: { collection: "wikis" }, extra: { scalar: "boolean" } },
    })
    expect(role.slots).toEqual({
      board: { collection: "wikis" },
      lang: { scalar: "string", default: "fr" },
      extra: { scalar: "boolean" },
    })
  })

  it("resolveRole hands the merged slots to the binding validation", async () => {
    const parent: RoleHandle = defineRole({
      ...baseRole,
      slots: { board: { aip: 18 } },
    })
    const child = {
      ...baseRole,
      name: "child",
      extends: "builtin/pm",
      slots: { lang: { scalar: "string" as const, default: "fr" } },
    } as RoleHandle
    const source = new BuiltinRoleSource([
      { slug: "pm", handle: parent, body: "" },
      { slug: "child", handle: child, body: "" },
    ])
    const { role, warnings } = await resolveRole("child", { sources: [source] })
    expect(warnings).toEqual([])
    expect(codes(validateRoleBinding(role.slots, { bind: {} }))).toEqual([
      "role_slot_unbound",
    ])
    expect(
      validateRoleBinding(role.slots, { bind: { board: "aip://18/b" } }).ok,
    ).toBe(true)
  })
})
