/**
 * Pure logic for the "+" model picker (WS4 phase 2) — no `vscode` import so it
 * unit-tests under plain vitest. The vscode shell (`authProfiles.ts`) fetches
 * the provider's full model list via `daemonClient.getCatalogProviderModels`
 * (the WS4 read tool), hands it here to build the multi-select QuickPick items,
 * and maps the picker/chip result back to a `daemonClient.setAuthProfileModels`
 * (WS3) call. Nothing here is hardcoded — every id/label/route/price comes from
 * the catalog rows the read tool returned.
 *
 * The ids written to the allowlist are EXACTLY the read tool's `id` field
 * (catalog `vendor/product` or route-qualified refs) — the picker never
 * synthesizes or reshapes an id, so a written allowlist round-trips against the
 * same catalog the read tool enumerated.
 */

import { serviceableModelRoutes } from "@agentproto/runtime/catalog-models"

import type { CatalogProviderModel } from "../client/types.js"

/** One selectable model row, mapped from a read-tool catalog entry. The vscode
 *  shell spreads this onto a `vscode.QuickPickItem` (+ the carried `id`). */
export interface ModelPickItem {
  /** The catalog ref written to the allowlist — exactly the read tool's id. */
  id: string
  label: string
  description?: string
  detail?: string
  /** Pre-checked when the profile already allows this id (allow mode). */
  picked: boolean
}

/** The `(mode, ids)` pair to feed `setAuthProfileModels`. */
export interface ModelCurationWrite {
  mode: "all" | "allow"
  ids: string[]
}

/** Human price tag for a model row, or "" when the catalog carries none (the
 *  media kinds price per-image/second, so the read tool returns null there). */
export function modelPriceLabel(m: CatalogProviderModel): string {
  if (!m.pricing) return ""
  return `$${m.pricing.inPer1M}/$${m.pricing.outPer1M} per 1M`
}

/**
 * Build the multi-select QuickPick items from the read tool's provider models,
 * pre-checking the ids the profile already allows. Currently-allowed rows sort
 * to the top (so an existing allowlist is visible at the head of a
 * thousands-long provider list), then alphabetically by id — the QuickPick's
 * own type-to-filter (matchOnDescription/Detail) handles the rest, so nothing
 * is dumped raw. `label` is the catalog display name where one exists
 * (image/video/audio `name`, voice `label`); for an LLM whose label equals its
 * id, the id also lands in `description` so it stays searchable.
 */
export function buildModelPickItems(
  models: readonly CatalogProviderModel[],
  currentAllowIds: readonly string[],
): ModelPickItem[] {
  const allow = new Set(currentAllowIds)
  return [...models]
    .map(m => {
      const price = modelPriceLabel(m)
      // Flag LLM ids the static catalog knows NO billing route for (phantom
      // dot-form ids, typos) — adding one still resolves to nothing runnable, so
      // the chip would silently show red. This is the loose "no route at all"
      // warning (`serviceableModelRoutes` is pure/synchronous, no daemon
      // round-trip); it does not compute adapter-aware runnability. Scoped to
      // `kind === "llm"`: `serviceableModelRoutes` only knows the LLM route
      // catalog, so it returns `[]` for the media kinds (image/video/audio/voice)
      // even though those ARE runnable on their own `route` — flagging them would
      // be a false positive. It's a VISIBLE warning only — selection/toggle stay
      // enabled so the user can still curate the id.
      const unroutable = m.kind === "llm" && serviceableModelRoutes(m.id).length === 0
      const detailParts = [
        m.route ?? "",
        price,
        unroutable ? "⚠ no billing route — cannot run" : "",
      ].filter(Boolean)
      const hasDistinctLabel = Boolean(m.label) && m.label !== m.id
      return {
        id: m.id,
        label: m.label || m.id,
        ...(hasDistinctLabel ? { description: m.id } : {}),
        ...(detailParts.length ? { detail: detailParts.join(" · ") } : {}),
        picked: allow.has(m.id),
      }
    })
    .sort((a, b) => {
      if (a.picked !== b.picked) return a.picked ? -1 : 1
      return a.id.localeCompare(b.id)
    })
}

/**
 * Map a multi-select picker result to a `setAuthProfileModels` call. A
 * non-empty selection narrows the profile to exactly those ids (`allow`); an
 * empty selection clears the allowlist back to servicing everything (`all`).
 * Deselecting every row means "stop restricting", never "restrict to nothing"
 * (an empty `allow` services nothing) — a dedicated "allow nothing" is a
 * footgun this picker deliberately can't produce.
 */
export function resolveModelSelection(selectedIds: readonly string[]): ModelCurationWrite {
  const ids = [...new Set(selectedIds)].sort((a, b) => a.localeCompare(b))
  return ids.length > 0 ? { mode: "allow", ids } : { mode: "all", ids: [] }
}

/**
 * Toggle a single id in the profile's current allowlist — the chip add/remove
 * affordance. Removing the last curated id reverts to `all` (services
 * everything), same rule as {@link resolveModelSelection}: an emptied allowlist
 * is "no longer restricting", not "restrict to nothing".
 */
export function toggleModelInAllowlist(
  currentAllowIds: readonly string[],
  id: string,
): ModelCurationWrite {
  const set = new Set(currentAllowIds)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  const ids = [...set].sort((a, b) => a.localeCompare(b))
  return ids.length > 0 ? { mode: "allow", ids } : { mode: "all", ids: [] }
}
