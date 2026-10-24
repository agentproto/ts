/**
 * Per-call resolver for the `config.json` task-ledger knobs:
 * `defaults.tasks.operatorDelegates`.
 *
 * Same read-per-`/mcp`-request discipline as `resolveMessagingDefaults`: the
 * gateway rebuilds its `McpServer` from scratch on every request (the SDK's
 * stateless pattern), so resolving inside the server factory means a
 * `config_set` change takes effect on the very next task_* call without a
 * daemon restart. No caching: `loadConfig` is a small file read.
 */

import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export interface ResolvedTaskDefaults {
  /** `defaults.tasks.operatorDelegates` — sessions that keep the ledger's
   *  operator rights while being attributed under their own id. Default [].
   *  Entries follow `allowPromptFrom`'s matching rules (exact id,
   *  `label:<operatorLabel>`, `label:<prefix>*`). */
  operatorDelegates: string[]
}

export const DEFAULT_TASK_DEFAULTS: ResolvedTaskDefaults = {
  operatorDelegates: [],
}

export async function resolveTaskDefaults(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<ResolvedTaskDefaults> {
  try {
    const d = (await loadCfg()).defaults
    return {
      operatorDelegates:
        d?.tasks?.operatorDelegates ?? DEFAULT_TASK_DEFAULTS.operatorDelegates,
    }
  } catch {
    return DEFAULT_TASK_DEFAULTS
  }
}
