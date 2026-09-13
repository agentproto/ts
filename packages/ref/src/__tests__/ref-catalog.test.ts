import { describe, it, expect } from "vitest"
import {
  RefCatalog,
  refFor,
  refToUri,
  refFromUri,
  RefFamilyError,
  RefUnresolvableError,
} from "../index.js"
import { createRegistry } from "@agentproto/registry"

// Synthetic handles mirroring real shapes: AppHandle (id, NO schema),
// PackHandle (name only), ToolHandle (id), scratch sandbox (id).
interface AppLike {
  id?: string
  name: string
  schema?: string
}
interface PackLike {
  name: string
  schema?: string
}
interface SandboxLike {
  id: string
  provider: string
}
interface ToolLike {
  id: string
}

function r(aip: number, id: string): { aip: number; id: string } {
  return { aip, id }
}

/** Fixtures over four real AIP families: app (42), pack (52), sandbox (61), tool (14). */
function buildFixtures() {
  const app = { id: "book-companion", name: "Book Companion" } as AppLike
  const pack = { name: "the-agentic-coder" } as PackLike
  const sandbox = { id: "e2b-main", provider: "e2b" } as SandboxLike
  const tool = { id: "search-web" } as ToolLike

  const cat = new RefCatalog()
  const apps = createRegistry<AppLike>({ family: "app", keyBy: h => h.id! })
  apps.register(app)
  cat.registerFamily<AppLike>(42, { family: "app", keyBy: h => h.id! }, apps)
  const packs = createRegistry<PackLike>({ family: "pack", keyBy: h => h.name })
  packs.register(pack)
  cat.registerFamily<PackLike>(52, { family: "pack", keyBy: h => h.name }, packs)
  const sandboxes = createRegistry<SandboxLike>({ family: "sandbox", keyBy: h => h.id })
  sandboxes.register(sandbox)
  cat.registerFamily<SandboxLike>(61, { family: "sandbox", keyBy: h => h.id }, sandboxes)
  const tools = createRegistry<ToolLike>({ family: "tool", keyBy: h => h.id })
  tools.register(tool)
  cat.registerFamily<ToolLike>(14, { family: "tool", keyBy: h => h.id }, tools)
  return { cat, app, pack, sandbox, tool }
}

describe("RefCatalog — AIP-54 invariants", () => {
  it("resolves refs to the REAL handles, across four AIP families, through one catalog", () => {
    const { cat, app, pack, sandbox, tool } = buildFixtures()
    expect(cat.resolveStrict(r(42, "book-companion")).handle).toBe(app)
    expect(cat.resolveStrict(r(52, "the-agentic-coder")).handle).toBe(pack)
    expect(cat.resolveStrict(r(61, "e2b-main")).handle).toBe(sandbox)
    expect(cat.resolveStrict(r(14, "search-web")).handle).toBe(tool)
    expect(cat.familyOf(61)).toBe("sandbox")
    // version on the ref does not affect lookup identity
    expect(cat.resolveStrict({ ...r(42, "book-companion"), version: "1.0.0" }).handle).toBe(app)
  })

  it("returns undefined for unknown aip / unknown id (default mode)", () => {
    const { cat } = buildFixtures()
    expect(cat.resolve(r(99, "x"))).toBeUndefined()
    expect(cat.resolve(r(42, "nope"))).toBeUndefined()
  })

  it("throws typed errors in strict mode — a dangling id never masquerades as resolution", () => {
    const { cat } = buildFixtures()
    expect(() => cat.resolveStrict(r(99, "x"))).toThrow(RefFamilyError)
    expect(() => cat.resolveStrict(r(42, "nope"))).toThrow(RefUnresolvableError)
  })

  it("validates refs (non-integer aip, empty id are TypeErrors)", () => {
    const { cat } = buildFixtures()
    expect(() => cat.resolve({ aip: 0, id: "x" })).toThrow(TypeError)
    expect(() => cat.resolve({ aip: 42, id: "" })).toThrow(TypeError)
  })

  it("re-registering a family replaces the binding (hot-reload parity)", () => {
    const { cat, sandbox } = buildFixtures()
    const sandboxes2 = createRegistry<SandboxLike>({ family: "sandbox", keyBy: h => h.id })
    const alt = { id: "e2b-main", provider: "e2b-alt" }
    sandboxes2.register(alt)
    cat.registerFamily<SandboxLike>(61, { family: "sandbox", keyBy: h => h.id }, sandboxes2)
    expect(cat.resolveStrict(r(61, "e2b-main")).handle).toBe(alt)
    expect(cat.resolveStrict(r(61, "e2b-main")).handle).not.toBe(sandbox)
  })

  it("familyOfHandles exposes the family registry list", () => {
    const { cat } = buildFixtures()
    expect(cat.familyOfHandles(61)).toHaveLength(1)
    expect(cat.familyOfHandles(99)).toEqual([])
  })
})

describe("refFor — typed ref derivation", () => {
  it("derives a frozen ref from a real handle using the family keyBy", () => {
    const { sandbox, tool } = buildFixtures()
    const sbxRef = refFor({ aip: 61, keyBy: (h: SandboxLike) => h.id }, sandbox)
    const toolRef = refFor({ aip: 14, keyBy: (h: ToolLike) => h.id }, tool)
    expect(sbxRef).toEqual({ aip: 61, id: "e2b-main" })
    expect(Object.isFrozen(sbxRef)).toBe(true)
    expect(toolRef).toEqual({ aip: 14, id: "search-web" })
  })

  it("default keyBy mirrors AIP-43: id ?? provider ?? slug ?? name", () => {
    expect(refFor({ aip: 42 }, { id: "a", provider: "b", slug: "c", name: "d" }).id).toBe("a")
    expect(refFor({ aip: 42 }, { provider: "b", slug: "c", name: "d" }).id).toBe("b")
    expect(refFor({ aip: 42 }, { slug: "c", name: "d" }).id).toBe("c")
    expect(refFor({ aip: 42 }, { name: "d" }).id).toBe("d")
  })

  it("version pins onto the ref; absent means floating", () => {
    const withV = refFor({ aip: 42 }, { id: "app" }, "1.2.0")
    expect(withV).toEqual({ aip: 42, id: "app", version: "1.2.0" })
    expect(refToUri(withV)).toBe("aip://42/app@1.2.0")
  })

  it("REFUSES truly keyless handles — guarded at the API, not a dangling ref", () => {
    // A handle with no id/provider/slug/name cannot be referenced; the
    // old world silently produced dangling id strings. Note: a handle
    // carrying ONLY `name` is fine here (default keyBy includes name),
    // which is exactly what makes PackHandle (name-only) referenceable.
    expect(() => refFor({ aip: 42 }, {})).toThrow(/no registry key/)
  })
})

describe("aip:// URI round-trip", () => {
  it("serializes and parses losslessly, with and without version", () => {
    const plain = refFor({ aip: 42 }, { id: "book-companion" })
    expect(refToUri(plain)).toBe("aip://42/book-companion")
    expect(refFromUri("aip://42/book-companion")).toEqual(plain)

    const pinned = refFor({ aip: 42 }, { id: "book-companion" }, "1.2.0")
    expect(refToUri(pinned)).toBe("aip://42/book-companion@1.2.0")
    expect(refFromUri("aip://42/book-companion@1.2.0")).toEqual(pinned)
  })

  it("rejects malformed URIs", () => {
    expect(() => refFromUri("not-a-uri")).toThrow(/malformed/)
    expect(() => refFromUri("aip://abc/x")).toThrow(/malformed/)
    expect(() => refFromUri("aip://42/")).toThrow(/malformed/)
  })
})
