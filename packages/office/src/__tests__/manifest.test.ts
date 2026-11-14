import { describe, it, expect } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  officeFromManifest,
  parseOfficeManifest,
  readOfficeTree,
} from "../manifest/index.js"

const head = (name: string, extra: string) => `---
schema: office.workspace/v1
name: ${name}
title: ${name}
description: A synthetic office.
version: 1.0.0
${extra}
---
body
`

describe("OFFICE.md extends accepts an office path", () => {
  it("parses a view that extends ../OFFICE.md", () => {
    const m = parseOfficeManifest(head("acme-simone", "extends: ../OFFICE.md"))
    expect(m.frontmatter.extends).toBe("../OFFICE.md")
    expect(officeFromManifest(m).name).toBe("acme-simone")
  })

  it("parses ./OFFICE.md and a nested path to a parent view", () => {
    expect(
      parseOfficeManifest(head("v1", "extends: ./OFFICE.md")).frontmatter
        .extends,
    ).toBe("./OFFICE.md")
    expect(
      parseOfficeManifest(head("v2", "extends: ../../guilds/OFFICE.md"))
        .frontmatter.extends,
    ).toBe("../../guilds/OFFICE.md")
  })

  it("refuses an extends that does not name an OFFICE.md", () => {
    expect(() =>
      parseOfficeManifest(head("v3", "extends: ../COMPANY.md")),
    ).toThrow(/extends/)
    expect(() =>
      parseOfficeManifest(head("v4", "extends: ../OFFICE.md.bak")),
    ).toThrow(/extends/)
  })
})

describe("executor compact refs", () => {
  it.each([
    "ws://operators/coo",
    "operator:coo",
    "operator:chief-of-staff@jeremy/root",
  ])("accepts %s", (ref) => {
    expect(parseOfficeManifest(head("acme", `executor: ${ref}`)).frontmatter
      .executor).toBe(ref)
  })

  it.each(["user:jeremy", "operator:", "operator:Coo", "ws://operators/a@b/c"])(
    "refuses %s",
    (ref) => {
      expect(() =>
        parseOfficeManifest(head("acme", `executor: "${ref}"`)),
      ).toThrow(/executor/)
    },
  )
})

describe("readOfficeTree items layout", () => {
  it("skips a stray file directly under items/", () => {
    const root = mkdtempSync(join(tmpdir(), "office-manifest-"))
    try {
      mkdirSync(join(root, "items", "role"), { recursive: true })
      writeFileSync(join(root, "items", "stray.md"), "not a collection\n")
      writeFileSync(
        join(root, "items", "role", "coo.md"),
        "---\ncollection: role\nid: coo\n---\n",
      )
      const input = readOfficeTree({
        root,
        nodes: [{ ref: "@acme/acme", dir: "" }],
      })
      expect(input.items.map((i) => i.id)).toEqual(["coo"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
