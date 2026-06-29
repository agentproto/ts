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
