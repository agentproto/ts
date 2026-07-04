import { describe, expect, it } from "vitest"
import {
  BUILTIN_TUNNEL_PROVIDERS,
  BUILTIN_TUNNEL_SLUGS,
  LEGACY_PROVIDER_ALIAS,
  normalizeProviderSlug,
  resolveTunnelProvider,
  discoverTunnelHandles,
} from "../remote-providers/registry.js"
import {
  CLOUDFLARE_QUICK_SLUG,
} from "../remote-providers/quick.js"
import { CLOUDFLARE_NAMED_SLUG } from "../remote-providers/named.js"
import { NGROK_SLUG } from "../remote-providers/ngrok.js"

describe("tunnel provider registry", () => {
  it("maps legacy short names to canonical slugs", () => {
    expect(normalizeProviderSlug("quick")).toBe(CLOUDFLARE_QUICK_SLUG)
    expect(normalizeProviderSlug("named")).toBe(CLOUDFLARE_NAMED_SLUG)
    // already-canonical slugs pass through unchanged
    expect(normalizeProviderSlug(CLOUDFLARE_NAMED_SLUG)).toBe(CLOUDFLARE_NAMED_SLUG)
    expect(normalizeProviderSlug(NGROK_SLUG)).toBe(NGROK_SLUG)
    // unknown slug passes through (resolver decides supported/null)
    expect(normalizeProviderSlug("tailscale")).toBe("tailscale")
  })

  it("registers all three built-ins keyed by canonical slug", () => {
    expect(Object.keys(BUILTIN_TUNNEL_PROVIDERS).sort()).toEqual(
      [...BUILTIN_TUNNEL_SLUGS].sort(),
    )
    expect(LEGACY_PROVIDER_ALIAS).toEqual({
      quick: CLOUDFLARE_QUICK_SLUG,
      named: CLOUDFLARE_NAMED_SLUG,
    })
  })

  it("resolves built-ins (incl. via legacy alias) to handles with the right slug", async () => {
    const quick = await resolveTunnelProvider("quick")
    expect(quick?.slug).toBe(CLOUDFLARE_QUICK_SLUG)
    expect(quick?.capabilities.stableUrl).toBe(false)

    const named = await resolveTunnelProvider("named", {
      creds: { hostname: "a.example.com", tunnelId: "uuid-1" },
    })
    expect(named?.slug).toBe(CLOUDFLARE_NAMED_SLUG)
    expect(named?.capabilities.stableUrl).toBe(true)

    // ngrok was previously listable-but-not-creatable; now it resolves.
    const ngrok = await resolveTunnelProvider(NGROK_SLUG, {
      creds: { authToken: "tok", domain: "x.ngrok.app" },
    })
    expect(ngrok?.slug).toBe(NGROK_SLUG)
    // domain set → stable URL
    expect(ngrok?.capabilities.stableUrl).toBe(true)
  })

  it("returns null for an unknown / not-installed slug", async () => {
    expect(await resolveTunnelProvider("does-not-exist")).toBeNull()
  })

  it("discoverTunnelHandles excludes catalog + built-in slugs", async () => {
    // No third-party adapters installed in the test env → empty, and it must
    // never surface a built-in.
    const extras = await discoverTunnelHandles(new Set(BUILTIN_TUNNEL_SLUGS))
    expect(extras.every((h) => !BUILTIN_TUNNEL_SLUGS.includes(h.slug as never))).toBe(
      true,
    )
  })
})
