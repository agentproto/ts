/**
 * `agentproto app install <dir>` with no daemon up. Runs the daemon's own
 * `performInstall` against a registry persisted at the same `apps.json`, so
 * the record written is the full one `app_install {dir}` writes — never a
 * bare `{appId, dir, dataDir}` that a later daemon would choke on.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { createAppRegistry, type InstalledApp } from "./app-registry.js"
import { performInstall } from "./app-tools.js"

export const defaultAppsJsonPath = (): string => join(homedir(), ".agentproto", "apps.json")

export async function installAppDirOffline(
  dir: string,
  opts?: { dataDir?: string; persistPath?: string },
): Promise<{ ok: true; record: InstalledApp } | { ok: false; error: string }> {
  const registry = createAppRegistry({ persist: true, persistPath: opts?.persistPath ?? defaultAppsJsonPath() })
  return performInstall(dir, registry, async () => [], undefined, {
    skipDaemonChecks: true,
    ...(opts?.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
  })
}
