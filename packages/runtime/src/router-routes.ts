/**
 * The router routes the catalog widens over, and the router-prefixed id
 * normalization that goes with them. Kept in their own small module so the
 * session pricing path (`usage.ts`) can share them without importing
 * `catalog-models.ts`; internal to the package (not a published subpath).
 */

/** Routers the catalog probes to widen beyond any adapter's declared model
 *  list (SPEC §5.1) — the same routes route-identity resolves from generated
 *  tables (`route-identity/index.ts`'s imports). Exported so `model-wire.ts`
 *  can reuse the SAME set when deciding whether a wire model needs a literal
 *  router-prefix (never a second hand-maintained list).
 *
 *  `opencode-go` / `opencode` (OpenCode Go and Zen) widen just like the other
 *  three, but their tables are keyed `<provider>/<bare-id>` rather than
 *  `<vendor>/<product>`, so a probe of `${vendor}/${product}@opencode-go` can
 *  only ever hit when the vendor segment IS `opencode-go` — no other model can
 *  pick up a spurious OpenCode route. What this buys: `serviceableModelRoutes`
 *  answers `["opencode-go"]` for `opencode-go/glm-5.3` instead of `[]`, so the
 *  Configuration Lab / VS Code pickers resolve its route (and don't flag it
 *  unroutable), and `normalizeModelForWire` keeps the provider as the literal
 *  leading wire segment opencode itself requires. */
export const WIDENING_ROUTES = [
  "openrouter",
  "requesty",
  "huggingface",
  "opencode-go",
  "opencode",
] as const

/** Rewrite a router-prefixed id (`<router>/<vendor>/<product>`) into the
 *  canonical route-identity `<vendor>/<product>@<router>` the parser accepts.
 *
 *  Mastra-style adapters (e.g. `adapters/mastra-agent`) declare their model
 *  ids in `<provider>/<upstream-id>` form, and for a gateway router the
 *  upstream id is itself `<vendor>/<product>` — so a native OpenRouter id like
 *  `z-ai/glm-5.2` is advertised as the 3-segment `openrouter/z-ai/glm-5.2`.
 *  `parseModelRef` splits on the FIRST `/` and rejects a product that still
 *  contains one (`route-identity/index.ts` SEGMENT_RE), so feeding it the raw
 *  3-segment string throws and, before this normalization, 500'd the whole
 *  catalog. The route-identity grammar's canonical form for such a model is
 *  `<vendor>/<product>@<router>` (`z-ai/glm-5.2@openrouter`) — the `@route`
 *  suffix, NOT a leading route segment — so we recompose to that. Only the
 *  known gateway routers (whose native ids are `<vendor>/<product>`) are
 *  peeled; every other id is returned untouched. A `:pin` variant/provider
 *  suffix on the upstream id is preserved (it rides along in the remainder).
 */
export function normalizeRouterPrefixedId(id: string): string {
  const firstSlash = id.indexOf("/")
  if (firstSlash === -1) return id
  const head = id.slice(0, firstSlash)
  if (!(WIDENING_ROUTES as readonly string[]).includes(head)) return id
  const remainder = id.slice(firstSlash + 1)
  // Only a genuine `<vendor>/<product>` upstream id (still carrying a `/`) is
  // the router-prefixed shape; a 2-segment `<router>/<product>` is left alone.
  if (!remainder.includes("/") || remainder.includes("@")) return id
  return `${remainder}@${head}`
}
