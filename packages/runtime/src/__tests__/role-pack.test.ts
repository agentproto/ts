/**
 * Unit coverage for `parseRolePack` (role-pack.ts) — the pure ROLE.md
 * frontmatter + body parser. No fs — see role-registry.test.ts for the
 * on-disk / adapter-carried discovery that hands this raw file
 * contents.
 */

import { describe, it, expect } from "vitest"
import { parseRolePack } from "../role-pack.js"

function rolePackMd(fields: Record<string, string>, body: string): string {
  const frontmatter = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return `---\n${frontmatter}\n---\n${body}`
}

describe("parseRolePack", () => {
  it("parses a valid role pack", () => {
    const md = rolePackMd(
      {
        role: "reviewer",
        level: "50",
        "toolPolicy.delegation": "deny",
        skills: "code-review, testing",
      },
      "You review code changes for correctness and style.",
    )
    const role = parseRolePack(md)
    expect(role).toEqual({
      name: "reviewer",
      disposition: "You review code changes for correctness and style.",
      toolPolicy: { delegation: "deny" },
      level: 50,
      skills: ["code-review", "testing"],
    })
  })

  it("parses `spawnableRoles` as a list", () => {
    const md = rolePackMd(
      { role: "planner", level: "50", "toolPolicy.delegation": "allow", spawnableRoles: "executor, reviewer" },
      "You plan.",
    )
    const role = parseRolePack(md)
    expect(role.spawnableRoles).toEqual(["executor", "reviewer"])
  })

  it("the markdown body (after the closing fence) becomes disposition, trimmed", () => {
    const md = rolePackMd(
      { role: "planner", level: "10", "toolPolicy.delegation": "deny" },
      "\n\n  You plan work.  \n\n",
    )
    expect(parseRolePack(md).disposition).toBe("You plan work.")
  })

  it("omits skills/spawnableRoles entirely when absent", () => {
    const md = rolePackMd(
      { role: "planner", level: "10", "toolPolicy.delegation": "deny" },
      "You plan.",
    )
    const role = parseRolePack(md)
    expect(role.skills).toBeUndefined()
    expect(role.spawnableRoles).toBeUndefined()
  })

  it("throws when the frontmatter fence is missing", () => {
    expect(() => parseRolePack("no frontmatter here")).toThrow(/missing frontmatter/)
  })

  it("throws when 'role' is missing", () => {
    const md = rolePackMd({ level: "50", "toolPolicy.delegation": "deny" }, "body")
    expect(() => parseRolePack(md)).toThrow(/missing 'role' field/)
  })

  it("throws when 'level' is missing", () => {
    const md = rolePackMd({ role: "reviewer", "toolPolicy.delegation": "deny" }, "body")
    expect(() => parseRolePack(md)).toThrow(/missing or invalid 'level'/)
  })

  it("throws when 'level' is not a number", () => {
    const md = rolePackMd(
      { role: "reviewer", level: "not-a-number", "toolPolicy.delegation": "deny" },
      "body",
    )
    expect(() => parseRolePack(md)).toThrow(/missing or invalid 'level'/)
  })

  it("throws when 'toolPolicy.delegation' is missing", () => {
    const md = rolePackMd({ role: "reviewer", level: "50" }, "body")
    expect(() => parseRolePack(md)).toThrow(/toolPolicy\.delegation/)
  })

  it("throws when 'toolPolicy.delegation' is an invalid value", () => {
    const md = rolePackMd(
      { role: "reviewer", level: "50", "toolPolicy.delegation": "maybe" },
      "body",
    )
    expect(() => parseRolePack(md)).toThrow(/toolPolicy\.delegation/)
  })
})
