import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { operatorSpec, operatorVerbs } from "../spec.js"
import { renderOperatorMd } from "../render.js"
import { defineOperator } from "../define-operator.js"
import type { OperatorDefinition } from "../types.js"

const minimal: OperatorDefinition = {
  id: "synthetic-op",
  name: "Synthetic Operator",
  persona_summary: "Does synthetic work, carefully.",
  role: "synthetic-role",
}

const full: OperatorDefinition = {
  ...minimal,
  id: "synthetic-full",
  role: { ref: "synthetic-role", with: { depth: 2 } },
  version: "1.0.0",
  home: "ws://companies/synthetic-co",
  reports_to: "synthetic-op",
  boundaries: ["Never touch production."],
  capabilities: ["triage"],
  tags: ["synthetic"],
  participation: { mode: "proactive", reactions: true },
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "operator-spec-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const withSchema = (def: OperatorDefinition) => ({ schema: "operator/v1", ...def })

describe("operatorVerbs round trip", () => {
  for (const [label, def] of [
    ["a minimal operator", minimal],
    ["an operator with optional fields", full],
  ] as const) {
    it(`renders then parses ${label} back to the same object`, async () => {
      await withDir(async (dir) => {
        const created = await operatorVerbs.create(def, { dir, body: "Synthetic prompt." })
        expect(operatorSpec.parse(created.rendered).frontmatter).toEqual(withSchema(def))

        const loaded = await operatorVerbs.load(created.path)
        expect(loaded.handle).toEqual(created.handle)
        expect(loaded.body.trim()).toBe("Synthetic prompt.")
      })
    })
  }

  it("lists a created operator and leaves an unchanged update byte-identical", async () => {
    await withDir(async (dir) => {
      const created = await operatorVerbs.create(full, { dir, body: "Body." })
      expect(await operatorVerbs.list(dir)).toEqual([created.handle])
      await operatorVerbs.update(created.path, (p) => p)
      expect(await readFile(created.path, "utf8")).toBe(created.rendered)
    })
  })

  it("writes the operator under operators/<id>/OPERATOR.md", async () => {
    const created = await operatorVerbs.create(minimal, { dir: "/unused", dryRun: true })
    expect(created.path).toBe(join("/unused", "operators", "synthetic-op", "OPERATOR.md"))
  })
})

describe("operator writers emit canonical fields only", () => {
  const legacyShaped: OperatorDefinition = {
    ...minimal,
    company: "ws://companies/synthetic-co",
    profile: { role: "Door plate title", voice: "Dry and brief." },
  }

  it("folds deprecated forms and writes none of them", async () => {
    const created = await operatorVerbs.create(legacyShaped, { dir: "/unused", dryRun: true })
    expect(created.handle.warnings.length).toBeGreaterThan(0)
    const data = matter(created.rendered).data
    expect(data.home).toBe("ws://companies/synthetic-co")
    expect(data).not.toHaveProperty("company")
    expect(data.profile ?? {}).not.toHaveProperty("voice")
    expect(data).not.toHaveProperty("warnings")
    expect(data).not.toHaveProperty("legacy")
  })

  it("emits a role as a bare string or a binding, never an invented default", () => {
    const text = renderOperatorMd({ operator: defineOperator(minimal) })
    expect(matter(text).data.role).toBe("synthetic-role")
    expect(matter(renderOperatorMd({ operator: defineOperator(full) })).data.role).toEqual({
      ref: "synthetic-role",
      with: { depth: 2 },
    })
    const noRole = renderOperatorMd({
      operator: defineOperator({ id: "no-role", name: "No Role", persona_summary: "Has none." }),
    })
    expect(matter(noRole).data).not.toHaveProperty("role")
  })
})
