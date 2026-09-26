/**
 * The catalog join (`listCatalogModelsFromInstalled`) must include GENERIC
 * ACP adapters' curated models — the kimi-cli spawn regression: the join
 * used to read only the npm/native listing, so a generic-ACP catalog entry
 * with curated `models` never appeared in any route row's `adapters`, and
 * the adapter-capability spawn guard (`checkModelAdapterEligibility`)
 * rejected kimi-cli's OWN manifest default with `adapter "kimi-cli" does
 * not declare support for model "kimi-k3" on route "moonshot"` (while
 * naming claude-code/claude-sdk — the native adapters that DO curate the
 * id — as the alternatives).
 *
 * The lister + per-slug resolver are mocked; `toAuthDescriptor` and the
 * runtime join itself stay real.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("../resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resolve.js")>()
  return {
    ...actual,
    listAdaptersWithAcp: vi.fn(),
    resolveAdapter: vi.fn(),
  }
})
vi.mock("@agentproto/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    listAuthProfiles: vi.fn(async () => []),
  }
})

import { checkModelAdapterEligibility } from "@agentproto/runtime/catalog-models"
import { ACP_CATALOG, acpHandleFromSpec } from "../acp-generic.js"
import { listCatalogModelsFromInstalled } from "../catalog-models.js"
import { listAdaptersWithAcp, resolveAdapter } from "../resolve.js"

const kimi = ACP_CATALOG.find((e) => e.slug === "kimi-cli")!

/** kimi-cli as the merged listing reports it when the bin is present. */
const KIMI_READY = {
  slug: "kimi-cli",
  status: "ready",
  source: "acp-catalog",
  modelDetails: kimi.models!.allowed!.map((id) => ({ id, provider: "moonshot" })),
}

/** A native adapter that ALSO curates kimi-k3 on moonshot (claude-code in
 *  prod) — the row that made the guard's rejection positive, not vacuous. */
const NATIVE_CURATOR = {
  slug: "claude-code",
  status: "ready",
  modelDetails: [{ id: "kimi-k3", provider: "moonshot" }],
}

/** A generic entry whose bin is absent — listed as `supported`, and must
 *  contribute nothing to the join. */
const VIBE_SUPPORTED = {
  slug: "mistral-vibe",
  status: "supported",
  source: "acp-catalog",
  modelDetails: [{ id: "mistral-large-latest", provider: "mistral" }],
}

beforeEach(() => {
  vi.mocked(listAdaptersWithAcp).mockReset()
  vi.mocked(resolveAdapter).mockReset()
  // Every slug resolves to a minted generic handle — good enough for the
  // real `toAuthDescriptor` projection the join applies per adapter.
  vi.mocked(resolveAdapter).mockImplementation(
    async (slug: string) =>
      ({ handle: acpHandleFromSpec(kimi.slug === slug ? kimi : { slug, bin: slug }) }) as never,
  )
})

describe("listCatalogModelsFromInstalled — generic ACP adapters", () => {
  it("a ready generic adapter's curated models join the catalog, so the spawn guard accepts its own default", async () => {
    vi.mocked(listAdaptersWithAcp).mockResolvedValue([NATIVE_CURATOR, KIMI_READY] as never)
    const catalog = await listCatalogModelsFromInstalled({})
    const moonshotRows = catalog.vendors
      .flatMap((v) => v.products)
      .flatMap((p) => p.routes)
      .filter((r) => r.route === "moonshot")
    expect(moonshotRows.some((r) => r.adapters.includes("kimi-cli"))).toBe(true)
    // The exact spawn-guard call that used to fail: another adapter's row
    // proves the combination servable, and kimi-cli is now on it too.
    const verdict = checkModelAdapterEligibility(catalog, "kimi-cli", "kimi-k3", "moonshot")
    expect(verdict.ok).toBe(true)
  })

  it("a bin-absent (`supported`) generic entry contributes no models", async () => {
    vi.mocked(listAdaptersWithAcp).mockResolvedValue([VIBE_SUPPORTED] as never)
    const catalog = await listCatalogModelsFromInstalled({})
    const adapters = catalog.vendors
      .flatMap((v) => v.products)
      .flatMap((p) => p.routes)
      .flatMap((r) => r.adapters)
    expect(adapters).not.toContain("mistral-vibe")
  })
})
