/**
 * Pure naming helpers for `scripts/catalog-sync/run-all.mjs`.
 *
 * Extracted so the per-modality output convention can be tested without
 * spawning every vendor sync script:
 *   - `sync-<vendor>.mjs`             → `src/<modality>/<vendor>-pricing.generated.ts`
 *   - catalog changelog subsection    → `### <modality>:<vendor>`
 *
 * LLM scripts (the historical default) keep their existing output path and
 * changelog heading - only scripts listed in {@link SCRIPT_MODALITIES} move.
 */

/** Script file name → modality. Anything not listed is an LLM script. */
export const SCRIPT_MODALITIES = {
  "sync-replicate.mjs": "image",
}

export function modalityOf(script) {
  return SCRIPT_MODALITIES[script] ?? "llm"
}

/** `sync-openai.mjs` → `openai`. */
export function vendorOf(script) {
  return script.slice("sync-".length, -".mjs".length)
}

/** Absolute output path for a script's generated pricing file. */
export function outputPathOf(script, modelCatalogSrcDir) {
  return `${modelCatalogSrcDir}/${modalityOf(script)}/${vendorOf(script)}-pricing.generated.ts`
}

/** Changelog subsection heading (`### llm:openai`, `### image:replicate`). */
export function changelogHeading(modality, vendor) {
  return `### ${modality}:${vendor}`
}
