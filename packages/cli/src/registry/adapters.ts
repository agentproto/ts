/**
 * Adapter loader. For each adapter id:
 *
 *   1. Try manifest-based wiring — read the adapter's
 *      `package.json#agentproto` (or standalone `agentproto.json`),
 *      validate the `agentproto/adapter/v1` schema, dynamic-import
 *      each declared adapter entry, register with the runtime
 *      registry.
 *   2. Fall back to side-effect import — older adapters that just
 *      `registerSubstrate(...)` at module load are still supported.
 *
 * Discovery sources for adapter ids:
 *   - `--adapter <module-id>` flag(s) on the verb
 *   - `adapters[]` array in `~/.agentproto/config.json`
 *
 * Failures: an adapter that throws on load is reported on stderr and
 * the load skips it. The CLI continues — a single bad adapter
 * shouldn't take down the swarm.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadAdapterFromManifest } from "./manifest-loader.js"

interface AgentprotoConfig {
  adapters?: readonly string[]
}

export async function loadAdaptersFromConfig(): Promise<readonly string[]> {
  const path = configPath()
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as AgentprotoConfig
    return parsed.adapters ?? []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    process.stderr.write(
      `agentproto: failed to read ${path} — ${err instanceof Error ? err.message : String(err)}\n`
    )
    return []
  }
}

export async function loadAdapters(moduleIds: readonly string[]): Promise<void> {
  for (const id of moduleIds) {
    try {
      const manifest = await loadAdapterFromManifest(id)
      if (manifest === null) {
        // No manifest declared → side-effect import for legacy adapters.
        await import(id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `agentproto: adapter '${id}' failed to load — ${msg}\n`
      )
    }
  }
}

function configPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "config.json")
}
