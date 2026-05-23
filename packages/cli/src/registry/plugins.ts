/**
 * Plugin loader. For each plugin id:
 *
 *   1. Try manifest-based wiring — read the plugin's
 *      `package.json#agentproto` (or standalone `agentproto.json`),
 *      validate the `agentproto/plugin/v1` schema, dynamic-import
 *      each declared adapter entry, register with the runtime
 *      registry.
 *   2. Fall back to side-effect import — older plugins that just
 *      `registerSubstrate(...)` at module load are still supported.
 *
 * Discovery sources for plugin ids:
 *   - `--plugin <module-id>` flag(s) on the verb
 *   - `plugins[]` array in `~/.agentproto/config.json`
 *
 * Failures: a plugin that throws on load is reported on stderr and
 * the load skips it. The CLI continues — a single bad plugin
 * shouldn't take down the swarm.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadPluginFromManifest } from "./manifest-loader.js"

interface AgentprotoConfig {
  plugins?: readonly string[]
}

export async function loadPluginsFromConfig(): Promise<readonly string[]> {
  const path = configPath()
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as AgentprotoConfig
    return parsed.plugins ?? []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    process.stderr.write(
      `agentproto: failed to read ${path} — ${err instanceof Error ? err.message : String(err)}\n`
    )
    return []
  }
}

export async function loadPlugins(moduleIds: readonly string[]): Promise<void> {
  for (const id of moduleIds) {
    try {
      const manifest = await loadPluginFromManifest(id)
      if (manifest === null) {
        // No manifest declared → side-effect import for legacy plugins.
        await import(id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `agentproto: plugin '${id}' failed to load — ${msg}\n`
      )
    }
  }
}

function configPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "config.json")
}
