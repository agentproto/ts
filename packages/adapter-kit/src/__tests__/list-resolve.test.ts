import { describe, it, expect, vi } from "vitest"
import { makeAdapterLister, makeAdapterResolver } from "../list-resolve.js"
import type { CredsStore } from "../creds-store.js"
import type { SetupLedger } from "../ledger.js"
import type { AdapterCatalog, AdapterHandle } from "../types.js"

interface TestHandle extends AdapterHandle {
  port: number
}
interface TestInfo {
  slug: string
  name: string
  port: number
}

const toInfo = (h: TestHandle): TestInfo => ({ slug: h.slug, name: h.name, port: h.port })

function makeHandle(over: Partial<TestHandle> & { slug: string }): TestHandle {
  return {
    name: over.slug,
    version: "1.0.0",
    description: `desc ${over.slug}`,
    requiresSetup: false,
    port: 1000,
    check: vi.fn(async () => true),
    ...over,
  }
}

const CATALOG: AdapterCatalog = [
  { slug: "alpha", name: "Alpha", description: "a", packageName: "@x/adapter-alpha" },
  { slug: "bravo", name: "Bravo", description: "b", packageName: "@x/adapter-bravo", hint: "h" },
  { slug: "charlie", name: "Charlie", description: "c", packageName: "@x/adapter-charlie" },
]

function fakeLedger(present: Set<string>): SetupLedger {
  return {
    exists: async (slug) => present.has(slug),
    read: async () => null,
    write: async () => {},
  }
}
function fakeCreds(present: Set<string>): CredsStore<unknown> {
  return {
    exists: async (slug) => present.has(slug),
    read: async () => null,
    write: async () => {},
  }
}

describe("makeAdapterResolver", () => {
  it("returns the handle when load succeeds", async () => {
    const r = makeAdapterResolver<TestHandle>({ load: async (s) => makeHandle({ slug: s }) })
    expect((await r("alpha"))?.slug).toBe("alpha")
  })
  it("returns null when load throws (not installed)", async () => {
    const r = makeAdapterResolver<TestHandle>({
      load: async () => {
        throw new Error("ERR_MODULE_NOT_FOUND")
      },
    })
    expect(await r("alpha")).toBeNull()
  })
})

describe("makeAdapterLister", () => {
  it("preserves catalog order and maps statuses", async () => {
    // alpha resolves, no setup → ready
    // bravo resolves, requiresSetup, ledger present → ready
    // charlie not installed → supported
    const handles: Record<string, TestHandle | null> = {
      alpha: makeHandle({ slug: "alpha", requiresSetup: false }),
      bravo: makeHandle({ slug: "bravo", requiresSetup: true }),
      charlie: null,
    }
    const lister = makeAdapterLister<TestHandle, TestInfo>({
      catalog: CATALOG,
      resolver: async (slug) => handles[slug] ?? null,
      ledger: fakeLedger(new Set(["bravo"])),
      toInfo,
    })
    const out = await lister()
    expect(out.map((e) => e.slug)).toEqual(["alpha", "bravo", "charlie"])
    expect(out.map((e) => e.status)).toEqual(["ready", "ready", "supported"])
    // supported entry has no info and "not installed" version
    const charlie = out[2]!
    expect(charlie.info).toBeUndefined()
    expect(charlie.version).toBe("not installed")
    // resolved entries carry info + version
    expect(out[0]!.info).toEqual({ slug: "alpha", name: "alpha", port: 1000 })
    expect(out[0]!.version).toBe("1.0.0")
    // hint propagates from catalog
    expect(out[1]!.hint).toBe("h")
  })

  it("uses injected credsStore.exists() for status", async () => {
    const lister = makeAdapterLister<TestHandle, TestInfo>({
      catalog: [CATALOG[0]!],
      resolver: async (slug) => makeHandle({ slug, requiresSetup: true }),
      ledger: fakeLedger(new Set()),
      credsStore: fakeCreds(new Set(["alpha"])), // creds present → ready
      toInfo,
    })
    expect((await lister())[0]!.status).toBe("ready")
  })

  it("marks requiresSetup with no ledger/creds as available", async () => {
    const lister = makeAdapterLister<TestHandle, TestInfo>({
      catalog: [CATALOG[0]!],
      resolver: async (slug) => makeHandle({ slug, requiresSetup: true }),
      ledger: fakeLedger(new Set()),
      credsStore: fakeCreds(new Set()),
      toInfo,
    })
    expect((await lister())[0]!.status).toBe("available")
  })

  it("appends extras (not in catalog) sorted by slug", async () => {
    const lister = makeAdapterLister<TestHandle, TestInfo>({
      catalog: [CATALOG[0]!], // only alpha
      resolver: async (slug) => makeHandle({ slug }),
      ledger: fakeLedger(new Set()),
      toInfo,
      discoverExtras: async () => [
        makeHandle({ slug: "zulu" }),
        makeHandle({ slug: "alpha" }), // already in catalog → filtered
        makeHandle({ slug: "mike" }),
      ],
    })
    const out = await lister()
    expect(out.map((e) => e.slug)).toEqual(["alpha", "mike", "zulu"])
  })

  it("never calls handle.check() during listing (OQ-5)", async () => {
    const checkSpy = vi.fn(async () => true)
    const handle = makeHandle({ slug: "alpha", requiresSetup: true, check: checkSpy })
    const extraCheck = vi.fn(async () => true)
    const lister = makeAdapterLister<TestHandle, TestInfo>({
      catalog: [CATALOG[0]!],
      resolver: async () => handle,
      ledger: fakeLedger(new Set(["alpha"])),
      credsStore: fakeCreds(new Set()),
      toInfo,
      discoverExtras: async () => [makeHandle({ slug: "zulu", check: extraCheck })],
    })
    await lister()
    expect(checkSpy).not.toHaveBeenCalled()
    expect(extraCheck).not.toHaveBeenCalled()
  })
})
