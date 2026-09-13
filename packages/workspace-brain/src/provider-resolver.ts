/**
 * `provider-resolver` — factory mapping a {@link KnowledgeProviderConfig}
 * entry from a workspace's `knowledge.json` onto a live
 * {@link IKnowledgeProvider} instance.
 *
 * One tiny, deliberate per-adapter mapping layer. The config entries are
 * intentionally FLAT (adapter options ride the string index on
 * `KnowledgeProviderConfig`), so this module is where a `files` entry's
 * `workspacePath` becomes a `FilesKnowledgeAdapter`, a `gbrain-doc` entry's
 * `endpoint`/`bearer` become an `endpoint`/`bearerToken` config, and so on.
 * It is also the one choke point where `env:`-prefixed secrets are resolved
 * and where missing required fields / unknown adapters fail loudly — before
 * any provider is constructed.
 *
 * The two `*OptionsFromEntry` helpers are exported PURE (no process.env IO
 * beyond `resolveSecret`) so tests can assert the endpoint-strip and
 * key-mapping logic without constructing live adapters.
 */

import { FilesKnowledgeAdapter, LocalFs } from "@agentproto/adapter-knowledge-files"
import {
  GbrainDocKnowledgeAdapter,
  parseGbrainDocAdapterConfig,
} from "@agentproto/adapter-knowledge-gbrain-doc"
import {
  QdrantKnowledgeAdapter,
  parseQdrantAdapterConfig,
} from "@agentproto/adapter-knowledge-qdrant"
import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import { z } from "zod"
import type {
  KnowledgeConfig,
  KnowledgeProviderAdapterId,
  KnowledgeProviderConfig,
} from "./types.js"

/** Every adapter id the resolver knows how to instantiate (incl. the
 *  not-yet-implemented `corpus`, which throws). */
const ADAPTER_IDS = ["files", "gbrain-doc", "qdrant", "corpus"] as const

export const KNOWLEDGE_PROVIDER_ADAPTERS: readonly KnowledgeProviderAdapterId[] =
  ADAPTER_IDS

/** Inputs the resolver needs that don't live on the provider entry. */
export interface ProviderResolutionContext {
  /** Absolute brain directory — roots the `files` adapter's FsPort. */
  readonly brainDir: string
}

/** A provider entry resolved to a live provider + its merge-affecting knobs. */
export interface ResolvedProvider {
  /** The entry's `id` (referenced by `defaultQueryProviders`). */
  readonly id: string
  /** Federated-merge score multiplier. Default 1. */
  readonly weight: number
  /** Whether `ingest()` fans out to this provider. Default true. */
  readonly auto: boolean
  /** The concrete, ready-to-query provider. */
  readonly provider: IKnowledgeProvider
}

/**
 * Resolve a secret-ish config value. Values of the form `env:NAME` read
 * `process.env.NAME` (throwing a clear error when unset/empty); anything
 * else is returned as-is; non-strings throw.
 */
export function resolveSecret(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(
      `knowledge provider secret must be a string (got ${
        value === undefined ? "undefined" : typeof value
      })`,
    )
  }
  if (value.startsWith("env:")) {
    const name = value.slice("env:".length)
    const resolved = process.env[name]
    if (!resolved) {
      throw new Error(
        `knowledge provider secret env:${name} is unset or empty — set ${name} in the environment`,
      )
    }
    return resolved
  }
  return value
}

/** If `endpoint` ends with `/mcp` (or `/mcp/`), strip it — gbrain's adapter
 *  appends `/mcp` itself and probes `${endpoint}/health`. */
function stripMcpSuffix(endpoint: string): string {
  return endpoint.replace(/\/mcp\/?$/, "")
}

/**
 * Map a `gbrain-doc` entry onto the pre-schema config object
 * (`parseGbrainDocAdapterConfig`-shaped). Pure — exported for tests.
 */
export function gbrainDocOptionsFromEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const endpoint = stripMcpSuffix(
    typeof entry.endpoint === "string"
      ? entry.endpoint
      : typeof entry.url === "string"
        ? entry.url
        : "",
  )
  const opts: Record<string, unknown> = {
    endpoint,
    bearerToken: resolveSecret(entry.bearer),
  }
  if (entry.timeoutMs !== undefined) opts.timeoutMs = entry.timeoutMs
  if (entry.label !== undefined) opts.label = entry.label
  return opts
}

/**
 * Map a `qdrant` entry onto the pre-schema config object
 * (`parseQdrantAdapterConfig`-shaped). Pure — exported for tests.
 */
export function qdrantOptionsFromEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    endpoint:
      typeof entry.url === "string"
        ? entry.url
        : typeof entry.endpoint === "string"
          ? entry.endpoint
          : "",
    collection: entry.collection,
    embeddingApiKey: resolveSecret(entry.embeddingApiKey),
  }
  if (entry.apiKey !== undefined) opts.apiKey = entry.apiKey
  if (entry.embeddingModel !== undefined) opts.embeddingModel = entry.embeddingModel
  if (entry.embeddingEndpoint !== undefined) opts.embeddingEndpoint = entry.embeddingEndpoint
  if (entry.label !== undefined) opts.label = entry.label
  if (entry.tenantId !== undefined) opts.tenantId = entry.tenantId
  return opts
}

/** Resolve ONE provider entry to a live provider, throwing on misconfig. */
export function resolveKnowledgeProvider(
  entry: KnowledgeProviderConfig,
  ctx: ProviderResolutionContext,
): ResolvedProvider {
  const auto = entry.auto ?? true
  const weight = entry.weight ?? 1
  const id = entry.id

  switch (entry.adapter) {
    case "files": {
      const workspacePath =
        typeof entry.workspacePath === "string"
          ? entry.workspacePath
          : "knowledge"
      const provider = new FilesKnowledgeAdapter({
        fs: new LocalFs({ root: ctx.brainDir }),
        workspacePath,
      })
      return { id, weight, auto, provider }
    }

    case "gbrain-doc": {
      const endpoint =
        typeof entry.endpoint === "string"
          ? entry.endpoint
          : typeof entry.url === "string"
            ? entry.url
            : ""
      if (!endpoint) {
        throw new Error(
          `provider "${id}" (gbrain-doc): missing "endpoint" (or "url") in knowledge.json`,
        )
      }
      const raw = gbrainDocOptionsFromEntry(entry as Record<string, unknown>)
      const cfg = parseGbrainDocAdapterConfig(raw)
      return { id, weight, auto, provider: new GbrainDocKnowledgeAdapter(cfg) }
    }

    case "qdrant": {
      if (typeof entry.collection !== "string" || entry.collection.length === 0) {
        throw new Error(
          `provider "${id}" (qdrant): missing "collection" in knowledge.json`,
        )
      }
      const raw = qdrantOptionsFromEntry(entry as Record<string, unknown>)
      const cfg = parseQdrantAdapterConfig(raw)
      return { id, weight, auto, provider: new QdrantKnowledgeAdapter(cfg) }
    }

    case "corpus":
      // Reserved id — the AIP-10 composition adapter hasn't landed yet.
      throw new Error('adapter "corpus" is not implemented yet')

    default:
      throw new Error(
        `unknown knowledge adapter "${String(entry.adapter)}" — supported: ${KNOWLEDGE_PROVIDER_ADAPTERS.join(", ")}`,
      )
  }
}

/** Resolve a whole config to resolved providers. Empty when the config is
 *  absent or has no providers; duplicate provider `id`s throw. */
export function resolveKnowledgeProviders(
  config: KnowledgeConfig | undefined,
  ctx: ProviderResolutionContext,
): ResolvedProvider[] {
  if (!config || config.providers.length === 0) return []
  const seen = new Set<string>()
  for (const p of config.providers) {
    if (seen.has(p.id)) {
      throw new Error(
        `duplicate knowledge provider id "${p.id}" in knowledge.json — each provider needs a unique "id"`,
      )
    }
    seen.add(p.id)
  }
  return config.providers.map(p => resolveKnowledgeProvider(p, ctx))
}

/**
 * Zod mirror of {@link KnowledgeConfig}. `.passthrough()` on the provider
 * objects is load-bearing: adapter-specific options (endpoint, bearer, url,
 * collection, …) ride along as unknown keys and the resolver reads them flat.
 */
export const knowledgeConfigSchema: z.ZodType<KnowledgeConfig> = z.object({
  providers: z.array(
    z
      .object({
        id: z.string(),
        adapter: z.enum(ADAPTER_IDS),
        auto: z.boolean().optional(),
        weight: z.number().optional(),
      })
      .passthrough(),
  ),
  defaultQueryProviders: z.array(z.string()).optional(),
})

/** Parse an unknown JSON blob (from `knowledge.json`) into a
 *  {@link KnowledgeConfig}, throwing a zod error on any schema mismatch. */
export const parseKnowledgeConfig = (raw: unknown): KnowledgeConfig =>
  knowledgeConfigSchema.parse(raw)
