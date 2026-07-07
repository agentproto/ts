/**
 * Provider-preset family on top of `@agentproto/provider-kit` — the *thin,
 * honest* lister (Option B). Unlike tunnels/sandboxes/eval-reporters, presets
 * are bundled static data with no binary to install, no package to resolve, and
 * no setup ledger: their only "setup" is an ambient API-key env var. So this
 * module does NOT use `makeAdapterResolver` / `makeAdapterLister` / the wizard
 * (all install-oriented, a forced fit). It reuses only `makeListTool` — the one
 * kit primitive that's genuinely about "JSON a lister's output as an MCP tool."
 *
 * Status is derived honestly from the daemon's own environment (the env agents
 * spawn into), not the CLI caller's:
 *   "ready"     — `process.env[preset.keyEnv]` is set (key available to spawn)
 *   "available" — key absent (preset known, usable once the env var is provided)
 *
 * There is no "supported" state: presets ship in-repo, so they're always at
 * least "available." `version` is the literal "built-in".
 *
 * Security (Appendix B): `PresetInfo` carries only `keyEnv` (the env-var NAME),
 * never a key value. The list tool never returns creds — there are none to
 * return; keys live in the operator's environment, not a creds store.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeListTool, type AdapterEntry } from "@agentproto/provider-kit"
import { anthropicGatewayPresetList, type ProviderPreset } from "@agentproto/provider-presets"

/**
 * Manifest-declared AIP-45 preset, the minimum the catalog needs to merge
 * an adapter-contributed preset into the listing. Mirrors
 * `AgentCliPresetDeclaration`'s fields without importing
 * `@agentproto/driver-agent-cli` into the runtime package (same structural-
 * type pattern as `DeclaredAdapterOption` in spawn-defaults.ts).
 */
export interface DeclaredAdapterPreset {
  id: string
  label: string
  description?: string
  schemaFlavor: ProviderPreset["schemaFlavor"]
  baseUrl: string
  keyEnv: string
  scrubEnv?: string[]
  defaultModel?: string
  homepage?: string
}

/**
 * Family descriptor surfaced as `AdapterEntry.info`. User-facing preset facts
 * only — no cred values (there are none in the registry), no adapter projection
 * detail (`scrubEnv` stays internal to adapter manifests).
 */
export interface PresetInfo {
  /** API schema flavor — which adapter family can consume this preset. */
  schemaFlavor: ProviderPreset["schemaFlavor"]
  /** Base URL the client hits. */
  baseUrl: string
  /** Env-var NAME holding the API key (never the value). */
  keyEnv: string
  /** Conventional default model id, if any. */
  defaultModel?: string
  /** Homepage/docs URL. */
  homepage?: string
}

/**
 * Normalize a manifest-declared preset into the canonical `ProviderPreset`
 * shape the catalog lists. `scrubEnv` defaults to empty (an adapter that
 * scrubs in code may omit it); `description` defaults to empty. Pure.
 */
export function declaredPresetToProviderPreset(
  decl: DeclaredAdapterPreset,
): ProviderPreset {
  return {
    id: decl.id,
    label: decl.label,
    description: decl.description ?? "",
    schemaFlavor: decl.schemaFlavor,
    baseUrl: decl.baseUrl,
    keyEnv: decl.keyEnv,
    scrubEnv: decl.scrubEnv ?? [],
    ...(decl.defaultModel ? { defaultModel: decl.defaultModel } : {}),
    ...(decl.homepage ? { homepage: decl.homepage } : {}),
  }
}

/**
 * Map the static preset registry → status-classified catalog entries, reading
 * the daemon's environment for key presence. Pure (no I/O) save the `process`
 * .env read; safe to call on every list invocation.
 *
 * `adapterPresets` — manifest-declared presets contributed by loaded adapters
 * (Stage 3 AIP-45 `presets` field). Merged AFTER the built-in registry and
 * deduped by id: an adapter-declared id that collides with a built-in is
 * ignored (the registry is the source of truth for canonical providers), so
 * an adapter can't silently override moonshot/openrouter facts. The live
 * wiring that reads each adapter's `.presets` and passes them here is Stage 4;
 * today this is the tested seam.
 */
export function listPresets(
  env: Record<string, string | undefined> = process.env,
  adapterPresets: readonly DeclaredAdapterPreset[] = [],
): AdapterEntry<PresetInfo>[] {
  const builtinIds = new Set(anthropicGatewayPresetList.map((p) => p.id))
  const extra: ProviderPreset[] = []
  for (const decl of adapterPresets) {
    if (builtinIds.has(decl.id)) continue
    extra.push(declaredPresetToProviderPreset(decl))
  }
  const all = [...anthropicGatewayPresetList, ...extra]
  return all.map((preset) => {
    const keyPresent = Boolean(env[preset.keyEnv])
    return {
      slug: preset.id,
      name: preset.label,
      description: preset.description,
      packageName: "@agentproto/provider-presets",
      status: keyPresent ? "ready" : "available",
      version: "built-in",
      info: {
        schemaFlavor: preset.schemaFlavor,
        baseUrl: preset.baseUrl,
        keyEnv: preset.keyEnv,
        ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
        ...(preset.homepage ? { homepage: preset.homepage } : {}),
      },
    }
  })
}

/**
 * Register the preset family's MCP tool on the server:
 *   - `list_provider_presets` (parameterless; status + facts, no creds)
 *
 * No setup tool — presets have no creds store; an operator sets the env var
 * directly (or passes an adapter `auth_token` option at spawn).
 *
 * `adapterPresets` — manifest-declared presets (AIP-45 `presets` field) from
 * loaded adapters, merged into the listing. The caller (gateway boot) is
 * responsible for collecting them; absent today, this is the seam Stage 4
 * wires live.
 */
export function registerPresetTools(
  server: McpServer,
  opts: { adapterPresets?: readonly DeclaredAdapterPreset[] } = {},
): void {
  const adapterPresets = opts.adapterPresets ?? []
  makeListTool<PresetInfo>({
    server,
    toolName: "list_provider_presets",
    description:
      "List provider gateway presets (built-in e.g. moonshot, openrouter, " +
      "plus any declared by loaded adapters) with their status (ready when " +
      "the provider's API-key env var is set in the daemon's environment, " +
      "else available), base URL, schema flavor, and default model. Presets " +
      "are static data — no install/setup; set the listed key env var (e.g. " +
      "MOONSHOT_API_KEY) to make one ready. No credentials are ever returned.",
    lister: async () => listPresets(process.env, adapterPresets),
  })
}
