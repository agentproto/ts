/**
 * Native Google/Gemini model ids the catalog-sync pipeline is allowed to
 * emit via the OpenRouter remap (Google's native API is billing-blocked —
 * see `llm-context-windows.ts`). A new entry needs a cross-check, and OpenRouter
 * data alone is not one: confirm the id on Google's own model list
 * (aistudio.google.com/docs/models) and that the `google/<id>` route exists in
 * the OpenRouter snapshot. The `google/...` routes resolve through
 * `OPENROUTER_ROUTES` in `model-catalog/src/llm/catalog.ts`, so no alias row is
 * needed. (The older recipe also named `adapters/gemini/src/index.ts`
 * `models.allowed`; that adapter is deprecated and antigravity, which
 * supersedes it, declares no allow-list. If a Gemini CLI adapter list is ever
 * reinstated, keep it in step with this one.)
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
  // Added 2026-11-20, cross-checked against Google's model list
  // (aistudio.google.com/docs/models) and the OpenRouter `google/` routes.
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
  "gemini-4-neon",
])
