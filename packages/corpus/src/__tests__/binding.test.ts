/**
 * Attachment binding plane: matcher matrix, frontmatter parse,
 * legacy-compile equivalence, axis registry extension.
 *
 * The legacy table mirrors every ref shape the old `refMatchesSlug`
 * accepted — the compile + matcher pair must reproduce that behavior
 * exactly (the corpus playbook tests passing untouched is the
 * integration-level proof; this is the unit-level one).
 */

import { describe, expect, it } from "vitest"
import {
  compileLegacyPlaybookBinding,
  createAxisRegistry,
  isEmptySelector,
  matchAttachmentRefs,
  matchAttachments,
  matchesSelector,
  parseSelectorFrontmatter,
  type AttachmentDeclaration,
  type Selector,
} from "../binding/index.js"

const axes = createAxisRegistry()

function legacyMatch(selector: Selector, slugs: readonly string[]): boolean {
  // The forOperatorSlug sugar: axis-ambiguous handles tried on both axes.
  return matchesSelector(selector, { identity: slugs, role: slugs }, { axes })
}

// ── matchesSelector ─────────────────────────────────────────────────

describe("matchesSelector", () => {
  it("an empty selector matches NOTHING", () => {
    expect(isEmptySelector({})).toBe(true)
    expect(matchesSelector({}, { identity: "alice" }, { axes })).toBe(false)
  })

  it("allOf ANDs terms across axes", () => {
    const selector: Selector = {
      allOf: [
        { axis: "role", anyOf: ["sales-rep"] },
        { axis: "capability", anyOf: ["demo"] },
      ],
    }
    expect(
      matchesSelector(
        selector,
        { role: "sales-rep", capability: ["demo", "forecast"] },
        { axes }
      )
    ).toBe(true)
    expect(
      matchesSelector(
        selector,
        { role: "sales-rep", capability: ["forecast"] },
        { axes }
      )
    ).toBe(false)
  })

  it("anyOf ORs terms across axes", () => {
    const selector: Selector = {
      anyOf: [
        { axis: "identity", anyOf: ["alice"] },
        { axis: "role", anyOf: ["sales-rep"] },
      ],
    }
    expect(matchesSelector(selector, { role: "sales-rep" }, { axes })).toBe(
      true
    )
    expect(matchesSelector(selector, { identity: "alice" }, { axes })).toBe(
      true
    )
    expect(matchesSelector(selector, { identity: "bob" }, { axes })).toBe(
      false
    )
  })

  it("a term against an absent dimension fails (never match-all)", () => {
    const selector: Selector = { allOf: [{ axis: "position", anyOf: ["*"] }] }
    expect(matchesSelector(selector, { identity: "alice" }, { axes })).toBe(
      false
    )
    expect(
      matchesSelector(selector, { position: "growth-ae" }, { axes })
    ).toBe(true)
  })

  it('"*" matches any PRESENT value on the axis', () => {
    const selector: Selector = { allOf: [{ axis: "role", anyOf: ["*"] }] }
    expect(matchesSelector(selector, { role: "anything" }, { axes })).toBe(
      true
    )
    expect(matchesSelector(selector, { role: [] }, { axes })).toBe(false)
  })

  it("normalizes prefixed refs through the axis registry", () => {
    const selector: Selector = {
      allOf: [{ axis: "role", anyOf: ["ws://roles/sales-rep"] }],
    }
    expect(matchesSelector(selector, { role: "sales-rep" }, { axes })).toBe(
      true
    )
    // Without the registry the ref matches verbatim only.
    expect(matchesSelector(selector, { role: "sales-rep" })).toBe(false)
  })

  it("list-valued dimensions intersect", () => {
    const selector: Selector = {
      allOf: [{ axis: "capability", anyOf: ["negotiation"] }],
    }
    expect(
      matchesSelector(
        selector,
        { capability: ["discovery", "negotiation"] },
        { axes }
      )
    ).toBe(true)
  })
})

// ── parseSelectorFrontmatter ────────────────────────────────────────

describe("parseSelectorFrontmatter", () => {
  it("parses the short form: axis → ref | ref[]", () => {
    const selector = parseSelectorFrontmatter({
      role: "sales-rep",
      capability: ["demo", "forecast"],
    })
    expect(selector).toEqual({
      allOf: [
        { axis: "role", anyOf: ["sales-rep"] },
        { axis: "capability", anyOf: ["demo", "forecast"] },
      ],
    })
  })

  it("parses the long form: allOf/anyOf term lists", () => {
    const selector = parseSelectorFrontmatter({
      anyOf: [
        { axis: "identity", anyOf: ["alice"] },
        { axis: "role", anyOf: ["sales-rep"] },
      ],
    })
    expect(selector).toEqual({
      anyOf: [
        { axis: "identity", anyOf: ["alice"] },
        { axis: "role", anyOf: ["sales-rep"] },
      ],
    })
  })

  it("returns null on malformed input (caller falls back to legacy)", () => {
    expect(parseSelectorFrontmatter(undefined)).toBeNull()
    expect(parseSelectorFrontmatter("role: x")).toBeNull()
    expect(parseSelectorFrontmatter([])).toBeNull()
    expect(parseSelectorFrontmatter({})).toBeNull()
    expect(parseSelectorFrontmatter({ role: 42 })).toBeNull()
    expect(parseSelectorFrontmatter({ role: [] })).toBeNull()
    expect(parseSelectorFrontmatter({ anyOf: [{ axis: "role" }] })).toBeNull()
  })
})

// ── Legacy compile equivalence ──────────────────────────────────────

describe("compileLegacyPlaybookBinding", () => {
  // Every shape the old refMatchesSlug accepted, against slug "alice".
  const table: ReadonlyArray<{ ref: string; matches: boolean }> = [
    { ref: "alice", matches: true },
    { ref: "operator/alice", matches: true },
    { ref: "ws://operators/alice", matches: true },
    { ref: "operator/*", matches: true },
    { ref: "ws://operators/*", matches: true },
    { ref: "bob", matches: false },
    { ref: "operator/bob", matches: false },
  ]

  for (const { ref, matches } of table) {
    it(`kind:operator ref "${ref}" → ${matches} for slug alice`, () => {
      const selector = compileLegacyPlaybookBinding([
        { kind: "operator", ref },
      ])
      expect(legacyMatch(selector, ["alice"])).toBe(matches)
    })
  }

  it("binds_operator matches either handle (axis-ambiguous)", () => {
    const selector = compileLegacyPlaybookBinding([], "sales-rep")
    // ...the identity slug of an operator literally named sales-rep:
    expect(legacyMatch(selector, ["sales-rep"]))?.valueOf
    expect(
      matchesSelector(selector, { identity: "sales-rep" }, { axes })
    ).toBe(true)
    // ...or the role slug of any operator fulfilling sales-rep:
    expect(
      matchesSelector(
        selector,
        { identity: "sales-ae", role: "sales-rep" },
        { axes }
      )
    ).toBe(true)
  })

  it("kind:operator refs are tried on BOTH identity and role axes", () => {
    const selector = compileLegacyPlaybookBinding([
      { kind: "operator", ref: "sales-rep" },
    ])
    expect(
      matchesSelector(
        selector,
        { identity: "sales-ae", role: "sales-rep" },
        { axes }
      )
    ).toBe(true)
  })

  it("kind:role refs compile to the role axis only", () => {
    const selector = compileLegacyPlaybookBinding([
      { kind: "role", ref: "role/sales-rep" },
    ])
    expect(
      matchesSelector(selector, { identity: "sales-rep" }, { axes })
    ).toBe(false)
    expect(matchesSelector(selector, { role: "sales-rep" }, { axes })).toBe(
      true
    )
  })

  it("kind:skill/runtime refs keep no-match parity when the host supplies no such dimension", () => {
    const selector = compileLegacyPlaybookBinding([
      { kind: "skill", ref: "research" },
      { kind: "runtime", ref: "claude-code" },
    ])
    expect(legacyMatch(selector, ["alice"])).toBe(false)
    expect(matchesSelector(selector, { skill: "research" }, { axes })).toBe(
      true
    )
  })

  it("no targets + no binds → empty selector → matches nothing", () => {
    const selector = compileLegacyPlaybookBinding([])
    expect(isEmptySelector(selector)).toBe(true)
    expect(legacyMatch(selector, ["alice"])).toBe(false)
  })
})

// ── Axis registry extension ─────────────────────────────────────────

describe("createAxisRegistry", () => {
  it("ships the well-known axes and accepts host extras", () => {
    const registry = createAxisRegistry([
      {
        id: "org-unit",
        validateRef: ref => (ref.includes(" ") ? "no spaces" : null),
      },
    ])
    expect(registry.get("identity")?.aip).toBe(9)
    expect(registry.get("role")?.aip).toBe(47)
    expect(registry.get("position")?.aip).toBe(6)
    expect(registry.get("capability")?.aip).toBe(9)
    expect(registry.get("org-unit")?.validateRef?.("emea sales")).toBe(
      "no spaces"
    )
    expect(registry.get("org-unit")?.validateRef?.("emea-sales")).toBeNull()
  })

  it("refuses duplicate axis ids", () => {
    expect(() => createAxisRegistry([{ id: "role" }])).toThrow()
  })

  it("well-known validators accept slugs and '*', reject junk", () => {
    const role = createAxisRegistry().get("role")!
    expect(role.validateRef?.("sales-rep")).toBeNull()
    expect(role.validateRef?.("*")).toBeNull()
    expect(role.validateRef?.("Sales Rep")).not.toBeNull()
  })
})

describe("matchAttachments", () => {
  const decls: AttachmentDeclaration<"pack" | "skill">[] = [
    {
      asset: { kind: "pack", ref: "marketing-strategist" },
      selector: {
        allOf: [{ axis: "role", anyOf: ["marketing-manager", "copywriter"] }],
      },
    },
    {
      asset: { kind: "skill", ref: "brand-voice" },
      selector: { allOf: [{ axis: "role", anyOf: ["marketing-manager"] }] },
    },
    {
      asset: { kind: "pack", ref: "elon-tweets" },
      selector: { allOf: [{ axis: "identity", anyOf: ["elon"] }] },
    },
  ]

  it("returns the declarations whose selector matches the dimensions", () => {
    const matched = matchAttachments(
      decls,
      { role: "marketing-manager", identity: "jane" },
      { axes }
    )
    expect(matched.map(d => d.asset.ref)).toEqual([
      "marketing-strategist",
      "brand-voice",
    ])
  })

  it("matches a declaration by the identity axis", () => {
    const matched = matchAttachments(decls, { identity: "elon" }, { axes })
    expect(matched.map(d => d.asset.ref)).toEqual(["elon-tweets"])
  })

  it("yields nothing when the subject has no value on any targeted axis", () => {
    expect(matchAttachments(decls, { position: "vp-sales" }, { axes })).toEqual(
      []
    )
  })

  it("matchAttachmentRefs filters by kind and de-dupes", () => {
    const dupe: AttachmentDeclaration<"pack">[] = [
      ...decls.filter(
        (d): d is AttachmentDeclaration<"pack"> => d.asset.kind === "pack"
      ),
      {
        asset: { kind: "pack", ref: "marketing-strategist" },
        selector: { allOf: [{ axis: "role", anyOf: ["copywriter"] }] },
      },
    ]
    const refs = matchAttachmentRefs(
      dupe,
      "pack",
      { role: ["marketing-manager", "copywriter"] },
      { axes }
    )
    expect(refs).toEqual(["marketing-strategist"])
  })
})
