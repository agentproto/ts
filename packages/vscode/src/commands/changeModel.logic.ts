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

import type { SessionDescriptor } from "../client/types.js"
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

/**
 * Build the mid-session model-switch quick-pick for ONE session's own
 * adapter, grouped under a provider heading exactly like the spawn
 * wizard's collapsed picker (`mapSpawnQuickPickItems`) — "which brain" is
 * the row, "who serves it" is the heading. A model with no stated provider
 * groups under the adapter's own name (an unstated provider is never
 * guessed). Group order follows first appearance in `modelEntriesOf`'s
 * order (which itself mirrors the manifest's declared order).
 */
export function mapChangeModelQuickPickItems(
  adapter: SpawnAdapterInfo,
  session: Pick<SessionDescriptor, "model" | "mode">,
): ChangeModelQuickPickItem[] {
  const groups = new Map<string, { heading: string; rows: ChangeModelQuickPickItem[] }>()

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
    const restartRequired =
      adapter.modelApply === "arg" || (entry.mode !== undefined && entry.mode !== session.mode)

    group.rows.push({
      label: entry.id,
      ...(restartRequired
        ? { description: "restart required" }
        : current
          ? { description: "current" }
          : {}),
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
  return items
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
