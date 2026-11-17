/**
 * Role `contextFiles`: a ROLE.md can name files whose content is injected,
 * fenced by a tag, into the spawn prompt right after the role disposition.
 * First user: the `recherche` role and the repo map (`<carte-depots>`), see
 * docs/agents/recherche-large-contrat.md in agentik-studio.
 */

import { describe, it, expect } from "vitest"
import { parseRolePack } from "../role-pack.js"
import { composeContextFiles, expandContextPath } from "../role-context-files.js"
import type { RoleProfile } from "../role.js"

function md(fields: Record<string, string>, body = "Tu cherches large."): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return `---\n${fm}\n---\n${body}`
}

const base = { role: "recherche", level: "50", "toolPolicy.delegation": "deny" }

describe("parseRolePack contextFiles", () => {
  it("parses tag=path entries", () => {
    const role = parseRolePack(
      md({ ...base, contextFiles: "carte-depots=~/.pygmalion/data/carte-depots.md, notes=/tmp/n.md" }),
    )
    expect(role.contextFiles).toEqual([
      { tag: "carte-depots", path: "~/.pygmalion/data/carte-depots.md" },
      { tag: "notes", path: "/tmp/n.md" },
    ])
  })

  it("rejects an entry without tag=path or with a bad tag", () => {
    expect(() => parseRolePack(md({ ...base, contextFiles: "/tmp/x.md" }))).toThrow(/contextFiles/)
    expect(() => parseRolePack(md({ ...base, contextFiles: "bad tag=/tmp/x.md" }))).toThrow(/contextFiles/)
  })

  it("omits the field when absent", () => {
    expect(parseRolePack(md(base)).contextFiles).toBeUndefined()
  })
})

describe("expandContextPath", () => {
  it("expands ~ and $VAR, returns undefined for an unset variable", () => {
    expect(expandContextPath("~/a.md", { HOME: "/h" }, "/h")).toBe("/h/a.md")
    expect(expandContextPath("$X/a.md", { X: "/x" }, "/h")).toBe("/x/a.md")
    expect(expandContextPath("${X}/a.md", { X: "/x" }, "/h")).toBe("/x/a.md")
    expect(expandContextPath("$NOPE/a.md", {}, "/h")).toBeUndefined()
  })
})

describe("composeContextFiles", () => {
  const role: RoleProfile = {
    name: "recherche",
    disposition: "d",
    toolPolicy: { delegation: "deny" },
    level: 50,
    contextFiles: [{ tag: "carte-depots", path: "~/carte.md" }],
  }

  it("wraps the file content in its tag", async () => {
    const blocks = await composeContextFiles(role, {
      env: {},
      home: "/h",
      readFile: async p => {
        expect(p).toBe("/h/carte.md")
        return "| agentproto/agentproto | AIP |"
      },
    })
    expect(blocks).toEqual(["<carte-depots>\n| agentproto/agentproto | AIP |\n</carte-depots>"])
  })

  it("says the file is absent instead of failing the spawn", async () => {
    const blocks = await composeContextFiles(role, {
      env: {},
      home: "/h",
      readFile: async () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" })
      },
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('<carte-depots absent="/h/carte.md"')
  })

  it("truncates a huge file and says so", async () => {
    const blocks = await composeContextFiles(role, {
      env: {},
      home: "/h",
      maxBytes: 10,
      readFile: async () => "x".repeat(100),
    })
    expect(blocks[0]).toContain("xxxxxxxxxx")
    expect(blocks[0]).not.toContain("x".repeat(11))
    expect(blocks[0]).toContain("tronqué")
  })

  it("returns nothing for a role without contextFiles", async () => {
    expect(
      await composeContextFiles({ ...role, contextFiles: undefined }, { env: {}, home: "/h" }),
    ).toEqual([])
  })
})
