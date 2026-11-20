import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

// The family must run with no home directory. Any attempt to resolve one
// (file-backed creds store or ledger) fails this test loudly.
vi.mock("node:os", async importOriginal => {
  const real = await importOriginal<typeof import("node:os")>()
  return {
    ...real,
    homedir: () => {
      throw new Error("homedir() must not be read by an env/memory family")
    },
  }
})

import { makeProviderFamily, type FamilyHandle } from "../family.js"
import {
  makeEnvCredsStore,
  makeMemoryCredsStore,
  makeMemorySetupLedger,
} from "../memory-stores.js"
import type { AdapterCatalog } from "../types.js"

interface FakeHandle extends FamilyHandle {
  kind: string
}
interface FakeInfo {
  kind: string
}

const CATALOG: AdapterCatalog = [
  { slug: "inproc", name: "In process", description: "d", packageName: "@fake/inproc" },
  { slug: "paid", name: "Paid", description: "d", packageName: "@fake/paid" },
  { slug: "free", name: "Free", description: "d", packageName: "@fake/free" },
  { slug: "absent", name: "Absent", description: "d", packageName: "@fake/absent" },
  { slug: "broken", name: "Broken", description: "d", packageName: "@fake/broken" },
]

function handle(slug: string, over: Partial<FakeHandle> = {}): FakeHandle {
  return {
    slug,
    name: slug,
    version: "1.0.0",
    description: `desc ${slug}`,
    requiresSetup: false,
    kind: "fake",
    check: async () => true,
    ...over,
  }
}

const PAID_FIELDS = [
  { name: "apiKey", description: "key", required: true, sensitive: true },
  { name: "region", description: "region", required: false },
] as const

const MODULES: Record<string, Record<string, unknown>> = {
  "@fake/paid": { provider: { slug: "paid", setupFields: PAID_FIELDS } },
  "@fake/free": { provider: { slug: "free" } },
  "@fake/broken": { notAProvider: true },
}

function build(env: Record<string, string | undefined> = {}) {
  const importPackage = vi.fn(async (pkg: string) => {
    const mod = MODULES[pkg]
    if (!mod) throw new Error(`Cannot find package '${pkg}'`)
    return mod
  })
  const family = makeProviderFamily<FakeHandle, FakeInfo>({
    family: "fake",
    catalog: CATALOG,
    toInfo: h => ({ kind: h.kind }),
    builtins: { inproc: () => handle("inproc") },
    fromModule: (mod, ctx) => {
      const p = mod["provider"] as { slug: string; setupFields?: typeof PAID_FIELDS } | undefined
      if (!p) return null
      return handle(p.slug, {
        requiresSetup: (p.setupFields?.length ?? 0) > 0,
        ...(p.setupFields ? { setupFields: p.setupFields } : {}),
        // proves the creds reach the loader
        kind: ctx.creds ? "configured" : "bare",
      })
    },
    importPackage,
    credsStore: makeEnvCredsStore({ vars: { paid: { apiKey: "FAKE_PAID_KEY" } }, env }),
    ledger: makeMemorySetupLedger(),
  })
  return { family, importPackage }
}

function fakeServer() {
  const tools: Array<{
    name: string
    shape: Record<string, unknown>
    handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
  }> = []
  const server = {
    tool: (name: string, _d: string, shape: Record<string, unknown>, handler: never) => {
      tools.push({ name, shape, handler })
    },
  } as unknown as McpServer
  return { server, tools }
}

describe("makeProviderFamily without daemon or home", () => {
  it("resolves a built-in, an imported package, and null for the rest", async () => {
    const { family, importPackage } = build()
    expect((await family.resolve("inproc"))?.slug).toBe("inproc")
    expect(importPackage).not.toHaveBeenCalled() // built-ins never import

    expect((await family.resolve("free"))?.slug).toBe("free")
    expect(importPackage).toHaveBeenCalledWith("@fake/free")

    expect(await family.resolve("absent")).toBeNull() // import throws
    expect(await family.resolve("broken")).toBeNull() // module has no provider
    expect(await family.resolve("not-in-catalog")).toBeNull()
  })

  it("passes the stored creds to the loader", async () => {
    const { family } = build({ FAKE_PAID_KEY: "secret-value" })
    expect((await family.resolve("paid"))?.kind).toBe("configured")
  })

  it("lists supported / available / ready from env creds", async () => {
    const before = await build().family.list()
    const status = (rows: typeof before) =>
      Object.fromEntries(rows.map(r => [r.slug, r.status]))
    expect(status(before)).toEqual({
      inproc: "ready",
      paid: "available", // needs setup, no creds, no ledger
      free: "ready",
      absent: "supported",
      broken: "supported",
    })
    const after = await build({ FAKE_PAID_KEY: "secret-value" }).family.list()
    expect(status(after)["paid"]).toBe("ready")
    // the listing never carries a creds value
    expect(JSON.stringify(after)).not.toContain("secret-value")
  })

  it("setup: unions fields, validates per provider, refuses to write env creds", async () => {
    const { family } = build()
    const schema = await family.setupSchema()
    expect(schema.validSlugs).toEqual(["paid"])
    expect(schema.fields.map(f => [f.name, f.required])).toEqual([
      ["apiKey", false],
      ["region", false],
    ])

    expect(await family.setup("free", {})).toEqual({
      ok: false,
      hint: "provider 'free' is not configurable",
    })
    expect(await family.setup("paid", { region: "x" })).toEqual({
      ok: false,
      hint: "missing required field(s): apiKey",
    })
    const res = await family.setup("paid", { apiKey: "secret-value" })
    expect(res.ok).toBe(false) // env store is read-only
    expect(res.hint).toContain("read-only")
    expect(JSON.stringify(res)).not.toContain("secret-value")
  })

  it("setup with a memory store writes creds and the ledger, hint has no value", async () => {
    const family = makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: CATALOG.slice(1, 2),
      toInfo: h => ({ kind: h.kind }),
      importPackage: async () => MODULES["@fake/paid"]!,
      fromModule: mod =>
        handle("paid", {
          requiresSetup: true,
          setupFields: (mod["provider"] as { setupFields: typeof PAID_FIELDS }).setupFields,
        }),
      credsStore: makeMemoryCredsStore<Record<string, string>>(),
      ledger: makeMemorySetupLedger(),
    })
    expect((await family.list())[0]?.status).toBe("available")
    const res = await family.setup("paid", { apiKey: "secret-value", region: "" })
    expect(res.ok).toBe(true)
    expect(res.hint).not.toContain("secret-value")
    expect(await family.credsStore.read("paid")).toEqual({ apiKey: "secret-value" }) // empty region dropped
    expect(await family.ledger.exists("paid")).toBe(true)
    expect((await family.list())[0]?.status).toBe("ready")
  })

  it("setup treats an omitted required as required", async () => {
    const family = makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: [CATALOG[0]!],
      toInfo: h => ({ kind: h.kind }),
      builtins: {
        inproc: () =>
          handle("inproc", {
            requiresSetup: true,
            // `required` omitted: the SetupField contract says that is required.
            setupFields: [{ name: "token", description: "token" }],
          }),
      },
      credsStore: makeMemoryCredsStore(),
      ledger: makeMemorySetupLedger(),
    })
    expect(await family.setup("inproc", {})).toEqual({
      ok: false,
      hint: "missing required field(s): token",
    })
    expect((await family.setup("inproc", { token: "t" })).ok).toBe(true)
    expect(await family.credsStore.read("inproc")).toEqual({ token: "t" })
  })

  it("setup merges over previously stored optional creds", async () => {
    const family = makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: [CATALOG[0]!],
      toInfo: h => ({ kind: h.kind }),
      builtins: {
        inproc: () =>
          handle("inproc", {
            requiresSetup: true,
            setupFields: [
              { name: "apiKey", description: "key", required: true },
              { name: "region", description: "region", required: false },
            ],
          }),
      },
      credsStore: makeMemoryCredsStore<Record<string, string>>({
        inproc: { apiKey: "old", region: "eu" },
      }),
      ledger: makeMemorySetupLedger(),
    })
    expect((await family.setup("inproc", { apiKey: "new" })).ok).toBe(true)
    expect(await family.credsStore.read("inproc")).toEqual({
      apiKey: "new",
      region: "eu",
    })
  })

  it("setup reports a ledger write failure instead of throwing", async () => {
    const ledger = makeMemorySetupLedger()
    ledger.write = async () => {
      throw new Error("ledger down")
    }
    const family = makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: [CATALOG[0]!],
      toInfo: h => ({ kind: h.kind }),
      builtins: {
        inproc: () =>
          handle("inproc", {
            requiresSetup: true,
            setupFields: [{ name: "token", description: "token", required: true }],
          }),
      },
      credsStore: makeMemoryCredsStore(),
      ledger,
    })
    expect(await family.setup("inproc", { token: "t" })).toEqual({
      ok: false,
      hint: "ledger down",
    })
  })

  it("registers list and setup tools with the given names", async () => {
    const { family } = build()
    const { server, tools } = fakeServer()
    await family.registerTools(server, {
      list: { name: "list_fake_providers", description: "l" },
      setup: { name: "setup_fake_provider", description: "s" },
    })
    expect(tools.map(t => t.name)).toEqual(["list_fake_providers", "setup_fake_provider"])
    const listed = JSON.parse((await tools[0]!.handler({})).content[0]!.text) as Array<{ slug: string }>
    expect(listed.map(e => e.slug)).toEqual(CATALOG.map(e => e.slug))
    const bad = await tools[1]!.handler({ slug: "free", apiKey: "", region: "" })
    expect(bad.isError).toBe(true)
  })

  it("a load override replaces builtins and the import path", async () => {
    const family = makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: CATALOG,
      toInfo: h => ({ kind: h.kind }),
      load: async slug => (slug === "free" ? handle("free", { kind: "custom" }) : null),
      credsStore: makeMemoryCredsStore(),
      ledger: makeMemorySetupLedger(),
    })
    expect((await family.resolve("free"))?.kind).toBe("custom")
    expect(await family.resolve("inproc")).toBeNull()
  })
})

describe("makeEnvCredsStore", () => {
  it("reads only set, non-empty variables and never writes", async () => {
    const store = makeEnvCredsStore({
      vars: { p: { apiKey: "P_KEY", url: "P_URL" } },
      env: { P_KEY: "k", P_URL: "" },
    })
    expect(await store.read("p")).toEqual({ apiKey: "k" })
    expect(await store.exists("p")).toBe(true)
    expect(await store.read("other")).toBeNull()
    expect(await store.exists("other")).toBe(false)
    await expect(store.write("p", { apiKey: "x" })).rejects.toThrow("read-only")
    const none = makeEnvCredsStore({ vars: { p: { apiKey: "P_KEY" } }, env: {} })
    expect(await none.read("p")).toBeNull()
  })
})

describe("makeMemorySetupLedger", () => {
  it("round-trips a record by copy", async () => {
    const ledger = makeMemorySetupLedger()
    expect(await ledger.exists("a")).toBe(false)
    const rec = { slug: "a", completedAt: "t", steps: [{ id: "creds", completedAt: "t" }] }
    await ledger.write("a", rec)
    rec.steps.length = 0
    expect((await ledger.read("a"))?.steps).toHaveLength(1)
    expect(await ledger.exists("a")).toBe(true)
  })
})

describe("makeProviderFamily legacySetup and non-catalog slugs", () => {
  const fields = [
    { name: "token", description: "required omitted" },
    { name: "url", description: "url", required: false },
  ] as const
  const make = (legacySetup: boolean) =>
    makeProviderFamily<FakeHandle, FakeInfo>({
      family: "fake",
      catalog: CATALOG.slice(1, 2),
      toInfo: h => ({ kind: h.kind }),
      load: async slug =>
        slug === "paid" || slug === "composite"
          ? handle(slug, { requiresSetup: true, setupFields: fields })
          : null,
      credsStore: makeMemoryCredsStore<Record<string, string>>(),
      ledger: makeMemorySetupLedger(),
      legacySetup,
    })

  it("load is called for a slug outside the catalog", async () => {
    const family = make(false)
    expect((await family.resolve("composite"))?.slug).toBe("composite")
    expect(await family.resolve("nope")).toBeNull()
  })

  it("legacySetup: omitted required is optional, re-setup replaces", async () => {
    const family = make(true)
    expect((await family.setup("paid", { token: "", url: "" })).ok).toBe(true)
    await family.setup("paid", { token: "a", url: "u" })
    await family.setup("paid", { token: "b", url: "" })
    expect(await family.credsStore.read("paid")).toEqual({ token: "b" })
  })

  it("legacySetup: a store failure propagates; default returns ok:false", async () => {
    const boom = {
      read: async () => null,
      exists: async () => false,
      write: async () => {
        throw new Error("disk full")
      },
    }
    const build = (legacySetup: boolean) =>
      makeProviderFamily<FakeHandle, FakeInfo>({
        family: "fake",
        catalog: CATALOG.slice(1, 2),
        toInfo: h => ({ kind: h.kind }),
        load: async () => handle("paid", { setupFields: [{ name: "token", description: "t", required: true }] }),
        credsStore: boom,
        ledger: makeMemorySetupLedger(),
        legacySetup,
      })
    await expect(build(true).setup("paid", { token: "x" })).rejects.toThrow("disk full")
    expect(await build(false).setup("paid", { token: "x" })).toEqual({ ok: false, hint: "disk full" })
  })

  it("registerTools can skip the list tool", async () => {
    const { server, tools } = fakeServer()
    await make(false).registerTools(server, {
      setup: { name: "setup_fake_provider", description: "s" },
    })
    expect(tools.map(t => t.name)).toEqual(["setup_fake_provider"])
  })
})
