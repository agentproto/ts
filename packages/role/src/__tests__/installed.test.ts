import { describe, expect, it } from "vitest"
import { RoleUnresolvableError } from "../errors.js"
import { resolveRole } from "../resolve.js"
import { BuiltinRoleSource } from "../sources/builtin.js"
import {
  InstalledRoleSource,
  roleSourceChain,
  type InstalledRoleCatalog,
  type InstalledRoleMember,
} from "../sources/installed.js"
import type { RoleHandle } from "../types.js"

const handle = (name: string, mission: string): RoleHandle =>
  ({
    schema: "role/v1",
    name,
    title: name,
    description: `The ${name} role.`,
    version: "1.0.0",
    seniority: "senior",
    mission,
    responsibilities: ["Do the job"],
    metadata: {},
  }) as RoleHandle

/** A catalog double: one member, visible only from `attach` (or everywhere). */
function fakeCatalog(member: InstalledRoleMember, attach?: string): InstalledRoleCatalog {
  const visible = (chain?: readonly string[]) => attach === undefined || (chain?.includes(attach) ?? false)
  const idOf = (ref: string) => ref.replace(/^(ws:\/\/roles\/|role:)/, "")
  return {
    get: (_kind, ref, chain) => (idOf(ref) === member.id && visible(chain) ? member : undefined),
    list: (_kind, chain) => (visible(chain) ? [member] : []),
  }
}

const member: InstalledRoleMember = {
  id: "pm",
  pack: "team-pack",
  frontmatter: handle("pm", "From the pack."),
  body: "pack body",
}

describe("resolveRole failure is typed", () => {
  it("throws RoleUnresolvableError carrying code, ref, warnings and chain", async () => {
    const err = await resolveRole("ws://roles/nope", { sources: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RoleUnresolvableError)
    const typed = err as RoleUnresolvableError
    expect(typed.code).toBe("role_unresolvable")
    expect(typed.ref).toBe("ws://roles/nope")
    expect(typed.warnings.map((w) => w.code)).toContain("role_unresolvable")
    expect(typed.chain).toEqual([])
  })
})

describe("InstalledRoleSource", () => {
  it("answers every ref form the catalog answers, and null for an unknown ref", async () => {
    const source = new InstalledRoleSource(fakeCatalog(member))
    for (const ref of ["ws://roles/pm", "role:pm", "pm"]) {
      const raw = await source.load(ref)
      expect(raw?.ref).toBe("ws://roles/pm")
      expect(raw?.scheme).toBe("pack")
      expect(raw?.body).toBe("pack body")
    }
    expect(await source.load("ws://roles/nope")).toBeNull()
  })

  it("scopes to the node chain it is given", async () => {
    const source = new InstalledRoleSource(fakeCatalog(member, "guild-a"))
    expect(await source.load("pm")).toBeNull()
    expect(await source.forNode(["guild-b"]).load("pm")).toBeNull()
    expect((await source.forNode(["child", "guild-a"]).load("pm"))?.ref).toBe("ws://roles/pm")
    expect(await source.forNode(["guild-a"]).list()).toEqual(["ws://roles/pm"])
  })

  it("roleSourceChain searches the nodes first and the catalog sources after", async () => {
    const local = new BuiltinRoleSource([
      { slug: "pm", handle: handle("pm", "From the guild."), body: "local body" },
    ])
    const installed = new InstalledRoleSource(fakeCatalog(member))
    const nearFirst = await resolveRole("pm", { sources: roleSourceChain([local], [installed]) })
    expect(nearFirst.role.mission).toBe("From the guild.")
    const packOnly = await resolveRole("pm", { sources: roleSourceChain([], [installed]) })
    expect(packOnly.role.mission).toBe("From the pack.")
  })
})
