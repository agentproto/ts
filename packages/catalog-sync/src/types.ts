/**
 * catalog-sync generator contract.
 *
 * FROZEN — a sibling agent builds provider generators against this surface.
 * Do not change field names, shapes, or the `defineGenerator` signature
 * without coordinating. Adding new generators is the expected extension
 * path; editing this file is not.
 */

export interface CatalogSource {
  id: string
  url: string
  /** HTTP method for the live (`--refresh`) fetch. Default `"GET"`. */
  method?: "GET" | "POST"
  /**
   * Request headers for the live fetch. A value may embed `env:VAR_NAME`
   * tokens, resolved from `process.env` at fetch time (e.g.
   * `{ "xi-api-key": "env:ELEVENLABS_API_KEY" }` or
   * `{ Authorization: "Bearer env:MINIMAX_API_KEY" }`). If any referenced env
   * var is unset, the source is treated as un-refreshable — the committed
   * snapshot is reused rather than fetched without auth. Offline reads
   * (default, no `--refresh`) ignore headers entirely.
   */
  headers?: Record<string, string>
  /** JSON request body for POST sources (e.g. MiniMax `get_voice`). */
  body?: unknown
}

export interface GeneratorContext {
  /**
   * Reads the pinned snapshot at `snapshots/<src.id>.json`; if missing and
   * `refresh=true`, fetches `src.url` and writes the snapshot. Returns
   * parsed JSON.
   *
   * Offline by default: when no snapshot exists and `refresh` is false this
   * throws — generators MUST be runnable without network access so CI and
   * tests are deterministic. The only network path is behind `--refresh`.
   */
  fetchSource(src: CatalogSource): Promise<unknown>
  refresh: boolean
}

/** Repo-relative path → TS source text. */
export type GeneratedFiles = Record<string, string>

export interface CatalogGenerator {
  /** e.g. "llm:openrouter" */
  name: string
  modality: "llm" | "image" | "video" | "audio" | "voice"
  sources: CatalogSource[]
  generate(ctx: GeneratorContext): Promise<GeneratedFiles>
}

/** Identity helper — lets a generator module declare itself with type inference. */
export function defineGenerator(g: CatalogGenerator): CatalogGenerator {
  return g
}
