/**
 * Pure naming helpers for `scripts/catalog-sync/run-all.mjs`.
 *
 * Extracted so the per-modality output convention can be tested without
 * spawning every vendor sync script:
 *   - `sync-<vendor>.mjs`             → `src/<modality>/<vendor>-pricing.generated.ts`
 *     (one file per modality the script writes)
 *   - catalog changelog subsection    → `### <modality>:<vendor>`
 *
 * LLM scripts (the historical default) keep their existing output path and
 * changelog heading - only scripts listed in {@link SCRIPT_MODALITIES} move.
 */

/** Script file name → modalities it writes. Anything not listed is an LLM script. */
export const SCRIPT_MODALITIES = {
  "sync-replicate.mjs": ["image", "video"],
}

export function modalitiesOf(script) {
  return SCRIPT_MODALITIES[script] ?? ["llm"]
}

/** `sync-openai.mjs` → `openai`. */
export function vendorOf(script) {
  return script.slice("sync-".length, -".mjs".length)
}

/** Every generated pricing file a script writes, one per modality. */
export function outputsOf(script, modelCatalogSrcDir) {
  return modalitiesOf(script).map(modality => ({
    modality,
    path: `${modelCatalogSrcDir}/${modality}/${vendorOf(script)}-pricing.generated.ts`,
  }))
}

/** Sorted ids added to / removed from `before` → `after`. */
export function diffIds(before, after) {
  return {
    added: [...after].filter(id => !before.has(id)).sort(),
    removed: [...before].filter(id => !after.has(id)).sort(),
  }
}

/** Changelog subsection heading (`### llm:openai`, `### image:replicate`). */
export function changelogHeading(modality, vendor) {
  return `### ${modality}:${vendor}`
}
