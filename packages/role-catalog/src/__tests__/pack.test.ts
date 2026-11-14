import { describe, expect, it } from "vitest"
import { InstalledCatalog, PackCatalogConflictError, readPackCatalog } from "@agentproto/pack"
import { InstalledRoleSource, resolveRole } from "@agentproto/role"
import { roleFrontmatterSchema } from "@agentproto/role/manifest"
import { BUILTIN_ROLE_ENTRIES, builtinRoleSource, roleCatalogPackRoot } from "../index.js"

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe("@agentproto/role-catalog ships as an AIP-64 pack", () => {
  it("the pack validates and lists one role member per in-code entry", async () => {
    const pack = await readPackCatalog(roleCatalogPackRoot())
    expect(pack.pack).toBe("role-catalog")
    expect(pack.status).toBe("ready")
    expect(pack.members.every((m) => m.kind === "roles")).toBe(true)
    expect(pack.members.map((m) => m.id).sort()).toEqual(
      BUILTIN_ROLE_ENTRIES.map((e) => e.slug).sort(),
    )
  })

  it("the pack is generated from the in-code entries: no drift (run `pnpm render:pack`)", async () => {
    const pack = await readPackCatalog(roleCatalogPackRoot())
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      const member = pack.members.find((m) => m.id === entry.slug)
      expect(member, entry.slug).toBeDefined()
      expect(plain(member!.frontmatter)).toEqual(plain(roleFrontmatterSchema.parse(entry.handle)))
      expect(member!.body.trim()).toBe((entry.body ?? "").trim())
    }
  })

  it("installing the pack resolves every role the in-code source resolves, to the same role", async () => {
    const catalog = new InstalledCatalog()
    catalog.install(await readPackCatalog(roleCatalogPackRoot()))
    const installed = new InstalledRoleSource(catalog)
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      const viaPack = await resolveRole(`ws://roles/${entry.slug}`, { sources: [installed] })
      const viaCode = await resolveRole(entry.slug, { sources: [builtinRoleSource()] })
      expect(plain(viaPack.role)).toEqual(plain(viaCode.role))
      expect(viaPack.body.trim()).toBe(viaCode.body.trim())
    }
  })

  it("a host that still registers the in-code source as a reserved catalog refuses the pack", async () => {
    const pack = await readPackCatalog(roleCatalogPackRoot())
    const builtin = builtinRoleSource()
    const catalog = new InstalledCatalog({
      reserved: (kind, id) => (kind === "roles" && builtin.has(id) ? "builtin role source" : undefined),
    })
    expect(() => catalog.install(pack)).toThrow(PackCatalogConflictError)
  })
})
