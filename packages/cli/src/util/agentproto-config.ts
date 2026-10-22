/**
 * Shared read/write helpers for `~/.agentproto/config.json` (or
 * `$AGENTPROTO_HOME/config.json`).
 *
 * `agentproto adapters` and `agentproto install` both need to add an adapter
 * to the same `adapters[]` list, and `agentproto auth provider set` needs to
 * write `defaults.adapters.<slug>.auth`. Keeping the file shape and the
 * atomic write in one place prevents the two verbs from drifting (the bug
 * this module was extracted for: `install <slug>` reported success without
 * ever adding the adapter, so `adapters list` said "no adapters enabled").
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface AdapterDefaults {
  auth?: {
    mode?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface AgentprotoConfig {
  adapters?: string[]
  defaults?: {
    adapters?: Record<string, AdapterDefaults>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** `$AGENTPROTO_HOME/config.json`, falling back to `~/.agentproto`.
 *  Note: `AGENTPROTO_HOME` is honored by the CLI only; the runtime's
 *  `loadConfig` and `providers-store` read `homedir()` directly. */
export function configPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "config.json")
}

export async function loadAgentprotoConfig(): Promise<AgentprotoConfig> {
  try {
    const raw = await readFile(configPath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AgentprotoConfig
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

/** Atomic write (tmp + rename) so a concurrent `config edit` cannot observe
 *  a half-written file. The tmp name is fixed, so this protects readers, not
 *  two concurrent writers. */
export async function saveAgentprotoConfig(
  cfg: AgentprotoConfig,
): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function addAdapterToConfig(pkg: string): Promise<void> {
  const cfg = await loadAgentprotoConfig()
  const adapters = cfg.adapters ?? []
  if (!adapters.includes(pkg)) adapters.push(pkg)
  cfg.adapters = adapters
  await saveAgentprotoConfig(cfg)
}

export async function removeAdapterFromConfig(pkg: string): Promise<void> {
  const cfg = await loadAgentprotoConfig()
  cfg.adapters = (cfg.adapters ?? []).filter(p => p !== pkg)
  await saveAgentprotoConfig(cfg)
}

/**
 * Write `defaults.adapters.<slug>.auth.mode`, preserving any other keys the
 * operator already set on that block. With `onlyIfMissing`, an existing
 * `auth` block is left untouched — so an explicit subscription choice is
 * never silently flipped to api-key.
 *
 * Returns true when the file changed.
 */
export async function setAdapterAuthMode(
  slug: string,
  mode: string,
  opts: { onlyIfMissing?: boolean } = {},
): Promise<boolean> {
  const cfg = await loadAgentprotoConfig()
  const defaults = (cfg.defaults ??= {})
  const adapters = (defaults.adapters ??= {})
  const entry = (adapters[slug] ??= {})
  if (opts.onlyIfMissing && entry.auth !== undefined) return false
  if (entry.auth?.mode === mode) return false
  entry.auth = { ...(entry.auth ?? {}), mode }
  await saveAgentprotoConfig(cfg)
  return true
}
