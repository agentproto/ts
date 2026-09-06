/**
 * Native Google/Gemini model ids the catalog-sync pipeline is allowed to
 * emit via the OpenRouter remap (Google's native API is billing-blocked —
 * see `llm-context-windows.ts`), verified against `adapters/gemini/src/index.ts`
 * (`models.allowed`) and the hand-maintained Google rows in
 * `model-catalog/src/llm/catalog.ts` — the two places that would break if a
 * wrong id slipped in. Do not add to this list from OpenRouter data alone;
 * a new entry needs the same cross-check.
 *
 * Plain `.mjs` (no TypeScript syntax) so both `llm-context-windows.ts` (the
 * context-window generator, imported as compiled JS via the `.js` extension
 * per NodeNext resolution) and `scripts/catalog-sync/sync-google.mjs` (a
 * bare `node` script, no TS toolchain) can import the SAME list — a
 * duplicated copy in the `.mjs` script would silently drift from this one.
 */
export const GOOGLE_NATIVE_MODEL_IDS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
])
