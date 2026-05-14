/**
 * `~/.agentproto/config.json` — single hand-editable JSON for the
 * agentproto control plane's defaults. Sits alongside the existing
 * surface files (workspaces.json, credentials.json, sessions.json):
 *
 *   workspaces.json     which directories are workspaces + which is active
 *   credentials.json    tunnel host bearer tokens (mode 0600)
 *   sessions.json       last-known snapshot of the registry (informational)
 *   config.json         daemon defaults: port, bind, allowed origins,
 *                       tunnel host, feature toggles
 *
 * Resolution order for every daemon knob is:
 *   1. CLI flag (e.g. --port)
 *   2. Env var (where one exists, e.g. AGENTPROTO_TOKEN)
 *   3. config.json
 *   4. Hardcoded default
 *
 * This means a user can call `agentproto config set daemon.port 18791`
 * once and never re-pass `--port 18791` to `serve install` etc. CLI
 * flags still win for one-off overrides.
 *
 * Schema is intentionally narrow + extensible — unknown keys are
 * preserved on save (deep-merge), so a newer CLI writing a new
 * field won't drop one an older CLI doesn't know about. No secrets
 * here; credentials stay in credentials.json (mode 0600).
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_VERSION = 1 as const

export interface DaemonConfig {
  /** Absolute path to the workspace the daemon binds to at boot. */
  workspace?: string
  /** HTTP port. Default 18790. */
  port?: number
  /** Bind addr. Default 127.0.0.1. */
  bind?: string
  /** Trusted browser origins for mutating /sessions/* routes (in
   *  addition to the hardcoded localhost defaults). */
  allowedOrigins?: string[]
  /** When true, the daemon does NOT auto-trust localhost-on-any-port.
   *  Only origins explicitly listed in `allowedOrigins` are allowed.
   *  Pair with a curated list (e.g. `["http://localhost:3000"]`) for
   *  hardened setups. Default false. */
  strictOrigins?: boolean
  /** Server label sent in tunnel hello frames. */
  label?: string
}

export interface TunnelConfig {
  /** Cloud WS URL. When set + autoconnect=true, `agentproto serve`
   *  bootstraps with `--connect <host>`. */
  host?: string
  /** Whether `agentproto daemon start` connects the tunnel by
   *  default. v0 only — implementer can ignore until daemon needs it. */
  autoconnect?: boolean
}

export interface FeaturesConfig {
  /** Hint that PTY is desired — informational; the daemon still
   *  detects node-pty's presence at runtime. */
  pty?: boolean
}

export interface AgentprotoConfig {
  version?: number
  daemon?: DaemonConfig
  tunnel?: TunnelConfig
  features?: FeaturesConfig
  /** Unknown keys preserved across save round-trips. */
  [unknown: string]: unknown
}

export const CONFIG_FILE_PATH = (): string =>
  join(homedir(), ".agentproto", "config.json")

/**
 * Load config.json. Returns an empty object (NOT null) when the file
 * is missing, malformed, or unreadable — callers can `cfg.daemon?.port`
 * safely without null-guards. Errors during a malformed-read are
 * logged once so the user notices the file is broken without the
 * daemon refusing to boot.
 */
export async function loadConfig(path?: string): Promise<AgentprotoConfig> {
  const target = path ?? CONFIG_FILE_PATH()
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AgentprotoConfig
    }
    console.warn(
      `[runtime/config] ${target}: top-level value is not an object — ignoring`,
    )
    return {}
  } catch (err) {
    // ENOENT is the common case; only warn on other shapes.
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== "ENOENT") {
      console.warn(
        `[runtime/config] failed to read ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return {}
  }
}

/**
 * Write config.json atomically (tmp + rename) so a concurrent
 * `agentproto config edit` can't half-truncate the file. Writes
 * `next` AS-IS — callers are expected to pass the full desired
 * state (loaded the existing config, mutated, passed it back).
 *
 * Earlier versions deep-merged with the on-disk file, but that made
 * deletions impossible: `setConfigKey(cfg, "x", undefined)` would
 * remove the key from memory, then the deep-merge would silently
 * re-add it from disk. The current design trusts the caller's
 * snapshot and uses atomic rename for crash safety.
 */
export async function saveConfig(
  next: AgentprotoConfig,
  path?: string,
): Promise<void> {
  const target = path ?? CONFIG_FILE_PATH()
  const payload = { ...next, version: CONFIG_VERSION }
  const dir = dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8")
  await fs.rename(tmp, target)
}

/**
 * Read a dot-notation key (`daemon.port`) out of a config. Returns
 * `undefined` when any segment is missing.
 */
export function getConfigKey(
  cfg: AgentprotoConfig,
  dotted: string,
): unknown {
  let cur: unknown = cfg
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Set a dot-notation key in a config. Returns a new object — does
 * NOT mutate. Creates intermediate objects as needed. Setting
 * `value: undefined` is treated as a delete.
 */
export function setConfigKey(
  cfg: AgentprotoConfig,
  dotted: string,
  value: unknown,
): AgentprotoConfig {
  const parts = dotted.split(".")
  const out: AgentprotoConfig = { ...cfg }
  let cur: Record<string, unknown> = out as Record<string, unknown>
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!
    const next = cur[k]
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur[k] = { ...(next as Record<string, unknown>) }
    } else {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  const leaf = parts[parts.length - 1]!
  if (value === undefined) {
    delete cur[leaf]
  } else {
    cur[leaf] = value
  }
  return out
}

/**
 * Deep merge — objects are recursively combined, everything else
 * (arrays, primitives) is replaced wholesale by `b`. Mirrors what
 * `Object.assign({}, a, b)` does for shallow keys.
 */
function deepMerge<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  a: A,
  b: B,
): A & B {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k]
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMerge(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
      )
    } else {
      out[k] = v
    }
  }
  return out as A & B
}
