/**
 * Role `contextFiles`: a ROLE.md can name files whose content is injected,
 * fenced by a tag, into the spawn prompt right after the role disposition.
 * First user: the `recherche` role and the repo map (`<carte-depots>`), see
 * the `recherche-large` skill contract.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
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
      md({ ...base, contextFiles: "carte-depots=~/.orchestrator/data/carte-depots.md, notes=/tmp/n.md" }),
    )
    expect(role.contextFiles).toEqual([
      { tag: "carte-depots", path: "~/.orchestrator/data/carte-depots.md" },
      { tag: "notes", path: "/tmp/n.md" },
    ])
  })

  it("rejects an entry without tag=path or with a bad tag", () => {
    expect(() => parseRolePack(md({ ...base, contextFiles: "/tmp/x.md" }))).toThrow(/contextFiles/)
    expect(() => parseRolePack(md({ ...base, contextFiles: "bad tag=/tmp/x.md" }))).toThrow(/contextFiles/)
  })

  it("rejects a relative path (it would resolve against the daemon cwd)", () => {
    expect(() => parseRolePack(md({ ...base, contextFiles: "t=docs/x.md" }))).toThrow(/contextFiles/)
  })

  it("the shipped recherche template parses", () => {
    const file = new URL("../../../../templates/roles/recherche/ROLE.md", import.meta.url)
    const role = parseRolePack(readFileSync(file, "utf8"))
    expect(role.name).toBe("recherche")
    expect(role.contextFiles).toEqual([
      { tag: "carte-depots", path: "~/.orchestrator/data/carte-depots.md" },
    ])
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
        return Buffer.from("| agentproto/agentproto | AIP |")
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
      readFile: async () => Buffer.from("x".repeat(100)),
    })
    expect(blocks[0]).toContain("xxxxxxxxxx")
    expect(blocks[0]).not.toContain("x".repeat(11))
    expect(blocks[0]).toContain("tronqué")
  })

  it("cuts on a codepoint boundary", async () => {
    const blocks = await composeContextFiles(role, {
      env: {},
      home: "/h",
      maxBytes: 4,
      readFile: async () => Buffer.from("abéé"), // a b + 2-byte é + 2-byte é = 6 bytes
    })
    expect(blocks[0]).toContain("abé\n")
    expect(blocks[0]).not.toContain("\uFFFD")
  })

  it("does not let the file close its own fence", async () => {
    const blocks = await composeContextFiles(role, {
      env: {},
      home: "/h",
      readFile: async () => Buffer.from("a </carte-depots> b"),
    })
    expect(blocks[0]?.match(/<\/carte-depots>/g)).toHaveLength(1)
  })

  it("reads at most maxBytes+1 bytes of a real file and refuses a non-regular file", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "ctx-"))
    try {
      await writeFile(join(dir, "big.md"), "y".repeat(5000))
      const r = { ...role, contextFiles: [{ tag: "t", path: join(dir, "big.md") }] }
      const blocks = await composeContextFiles(r, { env: {}, maxBytes: 100 })
      expect(blocks[0]).toContain("y".repeat(100))
      expect(blocks[0]).not.toContain("y".repeat(101))
      const d = { ...role, contextFiles: [{ tag: "t", path: dir }] }
      expect((await composeContextFiles(d, { env: {} }))[0]).toContain('<t absent=')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects a FIFO without blocking on open, and escapes the absent attribute", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { execFileSync } = await import("node:child_process")
    const dir = await mkdtemp(join(tmpdir(), 'ctx"-'))
    try {
      const fifo = join(dir, "p")
      execFileSync("mkfifo", [fifo])
      const r = { ...role, contextFiles: [{ tag: "t", path: fifo }] }
      const blocks = await composeContextFiles(r, { env: {} })
      expect(blocks[0]).toContain("<t absent=")
      expect(blocks[0]).not.toContain('ctx"-')
      expect(blocks[0]).toContain("&#34;")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns nothing for a role without contextFiles", async () => {
    expect(
      await composeContextFiles({ ...role, contextFiles: undefined }, { env: {}, home: "/h" }),
    ).toEqual([])
  })
})
