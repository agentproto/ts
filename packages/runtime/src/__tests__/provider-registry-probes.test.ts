/**
 * Registry-level behavior of the shared probe seam (`provider-probes.ts`):
 * the module namespace is imported once and reused, every provider HANDLE is
 * rebuilt per request with that request's own creds (no credential-dependent
 * instance is ever shared), and one probe instance serves the sentinel,
 * tunnel and sandbox families alike.
 */

import { afterEach, describe, expect, it } from "vitest"

import { createProviderProbeCache, type ProviderModule } from "../provider-probes.js"
import {
  discoverSentinelHandles,
  resolveSentinelProvider,
  type SentinelCreds,
} from "@agentproto/sentinel"
import {
  discoverTunnelHandles,
  resolveTunnelProvider,
  type TunnelCreds,
} from "../remote-providers/registry.js"
import { resolveSandboxProvider } from "../sandbox-providers/registry.js"

const sentinelHandle = (slug: string, creds: SentinelCreds | null): Record<string, unknown> => ({
  capabilities: { subjects: [] },
  create: () => ({}),
  attach: () => ({}),
  cancel: () => {},
  status: () => ({ kind: "disabled" } satisfies Record<string, unknown>),
  defaultTypes: () => [],
  slug,
  creds,
})

const tunnelHandle = (slug: string, creds: TunnelCreds | null): Record<string, unknown> => ({
  capabilities: { stableUrl: null },
  start: async () => {},
  stop: async () => {},
  slug,
  creds,
})

describe("registries through the shared probe", () => {
  afterEach(() => {
    delete process.env.E2B_API_KEY
  })

  it("imports a third-party sentinel package once and rebuilds its handle per request's creds", async () => {
    const imports: string[] = []
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        imports.push(specifier)
        return {
          acmeSentinelProvider: (creds?: SentinelCreds | null) => sentinelHandle("acme", creds ?? null),
        }
      },
    })
    const discover = async () => [{ slug: "acme", packageName: "@agentproto/custom-acme" }]

    const withToken = await resolveSentinelProvider("acme", {
      creds: { token: "token-a" },
      probe: cache,
      discover,
    })
    const otherCreds = await resolveSentinelProvider("acme", {
      creds: { token: "token-b" },
      probe: cache,
      discover,
    })

    expect(imports).toEqual(["@agentproto/custom-acme"])
    expect(withToken).not.toBe(otherCreds)
    expect(withToken).toMatchObject({ creds: { token: "token-a" } })
    expect(otherCreds).toMatchObject({ creds: { token: "token-b" } })
  })

  it("imports a third-party tunnel package once and rebuilds its handle per request's creds", async () => {
    const imports: string[] = []
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        imports.push(specifier)
        return {
          acmeTunnelProvider: (creds?: TunnelCreds | null) => tunnelHandle("acme", creds ?? null),
        }
      },
    })
    const discover = async () => [{ slug: "acme", packageName: "@agentproto/custom-acme" }]

    const first = await resolveTunnelProvider("acme", {
      creds: { tunnelId: "tunnel-a" },
      probe: cache,
      discover,
    })
    const second = await resolveTunnelProvider("acme", {
      creds: { tunnelId: "tunnel-b" },
      probe: cache,
      discover,
    })

    expect(imports).toEqual(["@agentproto/custom-acme"])
    expect(first).toMatchObject({ creds: { tunnelId: "tunnel-a" } })
    expect(second).toMatchObject({ creds: { tunnelId: "tunnel-b" } })
  })

  it("serves the sentinel and tunnel families from ONE probe import of the same package", async () => {
    let imports = 0
    const cache = createProviderProbeCache({
      importModule: async () => {
        imports++
        return {
          acmeSentinelProvider: (creds?: SentinelCreds | null) => sentinelHandle("acme", creds ?? null),
          acmeTunnelProvider: (creds?: TunnelCreds | null) => tunnelHandle("acme", creds ?? null),
        }
      },
    })
    const discover = async () => [{ slug: "acme", packageName: "@agentproto/custom-acme" }]

    const sentinel = await resolveSentinelProvider("acme", {
      creds: { token: "sentinel-token" },
      probe: cache,
      discover,
    })
    const tunnel = await resolveTunnelProvider("acme", {
      creds: { hostname: "tunnel.example" },
      probe: cache,
      discover,
    })

    expect(imports).toBe(1)
    expect(sentinel).toMatchObject({ creds: { token: "sentinel-token" } })
    expect(tunnel).toMatchObject({ creds: { hostname: "tunnel.example" } })
  })

  it("returns null without probing when discovery has no such slug, and when the probe finds nothing", async () => {
    const imports: string[] = []
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        imports.push(specifier)
        return {}
      },
    })

    expect(
      await resolveSentinelProvider("absent", {
        probe: cache,
        discover: async () => [],
      }),
    ).toBeNull()

    // Discovered but not importable (the virtual-store-only packages).
    expect(
      await resolveSentinelProvider("ghost", {
        probe: cache,
        discover: async () => [{ slug: "ghost", packageName: "@agentproto/adapter-ghost" }],
      }),
    ).toBeNull()

    expect(imports).toEqual(["@agentproto/adapter-ghost"])
  })

  it("rebuilds a sandbox handle per request's creds while importing its package once", async () => {
    let imports = 0
    const cache = createProviderProbeCache({
      importModule: async () => {
        imports++
        return { e2bSandboxProvider: { boot: async () => ({}) } }
      },
    })

    const saved = process.env.E2B_API_KEY
    delete process.env.E2B_API_KEY
    const withCreds = await resolveSandboxProvider("e2b", {
      creds: { apiKey: "e2b-key" },
      probe: cache,
    })
    const withOtherCreds = await resolveSandboxProvider("e2b", {
      creds: { apiKey: "e2b-key-2" },
      probe: cache,
    })
    const descriptorOnly = await resolveSandboxProvider("e2b", { probe: cache })
    if (saved === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = saved

    expect(imports).toBe(1)
    expect(withCreds).not.toBe(withOtherCreds)
    expect(withCreds?.version).toBe("installed")
    expect(withCreds?.capabilities.lifecyclePause).toBe(true)
    expect(await withCreds!.check()).toBe(true)
    expect(await withOtherCreds!.check()).toBe(true)
    expect(await descriptorOnly!.check()).toBe(false)

    // Unpublished catalog placeholders always resolve null. Under real Node
    // the sync preflight proves them missing and no importer runs; under
    // vitest (`import.meta.resolve` is absent) the normal import path decides.
    const modalImports: string[] = []
    const modalCache = createProviderProbeCache({
      importModule: async (specifier) => {
        modalImports.push(specifier)
        return {}
      },
    })
    expect(await resolveSandboxProvider("modal", { probe: modalCache })).toBeNull()
    const preflightAvailable =
      typeof (import.meta as { resolve?: unknown }).resolve === "function"
    expect(modalImports).toEqual(preflightAvailable ? [] : ["@agentproto/sandbox-modal"])
  })

  it("lists only importable extras from discovery, sorted, skipping catalog slugs", async () => {
    const cache = createProviderProbeCache({
      importModule: async (specifier): Promise<ProviderModule> => {
        if (specifier === "@agentproto/adapter-zed") {
          return { zedSentinelProvider: () => sentinelHandle("zed", null) }
        }
        throw new Error("not installed")
      },
    })
    const discover = async () => [
      { slug: "zed", packageName: "@agentproto/adapter-zed" },
      { slug: "alpha", packageName: "@agentproto/adapter-alpha" },
    ]

    const sentinelExtras = await discoverSentinelHandles(new Set(), {
      probe: cache,
      discover,
    })
    expect(sentinelExtras.map((h) => h.slug)).toEqual(["zed"])

    const tunnelExtras = await discoverTunnelHandles(new Set(["zed"]), {
      probe: cache,
      discover,
    })
    expect(tunnelExtras).toEqual([])
  })
})
