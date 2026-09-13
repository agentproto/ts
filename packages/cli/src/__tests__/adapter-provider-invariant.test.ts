/**
 * Cross-cutting manifest invariant — every billing provider slug an adapter
 * declares MUST be a member of the canonical catalog enum.
 *
 * Why this test exists: `serve.ts` projects each manifest's `provider` /
 * `models.allowed[].provider` into the runtime's `AdapterAuthDescriptor` via
 * `CatalogProviderSchema.safeParse`, and DROPS anything that doesn't parse
 * (`if (parsed.success)`) rather than failing. That silent drop is exactly how
 * D3 shipped: the pi manifest declared `moonshotai` (the upstream/wire slug)
 * where the catalog's canonical slug is `moonshot`, so pi's per-model billing
 * provider was silently discarded, the resolver fell through to the GLOBAL
 * catalog's routing for that id (openrouter), and a genuinely-eligible
 * moonshot profile was rejected as ineligible. Nothing failed loudly — the
 * declaration just evaporated.
 *
 * Keeping the drop non-fatal at runtime is deliberate (a typo must not brick a
 * spawn); this test is the compensating control that makes the same typo a
 * BUILD failure instead of a silent misroute.
 *
 * Note the deliberate asymmetry this encodes: a model id's VENDOR PREFIX is a
 * wire-format fact owned by the adapter's own CLI (pi genuinely wants
 * `moonshotai/kimi-k2.7-code`), while `provider` is a BILLING fact owned by the
 * catalog. Only the latter is constrained here.
 */
import { describe, it, expect } from "vitest"
import { CatalogProviderSchema } from "@agentproto/model-catalog"
import { claudeCode } from "@agentproto/adapter-claude-code"
import { claudeSdk } from "@agentproto/adapter-claude-sdk"
import { codex } from "@agentproto/adapter-codex"
import { gemini } from "@agentproto/adapter-gemini"
import { hermes } from "@agentproto/adapter-hermes"
import { mastraAgent } from "@agentproto/adapter-mastra-agent"
import { mastracode } from "@agentproto/adapter-mastracode"
import { mastracodeInprocess } from "@agentproto/adapter-mastracode-inprocess"
import { openclaw } from "@agentproto/adapter-openclaw"
import { opencode } from "@agentproto/adapter-opencode"
import { pi } from "@agentproto/adapter-pi"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"

const ADAPTERS: ReadonlyArray<readonly [string, AgentCliHandle]> = [
  ["claude-code", claudeCode],
  ["claude-sdk", claudeSdk],
  ["codex", codex],
  ["gemini", gemini],
  ["hermes", hermes],
  ["mastra-agent", mastraAgent],
  ["mastracode", mastracode],
  ["mastracode-inprocess", mastracodeInprocess],
  ["openclaw", openclaw],
  ["opencode", opencode],
  ["pi", pi],
]

describe("adapter manifest invariant — declared providers are canonical catalog slugs", () => {
  it.each(ADAPTERS)("%s: handle.provider parses against CatalogProviderSchema", (slug, handle) => {
    if (!handle.provider) return // no fixed provider (model-derived adapters) — nothing to check
    const parsed = CatalogProviderSchema.safeParse(handle.provider)
    expect(
      parsed.success,
      `adapter "${slug}" declares provider "${handle.provider}", which is not a canonical catalog provider. ` +
        `serve.ts would silently DROP it, so the runtime would fall back to the global catalog's routing.`,
    ).toBe(true)
  })

  it.each(ADAPTERS)("%s: every models.allowed[].provider is a catalog slug (or its own declared @route)", (slug, handle) => {
    const offenders: string[] = []
    for (const entry of handle.models?.allowed ?? []) {
      if (typeof entry === "string" || !entry.provider) continue
      // A GATEWAY-routed entry legitimately names a route, not a vendor:
      // `moonshot/kimi-k2.7-code@llm-endpoint` bills the `llm-endpoint` proxy,
      // which is a route id and deliberately not a member of the catalog's
      // VENDOR enum. Accept exactly that self-consistent case — the declared
      // provider equals the id's own `@route` suffix — rather than duplicating
      // the gateway-preset registry here (packages/cli does not depend on
      // @agentproto/provider-presets, and a hand-copied list would drift).
      // Everything else is a direct route and must be a canonical vendor.
      const atRoute = entry.id.includes("@") ? entry.id.slice(entry.id.lastIndexOf("@") + 1) : undefined
      if (atRoute !== undefined && entry.provider === atRoute) continue
      if (!CatalogProviderSchema.safeParse(entry.provider).success) {
        offenders.push(`${entry.id} -> "${entry.provider}"`)
      }
    }
    expect(
      offenders,
      `adapter "${slug}" declares non-canonical billing providers: ${offenders.join(", ")}. ` +
        `These are silently dropped by serve.ts's projection (D3). Use the catalog slug ` +
        `(e.g. "moonshot", not the upstream wire slug "moonshotai") — the model id's own ` +
        `vendor PREFIX may keep the upstream spelling.`,
    ).toEqual([])
  })
})
