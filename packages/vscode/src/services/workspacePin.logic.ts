/**
 * Pure logic for the per-window "target workspace" pin — NO vscode import,
 * no I/O. The pin itself is just a registered workspace slug (or undefined
 * = "Auto, use the open folder"), persisted client-side per VS Code window;
 * see services/workspacePin.ts for the workspaceState-backed shell.
 *
 * Exists because the daemon has exactly one GLOBAL `active` workspace
 * (mutated from CLI/HTTP call sites well outside any given VS Code window —
 * see the workspace-cwd audit), which is the wrong scope for "which project
 * should THIS window's un-cwd'd spawns land in." This pin answers that
 * question locally instead of ever touching the daemon's global field.
 */

import type { WorkspacesConfig } from "../client/types.js"

/** undefined = "Auto (use open folder)"; otherwise a registered workspace slug. */
export type WorkspacePin = string | undefined

export const WORKSPACE_PIN_AUTO_LABEL = "Auto (use open folder)"

export interface WorkspacePinQuickPickItem {
  label: string
  description?: string
  /** Absent on the "Auto" row. */
  slug?: string
}

/** Quick-pick options: "Auto" first, then every registered workspace. */
export function mapWorkspacePinQuickPickItems(config: WorkspacesConfig): WorkspacePinQuickPickItem[] {
  return [
    { label: `$(circle-slash) ${WORKSPACE_PIN_AUTO_LABEL}` },
    ...config.workspaces.map(w => ({
      label: w.label ?? w.slug,
      description: w.path,
      slug: w.slug,
    })),
  ]
}

/** Status-bar text for the current pin. */
export function buildPinStatusText(config: WorkspacesConfig, pin: WorkspacePin): string {
  if (!pin) return "$(root-folder) Auto"
  const entry = config.workspaces.find(w => w.slug === pin)
  return `$(root-folder) ${entry?.label ?? pin}`
}

/**
 * The pin's cwd/workspaceSlug, when the pinned slug still resolves to a
 * registered workspace. Returns undefined for an unset pin AND for a pin
 * whose workspace was since removed — both cases fall back to today's
 * folder-derivation ladder rather than stamping a stale/nonexistent slug.
 */
export function resolvePinnedTarget(
  config: WorkspacesConfig,
  pin: WorkspacePin,
): { cwd: string; workspaceSlug: string } | undefined {
  if (!pin) return undefined
  const entry = config.workspaces.find(w => w.slug === pin)
  if (!entry) return undefined
  return { cwd: entry.path, workspaceSlug: entry.slug }
}
