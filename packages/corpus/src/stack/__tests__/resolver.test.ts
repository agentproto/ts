import { describe, it, expect } from "vitest"
import { createRegistry } from "@agentproto/registry"
import { StackResolver } from "../resolver.js"
import { buildOverlayFromStack, flattenPackRefs } from "../mount.js"
import type { LayerProvider, LayerRef } from "../types.js"
import type { FsPort, FsStat } from "../../ports/fs.port.js"

interface Subject {
  readonly operatorPacks: readonly string[]
  readonly rolePacks: readonly string[] | null
  readonly roleSlug: string | null
}

function reg() {
  return createRegistry<LayerProvider<Subject>>({
    family: "knowledge-layer",
    keyBy: (p) => p.id,
  })
}

function memFs(
  files: Record<string, string>
): FsPort & { files: Record<string, string> } {
  return {
    files,
    exists: async (p) => p in files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    writeFile: async (p, c) => {
      files[p] = c
    },
    appendFile: async (p, c) => {
      files[p] = (files[p] ?? "") + c
    },
    readdir: async (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`
      const names = new Set<string>()
      for (const k of Object.keys(files)) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!)
      }
      return [...names]
    },
    walk: async (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`
      return Object.keys(files).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
    },
    stat: async (p): Promise<FsStat | null> =>
      p in files ? { kind: "file", bytes: files[p]!.length } : null,
    lock: async () => ({ release: async () => {} }),
  }
}

const operatorProvider: LayerProvider<Subject> = {
  id: "operator",
  band: 10,
  mode: "lens",
  dimension: "operator",
  resolve: (ctx) => (ctx.subject?.operatorPacks ?? []).map((ref) => ({ ref })),
}
const roleProvider: LayerProvider<Subject> = {
  id: "role",
  band: 50,
  mode: "lens",
  dimension: "role",
  resolve: (ctx) => {
    const s = ctx.subject
    if (!s) return []
    const packs = s.rolePacks ?? (s.roleSlug ? [s.roleSlug] : [])
    return packs.map((ref) => ({ ref }))
  },
}

describe("StackResolver", () => {
  it("emits layers band-ordered (operator band 10 before role band 50)", async () => {
    const r = reg()
    r.register(roleProvider) // register out of band order on purpose
    r.register(operatorProvider)
    const resolver = new StackResolver(r)

    const res = await resolver.resolve({
      subject: { operatorPacks: ["elon-tweets"], rolePacks: ["sales-rep"], roleSlug: "sales-rep" },
    })
    expect(res.entries.map((e) => e.providerId)).toEqual(["operator", "role"])
  })

  it("flattenPackRefs reproduces the legacy union+dedup, operator before role", async () => {
    const r = reg()
    r.register(operatorProvider)
    r.register(roleProvider)
    const resolver = new StackResolver(r)

    // role packs include a duplicate of an operator pack
    const res = await resolver.resolve({
      subject: { operatorPacks: ["shared", "elon"], rolePacks: ["shared", "sales-rep"], roleSlug: "sales-rep" },
    })
    expect(flattenPackRefs(res)).toEqual(["shared", "elon", "sales-rep"])
  })

  it("a provider that resolves to nothing is recorded in skipped", async () => {
    const r = reg()
    r.register(operatorProvider)
    r.register(roleProvider)
    const resolver = new StackResolver(r)

    const res = await resolver.resolve({
      subject: { operatorPacks: [], rolePacks: null, roleSlug: null },
    })
    expect(res.entries).toHaveLength(0)
    expect(res.skipped.map((s) => s.providerId).sort()).toEqual(["operator", "role"])
    expect(res.skipped.every((s) => s.reason === "empty")).toBe(true)
  })

  it("shadow layers sample deterministically per conversationId", async () => {
    const shadow: LayerProvider<Subject> = {
      id: "experimental-region",
      band: 40,
      mode: "lens",
      dimension: "region",
      shadow: { pct: 0.5 },
      resolve: () => [{ ref: "region/fr", kind: "view" }],
    }
    const r = reg()
    r.register(shadow)
    const resolver = new StackResolver(r)

    const a1 = await resolver.resolve({ conversationId: "conv-A" })
    const a2 = await resolver.resolve({ conversationId: "conv-A" })
    // Same conversation → same arm, every time.
    expect(a1.entries.length).toBe(a2.entries.length)

    // No conversationId → never sampled.
    const none = await resolver.resolve({})
    expect(none.entries).toHaveLength(0)
    expect(none.skipped[0]?.reason).toBe("shadow-not-sampled")
  })
})

describe("buildOverlayFromStack", () => {
  const loadFs = (packs: Record<string, FsPort>) => (ref: LayerRef) => packs[ref.ref] ?? null

  it("mounts lens packs UNDER the guild layer (guild shadows packs)", async () => {
    const r = reg()
    r.register(operatorProvider)
    const resolver = new StackResolver(r)
    const res = await resolver.resolve({
      subject: { operatorPacks: ["pack-a"], rolePacks: null, roleSlug: null },
    })

    const guild = memFs({ "entries/x.md": "GUILD" })
    const pack = memFs({ "entries/x.md": "PACK", "entries/y.md": "PACK-Y" })
    const overlay = buildOverlayFromStack({
      guildFs: guild,
      stack: res,
      loadFs: loadFs({ "pack-a": pack }),
    })

    expect(await overlay.readFile("entries/x.md")).toBe("GUILD") // guild wins
    expect(await overlay.readFile("entries/y.md")).toBe("PACK-Y") // pack floor
    // writes target the guild layer
    await overlay.writeFile("entries/z.md", "NEW")
    expect("entries/z.md" in guild.files).toBe(true)
    expect("entries/z.md" in pack.files).toBe(false)
  })

  it("a CONSTRAINT layer is a floor: guild cannot shadow or tombstone it, writes still land on guild", async () => {
    const constraintProvider: LayerProvider<Subject> = {
      id: "compliance",
      band: 30,
      mode: "constraint",
      dimension: "compliance",
      resolve: () => [{ ref: "compliance/fr", kind: "view" }],
    }
    const r = reg()
    r.register(operatorProvider)
    r.register(constraintProvider)
    const resolver = new StackResolver(r)
    const res = await resolver.resolve({
      subject: { operatorPacks: ["pack-a"], rolePacks: null, roleSlug: null },
    })

    // Guild tries to shadow the protected entry AND tombstone it.
    const guild = memFs({
      "entries/labour.md": "GUILD OVERRIDE",
      "entries/labour.md.whiteout": "",
    })
    const compliance = memFs({ "entries/labour.md": "FR LABOUR LAW (protected)" })
    const overlay = buildOverlayFromStack({
      guildFs: guild,
      stack: res,
      loadFs: loadFs({ "compliance/fr": compliance }),
    })

    // Constraint wins reads despite the guild override + whiteout.
    expect(await overlay.readFile("entries/labour.md")).toContain("FR LABOUR LAW")
    expect(await overlay.exists("entries/labour.md")).toBe(true)
    // Writes still land on the guild layer (constraint is read-only).
    await overlay.writeFile("entries/new.md", "NEW")
    expect("entries/new.md" in guild.files).toBe(true)
  })

  it("returns guildFs unchanged when nothing resolves", async () => {
    const r = reg()
    r.register(operatorProvider)
    const resolver = new StackResolver(r)
    const res = await resolver.resolve({
      subject: { operatorPacks: [], rolePacks: null, roleSlug: null },
    })
    const guild = memFs({ "entries/x.md": "GUILD" })
    const overlay = buildOverlayFromStack({ guildFs: guild, stack: res, loadFs: () => null })
    expect(overlay).toBe(guild)
  })
})
