/**
 * Pure rendering/filtering logic for the Apps tree view — no vscode import
 * so it's unit-testable under plain vitest.
 */

import type { InstalledAppInfo } from "../client/types.js"

export interface AppNode {
  app: InstalledAppInfo
}

/** Only apps that ship a UI panel are openable — everything else in the
 *  registry (agent/workflow-only apps) is filtered out of the view. */
export function appsWithUi(apps: InstalledAppInfo[]): InstalledAppInfo[] {
  return apps.filter(app => app.ui !== undefined)
}

/** Row label: the UI's declared title, falling back to the app id. */
export function appLabel(app: InstalledAppInfo): string {
  return app.ui?.title?.trim() || app.appId
}

/** Row description: the UI's description, then the app's own. */
export function appDescription(app: InstalledAppInfo): string {
  return app.ui?.description?.trim() || app.description?.trim() || ""
}
