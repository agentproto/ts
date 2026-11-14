import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { skillSpec, skillVerbs } from "../spec.js"
import { renderSkillMd } from "../render.js"
import { defineSkill } from "../define-skill.js"
import type { SkillDefinition } from "../types.js"

const minimal: SkillDefinition = {
  name: "synthetic-skill",
  description: "A synthetic skill used to test the verbs.",
}

const full: SkillDefinition = {
  name: "synthetic-composite",
  description: "A synthetic composite skill.",
  license: "MIT",
  "allowed-tools": "Read Grep",
  metadata: {
    aip3: {
      schema: "skill/v1",
      variant: "composite",
      version: "1.0.0",
      tags: ["synthetic"],
      requires: [9],
      uses: ["synthetic-skill"],
    },
    vendor: { key: 1 },
  },
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "skill-spec-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("skillVerbs round trip", () => {
  for (const [label, def] of [
    ["a minimal skill", minimal],
    ["a composite skill", full],
  ] as const) {
    it(`renders then parses ${label} back to the same object`, async () => {
      await withDir(async (dir) => {
        const created = await skillVerbs.create(def, { dir, body: "# Synthetic\n\nDo the thing." })
        expect(skillSpec.parse(created.rendered).frontmatter).toEqual(def)

        const loaded = await skillVerbs.load(created.path)
        expect(loaded.handle).toEqual(created.handle)
        expect(loaded.body.trim()).toBe("# Synthetic\n\nDo the thing.")
      })
    })
  }

  it("lists a created skill and leaves an unchanged update byte-identical", async () => {
    await withDir(async (dir) => {
      const created = await skillVerbs.create(full, { dir, body: "Body." })
      expect(await skillVerbs.list(dir)).toEqual([created.handle])
      await skillVerbs.update(created.path, (p) => p)
      expect(await readFile(created.path, "utf8")).toBe(created.rendered)
    })
  })

  it("writes the skill under skills/<name>/SKILL.md", async () => {
    const created = await skillVerbs.create(minimal, { dir: "/unused", dryRun: true })
    expect(created.path).toBe(join("/unused", "skills", "synthetic-skill", "SKILL.md"))
  })
})

describe("renderSkillMd", () => {
  it("writes agentskills.io frontmatter with no top-level schema key", () => {
    const text = renderSkillMd({ skill: defineSkill(full), body: "Body." })
    const data = matter(text).data
    expect(data).not.toHaveProperty("schema")
    expect(data.metadata.aip3.schema).toBe("skill/v1")
    expect(matter(text).content.trim()).toBe("Body.")
  })

  it("writes the legacy skills/v1 tag as skill/v1", () => {
    const legacy = defineSkill({
      ...full,
      metadata: { aip3: { schema: "skills/v1", variant: "instruction" } },
    })
    const data = matter(renderSkillMd({ skill: legacy, body: "" })).data
    expect(data.metadata.aip3.schema).toBe("skill/v1")
  })
})
