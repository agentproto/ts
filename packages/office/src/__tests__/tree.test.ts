import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { analyzeOfficeTree, type OfficeTreeIssue } from "../tree.js"
import { readOfficeTree } from "../manifest/index.js"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-tree-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, body: string) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

const office = (name: string, extra = "") => `---
schema: office.workspace/v1
name: ${name}
title: ${name}
description: A synthetic office.
version: 1.0.0
${extra}
---
`

const ROOT_RULES = `orgTree:
  containment:
    enabled: true
    field: parent
    rules:
      allowedKinds: [role, team]
      allowedParentKinds:
        role: [team, view]
        team: [view]
      maxDepth: 3
  reporting:
    enabled: true
    rules: { mustResolveTo: role }`

const rootOffice = (extra = "executor: operator:coo") =>
  office("acme", `${extra}\n${ROOT_RULES}`)

const seat = (id: string, fields: string) => `---
schema: collection.item/v1
collection: role
id: ${id}
title: ${id}
${fields}
---
`

const team = (id: string, parent: string) => `---
schema: collection.item/v1
collection: team
id: ${id}
title: ${id}
parent: ${parent}
---
`

const NODES = [
  { ref: "@acme/acme", dir: "" },
  { ref: "@acme/simone", dir: "simone" },
  { ref: "@acme/katchy", dir: "katchy" },
  { ref: "@acme/plain", dir: "plain" },
  { ref: "@acme/simone-lab", dir: "simone/lab" },
]

const analyze = (opts?: Parameters<typeof analyzeOfficeTree>[1]) =>
  analyzeOfficeTree(readOfficeTree({ root, nodes: NODES }), opts)

const codes = (issues: readonly OfficeTreeIssue[]) => issues.map((i) => i.code)
const hard = (t: ReturnType<typeof analyze>) =>
  t.issues.filter((i) => i.severity === "hard")
const warns = (t: ReturnType<typeof analyze>) =>
  t.issues.filter((i) => i.severity === "warn")

const baseTree = () => {
  write("OFFICE.md", rootOffice())
  write("simone/OFFICE.md", office("acme-simone", "extends: ../OFFICE.md"))
  write("katchy/OFFICE.md", office("acme-katchy", "extends: ../OFFICE.md"))
  write("items/role/coo.md", seat("coo", "holder: operator:coo"))
  write(
    "items/role/pm-simone.md",
    seat(
      "pm-simone",
      "parent: workspace:@acme/simone\nreportsTo: coo\nholder: operator:pm-simone",
    ),
  )
}

describe("an office spans a company tree", () => {
  it("accepts a guild view and a cross-tree holder", () => {
    baseTree()
    write(
      "items/role/chief-of-staff.md",
      seat("chief-of-staff", "holder: operator:chief-of-staff@jeremy/root"),
    )
    write("items/role/founder.md", seat("founder", "holder: user:jeremy"))
    const t = analyze()
    expect(hard(t)).toEqual([])
    expect(warns(t)).toEqual([])
    expect(t.ok).toBe(true)
    const cos = t.seats.find((s) => s.id === "chief-of-staff")
    expect(cos?.holder).toEqual({
      kind: "operator",
      id: "chief-of-staff",
      workspace: "jeremy/root",
    })
    expect(cos?.activates).toBe(true)
    const founder = t.seats.find((s) => s.id === "founder")
    expect(founder?.holder).toMatchObject({ kind: "user", id: "jeremy" })
    expect(founder?.activates).toBe(false)
  })

  it("refuses a second workspace-root OFFICE.md in the tree", () => {
    baseTree()
    write("katchy/OFFICE.md", office("acme-katchy-root"))
    const t = analyze()
    expect(t.ok).toBe(false)
    expect(hard(t)).toContainEqual(
      expect.objectContaining({
        code: "office_tree_second_root",
        node: "@acme/katchy",
      }),
    )
  })

  it("refuses a view whose extends leaves the tree", () => {
    baseTree()
    write("katchy/OFFICE.md", office("acme-katchy", "extends: ../../OFFICE.md"))
    const t = analyze()
    expect(codes(hard(t))).toContain("office_extends_outside_tree")
  })

  describe("seat parent", () => {
    it.each([
      ["a node of another tree", "workspace:@other/simone"],
      ["a node of the tree that carries no view", "workspace:@acme/plain"],
      ["the root node, which holds the root office, not a view", "workspace:@acme/acme"],
      ["an item that is not in this office", "ghost-team"],
    ])("refuses %s", (_label, parent) => {
      baseTree()
      write("items/role/pm-x.md", seat("pm-x", `parent: ${parent}`))
      const t = analyze()
      const issue = hard(t).find((i) => i.item === "pm-x")
      expect(issue?.code).toBe("office_seat_parent_outside")
      expect(hard(t).filter((i) => i.item !== "pm-x")).toEqual([])
    })

    it("refuses a node whose views do not reach this office", () => {
      baseTree()
      write(
        "plain/OFFICE.md",
        office("acme-plain", "extends: ../elsewhere/OFFICE.md"),
      )
      write("items/role/pm-plain.md", seat("pm-plain", "parent: workspace:@acme/plain"))
      const t = analyze()
      expect(codes(warns(t))).toContain("office_extends_missing")
      expect(hard(t).find((i) => i.item === "pm-plain")?.code).toBe(
        "office_seat_parent_outside",
      )
    })

    it("reports each offending item on its own", () => {
      baseTree()
      write("items/role/a.md", seat("a", "parent: workspace:@other/x"))
      write("items/role/b.md", seat("b", "parent: workspace:@other/y"))
      const t = analyze()
      expect(
        hard(t)
          .filter((i) => i.code === "office_seat_parent_outside")
          .map((i) => i.item)
          .sort(),
      ).toEqual(["a", "b"])
    })

    it("enforces allowedParentKinds, with `view` as a parent kind", () => {
      baseTree()
      write("items/team/t1.md", team("t1", "workspace:@acme/simone"))
      write("items/role/pm-t.md", seat("pm-t", "parent: t1"))
      // `team: [view]` allows a view parent, `role: [team, view]` allows team
      expect(hard(analyze())).toEqual([])
      // a team under a team is not in the matrix
      write("items/team/t2.md", team("t2", "t1"))
      const t = analyze()
      expect(hard(t).find((i) => i.item === "t2")?.code).toBe(
        "office_orgtree_invalid_parent_kind",
      )
    })

    it("counts a view parent as one level in maxDepth", () => {
      baseTree()
      write("items/team/t1.md", team("t1", "workspace:@acme/simone"))
      write("items/role/deep.md", seat("deep", "parent: t1"))
      expect(hard(analyze())).toEqual([])
      // maxDepth 3: view(1) > team(2) > role(3). One more level overflows.
      write(
        "OFFICE.md",
        rootOffice().replace("maxDepth: 3", "maxDepth: 2"),
      )
      const t = analyze()
      expect(hard(t).find((i) => i.item === "deep")?.code).toBe(
        "office_orgtree_max_depth",
      )
    })
  })

  describe("node of a seat", () => {
    it("is the nearest view parent, else the company node", () => {
      baseTree()
      write(
        "OFFICE.md",
        rootOffice()
          .replace("role: [team, view]", "role: [team, view, role]")
          .replace("maxDepth: 3", "maxDepth: 4"),
      )
      write("items/team/t1.md", team("t1", "workspace:@acme/katchy"))
      write("items/role/in-team.md", seat("in-team", "parent: t1"))
      write("items/role/top.md", seat("top", "parent: in-team"))
      const t = analyze()
      expect(hard(t)).toEqual([])
      expect(t.nodeOfSeat("coo")).toBe("@acme/acme")
      expect(t.nodeOfSeat("pm-simone")).toBe("@acme/simone")
      expect(t.nodeOfSeat("in-team")).toBe("@acme/katchy")
      expect(t.nodeOfSeat("top")).toBe("@acme/katchy")
    })
  })

  describe("holders", () => {
    it("warns on a holder the host cannot resolve, and keeps the seat", () => {
      baseTree()
      const t = analyze({
        resolveHolder: (h) => !(h.kind === "operator" && h.id === "pm-simone"),
      })
      expect(hard(t)).toEqual([])
      expect(warns(t)).toContainEqual(
        expect.objectContaining({
          code: "office_holder_unresolvable",
          item: "pm-simone",
        }),
      )
      const s = t.seats.find((x) => x.id === "pm-simone")
      expect(s?.activates).toBe(false)
      expect(t.ok).toBe(true)
    })

    it("accepts ws://operators/<slug> for the same tenant only", () => {
      baseTree()
      write("items/role/a.md", seat("a", "holder: ws://operators/cfo"))
      write(
        "items/role/b.md",
        seat("b", "holder: ws://operators/cos@jeremy/root"),
      )
      const t = analyze()
      expect(hard(t)).toEqual([])
      expect(warns(t).map((i) => [i.code, i.item])).toEqual([
        ["office_holder_unresolvable", "b"],
      ])
      expect(t.seats.find((s) => s.id === "a")?.holder).toEqual({
        kind: "operator",
        id: "cfo",
      })
    })

    it("treats a leading @ in the workspace suffix as malformed", () => {
      baseTree()
      write("items/role/c.md", seat("c", "holder: operator:cos@@jeremy/root"))
      expect(warns(analyze()).map((i) => i.item)).toEqual(["c"])
    })
  })

  describe("reportsTo", () => {
    it("must resolve to an item of this office", () => {
      baseTree()
      write("items/role/lost.md", seat("lost", "reportsTo: nobody"))
      const t = analyze()
      expect(hard(t)).toContainEqual(
        expect.objectContaining({
          code: "office_reports_to_unresolvable",
          item: "lost",
        }),
      )
    })

    it("bans cycles", () => {
      baseTree()
      write("items/role/x.md", seat("x", "reportsTo: y"))
      write("items/role/y.md", seat("y", "reportsTo: x"))
      expect(codes(hard(analyze()))).toContain("office_orgtree_circular_report")
    })
  })

  describe("executor lens", () => {
    it("is the nearest view that sets one, else the root office's", () => {
      baseTree()
      write(
        "katchy/OFFICE.md",
        office("acme-katchy", "extends: ../OFFICE.md\nexecutor: operator:katchy-lead"),
      )
      write(
        "simone/lab/OFFICE.md",
        office("acme-simone-lab", "extends: ../OFFICE.md"),
      )
      const t = analyze()
      expect(hard(t)).toEqual([])
      expect(t.executorOf("@acme/acme")).toEqual({
        executor: "operator:coo",
        from: "@acme/acme",
      })
      // a view that sets none falls through its extends chain to the root
      expect(t.executorOf("@acme/simone")?.executor).toBe("operator:coo")
      expect(t.executorOf("@acme/katchy")).toEqual({
        executor: "operator:katchy-lead",
        from: "@acme/katchy",
      })
      // a view of a view that sets none: the chain reaches the root
      expect(t.executorOf("@acme/simone-lab")?.executor).toBe("operator:coo")
      // a node with no OFFICE.md takes its nearest ancestor's lens
      expect(t.executorOf("@acme/plain")?.executor).toBe("operator:coo")
    })

    it("takes the nearest view in a chain that sets one", () => {
      baseTree()
      write(
        "simone/OFFICE.md",
        office("acme-simone", "extends: ../OFFICE.md\nexecutor: operator:simone-lead"),
      )
      write(
        "simone/lab/OFFICE.md",
        office("acme-simone-lab", "extends: ../OFFICE.md"),
      )
      const t = analyze()
      expect(t.executorOf("@acme/simone-lab")).toEqual({
        executor: "operator:simone-lead",
        from: "@acme/simone",
      })
    })
  })
})
