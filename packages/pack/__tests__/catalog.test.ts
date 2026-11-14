import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BuiltinRoleSource,
  InstalledRoleSource,
  RoleUnresolvableError,
  resolveRole,
  roleSourceChain,
  type RoleHandle,
} from "@agentproto/role"
import {
  InstalledCatalog,
  PackCatalogConflictError,
  PackCatalogInvalidError,
  PackGatedError,
  parsePackManifest,
  readPackCatalog,
} from "../src/index.js"

const roleMd = (name: string, mission = "Ship the product.") => `---
schema: role/v1
name: ${name}
title: ${name} role
description: A synthetic ${name} role.
version: 1.0.0
seniority: senior
mission: ${mission}
responsibilities:
  - Own the roadmap
---
# ${name}

Body of ${name}.
`

const personaMd = (name: string) => `---
schema: persona/v1
name: ${name}
title: ${name} persona
description: A synthetic ${name} persona.
version: 1.0.0
---
Persona body.
`

const policyMd = (id: string) => `---
schema: policy/v1
id: "${id}"
version: 1.0.0
default: deny
grants: []
---
Policy body.
`

interface PackSpec {
  name: string
  roles?: Record<string, string>
  personas?: Record<string, string>
  policies?: Record<string, string>
  extraFrontmatter?: string
  extraFiles?: Record<string, string>
}

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "aip64-catalog-"))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFileDeep(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function makePack(spec: PackSpec): Promise<string> {
  const root = join(tmp, spec.name)
  const lines = [
    "schema: pack/v1",
    `name: ${spec.name}`,
    `title: ${spec.name}`,
    `description: Synthetic pack ${spec.name}.`,
    "version: 1.0.0",
    "plugin:",
    "  inline: true",
  ]
  const members = (key: string, file: string, entries?: Record<string, string>) => {
    if (!entries) return
    lines.push(`${key}:`)
    for (const [dir, content] of Object.entries(entries)) {
      lines.push(`  - path: ./${key}/${dir}/${file}`)
      void content
    }
  }
  members("roles", "ROLE.md", spec.roles)
  members("personas", "PERSONA.md", spec.personas)
  members("policies", "POLICY.md", spec.policies)
  if (spec.extraFrontmatter) lines.push(spec.extraFrontmatter)
  await writeFileDeep(join(root, "PACK.md"), `---\n${lines.join("\n")}\n---\n# ${spec.name}\n`)
  for (const [dir, content] of Object.entries(spec.roles ?? {})) {
    await writeFileDeep(join(root, "roles", dir, "ROLE.md"), content)
  }
  for (const [dir, content] of Object.entries(spec.personas ?? {})) {
    await writeFileDeep(join(root, "personas", dir, "PERSONA.md"), content)
  }
  for (const [dir, content] of Object.entries(spec.policies ?? {})) {
    await writeFileDeep(join(root, "policies", dir, "POLICY.md"), content)
  }
  for (const [rel, content] of Object.entries(spec.extraFiles ?? {})) {
    await writeFileDeep(join(root, rel), content)
  }
  return root
}

describe("AIP-64 catalog members: roles installed from a pack resolve by ref", () => {
  it("resolves a role installed from a synthetic pack through every ref form", async () => {
    const root = await makePack({ name: "team-pack", roles: { pm: roleMd("pm") } })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))
    const source = new InstalledRoleSource(catalog)

    for (const ref of ["ws://roles/pm", "role:pm", "pm"]) {
      const resolved = await resolveRole(ref, { sources: [source] })
      expect(resolved.role.name).toBe("pm")
      expect(resolved.body).toContain("Body of pm.")
    }
  })

  it("registers personas and policies by the identity their own file declares", async () => {
    const root = await makePack({
      name: "full-pack",
      roles: { pm: roleMd("pm") },
      personas: { marcus: personaMd("marcus") },
      policies: { "no-cron": policyMd("@acme/no-cron") },
    })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))

    expect(catalog.get("personas", "ws://personas/marcus")?.id).toBe("marcus")
    expect(catalog.get("personas", "persona:marcus")?.id).toBe("marcus")
    expect(catalog.get("policies", "ws://policies/@acme/no-cron")?.id).toBe("@acme/no-cron")
    expect(catalog.get("policies", "policy:@acme/no-cron")?.pack).toBe("full-pack")
  })

  it("fails an unknown ref with the typed role_unresolvable error", async () => {
    const root = await makePack({ name: "team-pack", roles: { pm: roleMd("pm") } })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))
    const source = new InstalledRoleSource(catalog)

    const err = await resolveRole("ws://roles/nope", { sources: [source] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RoleUnresolvableError)
    expect((err as RoleUnresolvableError).code).toBe("role_unresolvable")
    expect((err as RoleUnresolvableError).ref).toBe("ws://roles/nope")
  })

  it("registers nothing for a role until the pack is installed (installing is the only door)", async () => {
    const catalog = new InstalledCatalog()
    const source = new InstalledRoleSource(catalog)
    await expect(resolveRole("pm", { sources: [source] })).rejects.toBeInstanceOf(RoleUnresolvableError)
  })
})

describe("AIP-64 install rules", () => {
  it("refuses a name another installed pack already provides, naming both sources, and registers nothing of the second", async () => {
    const first = await makePack({ name: "first-pack", roles: { pm: roleMd("pm") } })
    const second = await makePack({
      name: "second-pack",
      roles: { designer: roleMd("designer"), pm: roleMd("pm", "A different mission.") },
    })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(first))

    let caught: unknown
    try {
      catalog.install(await readPackCatalog(second))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PackCatalogConflictError)
    const conflict = caught as PackCatalogConflictError
    expect(conflict.code).toBe("pack_member_conflict")
    expect(conflict.message).toContain("first-pack")
    expect(conflict.message).toContain("second-pack")
    expect(conflict.existing).toBe("first-pack")
    expect(conflict.incoming).toBe("second-pack")
    expect(catalog.get("roles", "designer")).toBeUndefined()
    expect(catalog.get("roles", "pm")?.pack).toBe("first-pack")
  })

  it("refuses a name a host builtin catalog already provides", async () => {
    const root = await makePack({ name: "team-pack", roles: { pm: roleMd("pm") } })
    const catalog = new InstalledCatalog({
      reserved: (kind, id) => (kind === "roles" && id === "pm" ? "builtin catalog" : undefined),
    })
    const pack = await readPackCatalog(root)
    let caught: unknown
    try {
      catalog.install(pack)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PackCatalogConflictError)
    expect((caught as PackCatalogConflictError).existing).toBe("builtin catalog")
    expect((caught as Error).message).toContain("team-pack")
  })

  it("re-applying the same pack replaces its own members instead of conflicting", async () => {
    const root = await makePack({ name: "team-pack", roles: { pm: roleMd("pm", "First.") } })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))
    await writeFileDeep(join(root, "roles", "pm", "ROLE.md"), roleMd("pm", "Second."))
    catalog.install(await readPackCatalog(root))

    const resolved = await resolveRole("pm", { sources: [new InstalledRoleSource(catalog)] })
    expect(resolved.role.mission).toBe("Second.")
    expect(catalog.list("roles")).toHaveLength(1)
  })

  it("validates every member before it registers any, naming the invalid member", async () => {
    const root = await makePack({
      name: "mixed-pack",
      roles: { pm: roleMd("pm") },
      personas: { broken: personaMd("broken").replace("persona/v1", "persona/v9") },
    })
    const err = await readPackCatalog(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PackCatalogInvalidError)
    expect((err as Error).message).toContain("./personas/broken/PERSONA.md")
  })

  it("refuses a policy member that declares no id", async () => {
    const root = await makePack({
      name: "no-id-pack",
      policies: { anon: policyMd("@acme/x").replace(/id: .*\n/, "") },
    })
    const err = await readPackCatalog(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PackCatalogInvalidError)
    expect((err as Error).message).toContain("id")
  })

  it("refuses two members of one kind with the same identity inside one pack", async () => {
    const root = await makePack({
      name: "twin-pack",
      roles: { a: roleMd("pm"), b: roleMd("pm") },
    })
    const err = await readPackCatalog(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PackCatalogInvalidError)
    expect((err as Error).message).toContain("pm")
  })

  it("refuses a declared member that is a symlink to a file outside the pack root", async () => {
    const root = await makePack({ name: "escape-pack", roles: { pm: roleMd("pm") } })
    const outside = join(tmp, "outside-ROLE.md")
    await writeFile(outside, roleMd("pm"))
    const member = join(root, "roles", "pm", "ROLE.md")
    await rm(member)
    await symlink(outside, member)

    const err = await readPackCatalog(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PackCatalogInvalidError)
    expect((err as Error).message).toContain("outside the pack root")
  })

  it("refuses a gated pack, surfacing its blockers verbatim and registering none of its members", async () => {
    const root = await makePack({
      name: "gated-pack",
      roles: { pm: roleMd("pm") },
      extraFrontmatter: "blockers:\n  - Legal review pending",
    })
    const catalog = new InstalledCatalog()
    let caught: unknown
    try {
      catalog.install(await readPackCatalog(root))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PackGatedError)
    expect((caught as Error).message).toContain("Legal review pending")
    expect(catalog.get("roles", "pm")).toBeUndefined()
  })

  it("scopes a pack attached to a node to that node and its descendants", async () => {
    const root = await makePack({ name: "guild-pack", roles: { pm: roleMd("pm") } })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root), { attach: "guild-a" })

    expect(catalog.get("roles", "pm")).toBeUndefined()
    expect(catalog.get("roles", "pm", ["guild-b", "company"])).toBeUndefined()
    expect(catalog.get("roles", "pm", ["guild-a-child", "guild-a", "company"])?.pack).toBe("guild-pack")

    const source = new InstalledRoleSource(catalog)
    await expect(resolveRole("pm", { sources: [source] })).rejects.toBeInstanceOf(RoleUnresolvableError)
    const scoped = await resolveRole("pm", { sources: [source.forNode(["guild-a", "company"])] })
    expect(scoped.role.name).toBe("pm")
  })

  it("installing binds nothing and never reads instance files found under the pack root", async () => {
    const root = await makePack({
      name: "decoy-pack",
      roles: { pm: roleMd("pm") },
      extraFiles: {
        "COMPANY.md": "---\nschema: company/v1\nname: acme\n---\n",
        "OFFICE.md": "---\nschema: office/v1\nname: acme\n---\n",
        "operators/bob/OPERATOR.md": "---\nschema: operator/v1\nname: bob\n---\n",
      },
    })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))
    expect(catalog.list("roles").map((m) => m.id)).toEqual(["pm"])
    expect(catalog.list("personas")).toEqual([])
    expect(catalog.list("policies")).toEqual([])
  })
})

describe("AIP-64 instances are never pack content", () => {
  const base = `schema: pack/v1
name: instance-pack
title: Instance pack
description: Tries to carry an instance.
version: 1.0.0
plugin:
  inline: true
`
  for (const [kind, key, file] of [
    ["operator", "operators", "OPERATOR.md"],
    ["company", "companies", "COMPANY.md"],
    ["office", "offices", "OFFICE.md"],
  ] as const) {
    it(`refuses a manifest that lists a ${kind} member (${key})`, () => {
      const src = `---\n${base}${key}:\n  - path: ./${key}/x/${file}\n---\n`
      expect(() => parsePackManifest(src)).toThrow(new RegExp(key))
    })
  }

  it("refuses an unknown key inside a catalog member entry", () => {
    const src = `---\n${base}roles:\n  - path: ./roles/pm/ROLE.md\n    extends: ws://roles/base\n---\n`
    expect(() => parsePackManifest(src)).toThrow(/extends/)
  })
})

describe("AIP-64 catalog member path rules", () => {
  const head = `schema: pack/v1
name: path-pack
title: Path pack
description: Path rules.
version: 1.0.0
plugin:
  inline: true
`
  const parse = (body: string) => parsePackManifest(`---\n${head}${body}---\n`)

  it("accepts roles, personas and policies entries", () => {
    const m = parse(
      "roles:\n  - path: ./roles/pm/ROLE.md\npersonas:\n  - path: ./personas/m/PERSONA.md\npolicies:\n  - path: ./policies/p/POLICY.md\n",
    )
    expect(m.frontmatter.roles).toEqual([{ path: "./roles/pm/ROLE.md" }])
    expect(m.frontmatter.personas).toEqual([{ path: "./personas/m/PERSONA.md" }])
    expect(m.frontmatter.policies).toEqual([{ path: "./policies/p/POLICY.md" }])
  })

  it("rejects an absolute path, a .. segment and a wrong filename with no I/O", () => {
    expect(() => parse("roles:\n  - path: /etc/ROLE.md\n")).toThrow(/absolute/)
    expect(() => parse("roles:\n  - path: ./roles/../../x/ROLE.md\n")).toThrow(/\.\./)
    expect(() => parse("roles:\n  - path: ./roles/pm/PERSONA.md\n")).toThrow(/ROLE\.md/)
    expect(() => parse("personas:\n  - path: ./p/ROLE.md\n")).toThrow(/PERSONA\.md/)
  })

  it("rejects a path declared twice within a member or across members and apps", () => {
    expect(() => parse("roles:\n  - path: ./a/ROLE.md\n  - path: ./a/ROLE.md\n")).toThrow(/twice|duplicate/i)
    expect(() =>
      parse("apps:\n  - id: x\n    path: ./a/ROLE.md\nroles:\n  - path: ./a/ROLE.md\n"),
    ).toThrow(/twice|duplicate/i)
  })
})

describe("AIP-47 source order: a more local role source wins over an installed pack", () => {
  it("resolves the nearer node's role even when a pack provides the same name", async () => {
    const root = await makePack({ name: "team-pack", roles: { pm: roleMd("pm", "From the pack.") } })
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(root))

    const local: RoleHandle = {
      schema: "role/v1",
      name: "pm",
      title: "Local pm",
      description: "The guild's own pm.",
      version: "1.0.0",
      seniority: "senior",
      mission: "From the guild.",
      responsibilities: ["Own the guild roadmap"],
      metadata: {},
    } as RoleHandle
    const guild = new BuiltinRoleSource([{ slug: "pm", handle: local, body: "local body" }])

    const chain = roleSourceChain([guild], [new InstalledRoleSource(catalog)])
    const resolved = await resolveRole("pm", { sources: chain })
    expect(resolved.role.mission).toBe("From the guild.")

    const packOnly = await resolveRole("pm", { sources: roleSourceChain([], [new InstalledRoleSource(catalog)]) })
    expect(packOnly.role.mission).toBe("From the pack.")
  })
})
