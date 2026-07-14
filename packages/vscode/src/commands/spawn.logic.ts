/**
 * Pure spawn-wizard logic — quick-pick item mapping and spawn-options
 * assembly. No `vscode` import so this is directly unit-testable; the
 * interactive wizard in spawn.ts calls into these.
 */

import type { SpawnAgentOptions } from "../client/daemonClient.js"
import type { AdapterInfo } from "../client/types.js"

/**
 * adapter_list's actual daemon response (see
 * packages/cli/src/registry/resolve.ts `AdapterListing`) carries `models`,
 * `status`, and `hint` fields beyond the frozen client `AdapterInfo`
 * contract (client/types.ts). Extended locally rather than editing that
 * frozen file — every added field is optional, so a plain `AdapterInfo`
 * still satisfies this shape.
 */
export interface SpawnAdapterInfo extends AdapterInfo {
  models?: string[]
  status?: "supported" | "available" | "ready"
  hint?: string
}

export interface AdapterQuickPickItem {
  label: string
  description?: string
  adapter: SpawnAdapterInfo
}

export const CUSTOM_MODEL_LABEL = "$(edit) custom…"

export interface ModelQuickPickItem {
  label: string
  custom?: boolean
}

export interface ModeQuickPickItem {
  label: string
  description?: string
  mode: string
}

/** Adapter picker: label = slug, description = hint/status; "ready" adapters sort first. */
export function mapAdapterQuickPickItems(adapters: SpawnAdapterInfo[]): AdapterQuickPickItem[] {
  const items = adapters.map(adapter => ({
    label: adapter.slug,
    description: adapter.hint ?? adapter.status ?? adapter.name,
    adapter,
  }))
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aReady = a.item.adapter.status === "ready" ? 0 : 1
      const bReady = b.item.adapter.status === "ready" ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/** Model picker: every declared model plus a trailing "custom…" entry. */
export function mapModelQuickPickItems(models: string[]): ModelQuickPickItem[] {
  return [...models.map(m => ({ label: m })), { label: CUSTOM_MODEL_LABEL, custom: true }]
}

/** Mode picker: only meaningful when the adapter declares modes at all. */
export function mapModeQuickPickItems(modes: SpawnAdapterInfo["modes"]): ModeQuickPickItem[] {
  return (modes ?? []).map(m => ({
    label: m.id,
    description: m.status_note ?? m.status,
    mode: m.id,
  }))
}

export interface SpawnWizardAnswers {
  adapter: string
  model?: string
  mode?: string
  cwd?: string
  label?: string
  prompt?: string
}

/** Assemble the POST /sessions/agent body, omitting unset optional fields. */
export function assembleSpawnOptions(answers: SpawnWizardAnswers): SpawnAgentOptions {
  const opts: SpawnAgentOptions = { adapter: answers.adapter }
  if (answers.model) opts.model = answers.model
  if (answers.mode) opts.mode = answers.mode
  if (answers.cwd) opts.cwd = answers.cwd
  if (answers.label) opts.label = answers.label
  if (answers.prompt) opts.prompt = answers.prompt
  return opts
}
