/**
 * Pure logic for the "click the model chip" mid-session switch picker. No
 * `vscode` import so this is directly unit-testable — changeModel.ts (the
 * interactive flow) calls into it, the same split spawn.logic.ts uses.
 *
 * Deliberately does NOT call `mapSpawnQuickPickItems` — that picker's
 * trailing custom-model rows and `Configure…` row (cwd/label/prompt chain)
 * describe a NEW spawn, not "same session, different model," so this module
 * groups `modelEntriesOf`'s entries itself rather than filtering an
 * unrelated picker's combined output. `modelEntriesOf` (the one genuinely
 * shared piece — normalising `modelDetails` vs a bare `models` list) is
 * reused as-is.
 */

import { resolveEffectiveRoute } from "@agentproto/runtime/catalog-models"

import type { SessionConfigOptionRow, SessionDescriptor } from "../client/types.js"
import { modelEntriesOf, type SpawnAdapterInfo } from "./spawn.logic.js"

/** Mirrors `vscode.QuickPickItemKind.Separator` (`-1`) without importing
 *  `vscode` — see spawn.logic.ts's own copy of this constant for why. */
const SEPARATOR_KIND = -1

export interface ChangeModelQuickPickItem {
  label: string
  description?: string
  /** Set only on a group-heading row; the row can't be picked. */
  kind?: number
  /** Absent on a heading row. */
  model?: string
  /** The model's bound adapter mode (AIP-45 `models.allowed[].mode`), when
   *  the entry states one. */
  mode?: string
  /** True on the row matching the session's currently active model. */
  current?: boolean
  /**
   * True when picking this row opens the route chip picker instead of
   * switching model. Set only on the synthetic "Change route" top-row.
   */
  openRouteChip?: boolean
  /**
   * True when picking this row is known to be impossible without
   * restarting the session: the adapter's own `modelApply` is `"arg"`
   * (baked into spawn-time argv, so EVERY row is restart-required
   * regardless of target), or the row is bound to a `mode` different from
   * the one this session actually spawned with (a mode change is
   * spawn-time env/argv rewiring — e.g. `ANTHROPIC_BASE_URL` — which
   * `POST /sessions/:id/model` cannot perform on a live process).
   */
  restartRequired?: boolean
}

function routeDescription(
  restartRequired: boolean,
  current: boolean,
  route: string | undefined,
  notAcceptedLive?: boolean,
): string | undefined {
  const parts: string[] = []
  if (restartRequired) parts.push("restart required")
  else if (current) parts.push("current")
  if (notAcceptedLive) parts.push("not accepted live")
  if (route) parts.push(`via ${route}`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// ── The live agent's OWN model vocabulary ───────────────────────────────────

/**
 * One value the LIVE session's model config option accepts.
 *
 * `value` is the wire value to send -- the agent validates against it and
 * rejects anything else ("Invalid value for config option model: <id>"), so
 * it is NOT necessarily a catalog model id.
 */
export interface LiveModelValue {
  value: string
  name?: string
  description?: string
  /** The group the value sits under, when the harness groups its options. */
  group?: string
}

/**
 * The model values the LIVE session's harness advertises for its model config
 * option (the ACP `session/new` response's `configOptions`, echoed onto the
 * descriptor by the daemon at read time).
 *
 * Empty when the session advertises no model option at all (a print arm, a
 * dead session, an older daemon) -- the caller then keeps the catalog-only
 * behaviour, which is right for a harness that never had its own vocabulary.
 */
export function liveModelValues(
  configOptions: readonly SessionConfigOptionRow[] | undefined,
): LiveModelValue[] {
  if (!configOptions || configOptions.length === 0) return []
  const option =
    configOptions.find(o => o.id.toLowerCase() === "model") ??
    configOptions.find(o => o.category?.toLowerCase() === "model")
  if (!option || !option.options || option.options.length === 0) return []

  const values: LiveModelValue[] = []
  for (const entry of option.options) {
    // A grouped option list: `{ group, name, options: [...] }`.
    if (!("value" in entry) && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        values.push({
          value: nested.value,
          ...(nested.name ? { name: nested.name } : {}),
          ...(nested.description ? { description: nested.description } : {}),
          ...(entry.name ? { group: entry.name } : {}),
        })
      }
      continue
    }
    if (!("value" in entry)) continue
    values.push({
      value: entry.value,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    })
  }
  return values
}

/**
 * Build the mid-session model-switch quick-pick for ONE session's own
 * adapter, grouped under a provider heading exactly like the spawn
 * wizard's collapsed picker (`mapSpawnQuickPickItems`) — "which brain" is
 * the row, "who serves it" is the heading. A model with no stated provider
 * groups under the adapter's own name (an unstated provider is never
 * guessed). Group order follows first appearance in `modelEntriesOf`'s
 * order (which itself mirrors the manifest's declared order).
 *
 * When the LIVE session advertises its own model vocabulary
 * (`session.configOptions`), that vocabulary wins for the LIVE switch: a
 * catalog id the agent does not accept is flagged restart-only (it would be
 * rejected outright by a live switch), and the agent's own values -- the ones
 * it accepts -- are offered as extra rows.
 */
export function mapChangeModelQuickPickItems(
  adapter: SpawnAdapterInfo,
  session: Pick<SessionDescriptor, "model" | "activeModel" | "mode" | "route"> & {
    configOptions?: readonly SessionConfigOptionRow[]
  },
): ChangeModelQuickPickItem[] {
  const groups = new Map<string, { heading: string; rows: ChangeModelQuickPickItem[] }>()
  const live = liveModelValues(session.configOptions)
  const liveIds = new Set(live.map(v => v.value))

  for (const entry of modelEntriesOf(adapter)) {
    const key = entry.provider ?? `adapter:${adapter.slug}`
    const heading = entry.provider ?? adapter.slug
    let group = groups.get(key)
    if (!group) {
      group = { heading, rows: [] }
      groups.set(key, group)
    }

    const current = entry.id === session.model
    // A restart-required current row can happen (an "arg" adapter's
    // running model is itself only reachable via spawn-time argv) — still
    // worth flagging honestly rather than special-casing it away.
    const modeMismatch = entry.mode !== undefined && entry.mode !== session.mode
    const rowRoute = resolveEffectiveRoute(entry.id, undefined)
    const sessionRoute = resolveEffectiveRoute(session.model, session.route?.gateway)
    const routeMismatch = rowRoute !== undefined && rowRoute !== sessionRoute
    // The live agent validates the model value it is given: a catalog id
    // outside its advertised vocabulary is REJECTED ("Invalid value for
    // config option model"), so such a row can only be reached through a
    // restart, never a live switch.
    const notAcceptedLive = liveIds.size > 0 && !liveIds.has(entry.id)
    const restartRequired =
      adapter.modelApply === "arg" || modeMismatch || routeMismatch || notAcceptedLive
    const description = routeDescription(restartRequired, current, rowRoute, notAcceptedLive)

    group.rows.push({
      label: entry.id,
      ...(description ? { description } : {}),
      model: entry.id,
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(current ? { current: true } : {}),
      ...(restartRequired ? { restartRequired: true } : {}),
    })
  }

  const items: ChangeModelQuickPickItem[] = []
  for (const group of groups.values()) {
    items.push({ label: group.heading, kind: SEPARATOR_KIND })
    items.push(...group.rows)
  }

  // The agent's OWN values, when they are not already a catalog row: these
  // are the ids a live switch can actually apply.
  const catalogIds = new Set(
    items.filter(i => i.model !== undefined).map(i => i.model as string),
  )
  const extra = live.filter(v => !catalogIds.has(v.value))
  if (extra.length > 0) {
    items.push({ label: LIVE_MODELS_HEADING, kind: SEPARATOR_KIND })
    for (const value of extra) {
      const current = value.value === session.model || value.value === session.activeModel
      const description = value.name ?? value.description
      items.push({
        label: value.value,
        ...(description ? { description } : {}),
        model: value.value,
        ...(current ? { current: true } : {}),
      })
    }
  }
  return items
}

/** Heading of the group carrying the live agent's own model values. */
export const LIVE_MODELS_HEADING = "accepted by this agent"

/** Label for the synthetic top-row that hands off to the route chip picker. */
export const CHANGE_ROUTE_LABEL = "$(arrow-swap) Change route…"

/** Synthetic row that opens the route chip picker instead of picking a model. */
export function makeChangeRouteItem(): ChangeModelQuickPickItem {
  return {
    label: CHANGE_ROUTE_LABEL,
    description: "pick which gateway bills the current model",
    openRouteChip: true,
  }
}

/** placeHolder for the change-model picker — names the session's current
 *  model up front, same "show the default before the user commits to
 *  changing it" reasoning as `buildSpawnPlaceHolder`. */
export function buildChangeModelPlaceHolder(
  session: Pick<SessionDescriptor, "model" | "adapterSlug">,
): string {
  const current = session.model ? `currently ${session.model}` : "no model recorded"
  return `Switch model for ${session.adapterSlug ?? "this session"} (${current})`
}
