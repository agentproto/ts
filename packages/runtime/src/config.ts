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
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

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
  /** Bearer token gating the gateway at boot (`AuthOptions` with
   *  `mode: "bearer"`). Unlike `remote_enable`'s ephemeral quick-tunnel
   *  token, this one lives in config.json and survives daemon restarts.
   *  Set via `agentproto config set daemon.authToken <token>` (e.g.
   *  `$(openssl rand -hex 32)`). Unset ⇒ the gateway boots with
   *  `mode: "none"` — fully open on loopback, same as today. */
  authToken?: string
}

export interface TunnelConfig {
  /** Cloud WS URL. When set + autoconnect=true, `agentproto serve`
   *  bootstraps with `--connect <host>`. */
  host?: string
  /** apt_ daemon token to present at the tunnel upgrade. When set,
   *  `agentproto serve` uses this BEFORE falling back to
   *  credentials.json — handy in profiles where the token-per-host
   *  mapping in credentials.json doesn't fit (e.g. host = tunnel URL
   *  but credentials were minted against the api URL). */
  token?: string
  /** Whether `agentproto daemon start` connects the tunnel by
   *  default. v0 only — implementer can ignore until daemon needs it. */
  autoconnect?: boolean
}

export interface FeaturesConfig {
  /** Hint that PTY is desired — informational; the daemon still
   *  detects node-pty's presence at runtime. */
  pty?: boolean
}

export interface PairingConfig {
  /** Rendezvous broker WS URL (ws:// or wss://) used by `pair offer` and by
   *  autoconnect on boot. When unset, `pair offer` requires an explicit
   *  `--rendezvous`. Mirrors `tunnel.host`. */
  rendezvous?: string
  /** Whether the daemon opens standing rendezvous connections for every
   *  persisted pairing on boot (so a paired client can reconnect anytime).
   *  Mirrors `tunnel.autoconnect`. Default true when a rendezvous is set. */
  autoconnect?: boolean
}

/**
 * A user-defined generic ACP agent — the config-file half of
 * `AcpAgentSpec` (the slug is the record key in `acpAgents`, so it's
 * omitted here). Any CLI that already speaks the Agent Client Protocol
 * can be wired with zero code by declaring one of these under
 * `acpAgents.<slug>` in `~/.agentproto/config.json`; the CLI's
 * `acpHandleFromSpec` mints a runnable `AgentCliHandle` from it at
 * resolve time (see `packages/cli/src/registry/acp-generic.ts`). Kept
 * in this package (not the CLI's) so `config.ts` stays the single
 * source of truth for the config surface without a cli→runtime→cli
 * import cycle — the CLI's `AcpAgentSpec` extends this shape.
 */
export interface AcpAgentConfigEntry {
  /** Display name. Defaults to the slug when omitted. */
  name?: string
  /** One-line description surfaced in `agentproto acp ls`. */
  description?: string
  /** Executable to spawn, e.g. "gemini". */
  bin: string
  /** Extra argv appended after `bin`, e.g. ["--experimental-acp"]. */
  bin_args?: string[]
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>
  /** Flag the CLI uses to receive the working directory, if it needs
   *  one passed explicitly (most ACP agents take cwd over the wire). */
  cwd_flag?: string
  /** When true, advertise resumable + native-resume continuation. */
  resumable?: boolean
  /** Known model ids for the agent (informational + validation hints). */
  models?: { default?: string; allowed?: string[] }
  /** Shown when `bin` is missing from PATH (how to install the CLI). */
  install_hint?: string
}

/**
 * Per-environment connection bundle. A profile overrides specific
 * fields of the top-level `daemon` / `tunnel` / `features` blocks
 * when selected via `--profile <name>` (or the top-level
 * `activeProfile` setting). Missing fields fall through to the
 * top-level config, so a profile only needs to declare what's
 * different — typically just `tunnel.host` + `tunnel.token`.
 *
 * Example:
 *   {
 *     "daemon": { "workspace": "/code", "port": 18790 },
 *     "activeProfile": "local",
 *     "profiles": {
 *       "local": { "tunnel": { "host": "ws://localhost:3200/connect",
 *                              "token": "apt_local", "autoconnect": true } },
 *       "prod":  { "tunnel": { "host": "wss://tunnel.guilde.work/connect",
 *                              "token": "apt_prod",  "autoconnect": true },
 *                  "daemon": { "port": 18791 } }
 *     }
 *   }
 *
 * Sandbox daemons generate per-sandbox profile entries at provision
 * time so the daemon inside the sandbox boots with
 * `agentproto serve --profile sandbox-<id>` and no extra plumbing.
 */
export interface ProfileConfig {
  daemon?: DaemonConfig
  tunnel?: TunnelConfig
  features?: FeaturesConfig
}

export interface AgentprotoConfig {
  version?: number
  daemon?: DaemonConfig
  tunnel?: TunnelConfig
  features?: FeaturesConfig
  /** E2E daemon-pairing defaults (rendezvous URL + autoconnect). */
  pairing?: PairingConfig
  /** Named connection profiles. See `ProfileConfig` for the merge
   *  semantics — a profile's fields shallow-override the top-level
   *  defaults for the selected run. */
  profiles?: Record<string, ProfileConfig>
  /** Profile name to use when `--profile` isn't passed. When unset,
   *  the top-level `daemon` / `tunnel` blocks are used directly. */
  activeProfile?: string
  /** Default `skills` + `options` auto-applied to every `agent_start`
   *  spawn — global and per-adapter. See `resolveSpawnDefaults` in
   *  `spawn-defaults.ts` for the merge precedence with an explicit call.
   *  Absent ⇒ current behaviour exactly (no regression). */
  defaults?: SpawnDefaultsConfig
  /** User-defined generic ACP agents, keyed by adapter slug. Each entry
   *  is minted into a runnable handle by the CLI's `acpHandleFromSpec`
   *  when `resolveAdapter(slug)` finds no npm adapter package. User
   *  entries shadow the curated `ACP_CATALOG` on slug collision. */
  acpAgents?: Record<string, AcpAgentConfigEntry>
  /** Unknown keys preserved across save round-trips. */
  [unknown: string]: unknown
}

export const CONFIG_FILE_PATH = (): string =>
  join(homedir(), ".agentproto", "config.json")

/**
 * Drop any `acpAgents` entries that aren't a shape we can turn into a
 * handle. The one hard requirement is a non-empty string `bin` (the
 * executable to spawn); everything else is optional and defaulted
 * downstream. Invalid entries are removed rather than throwing so the
 * daemon still boots — one warning names the offending slug so the
 * user can fix their config. Returns `undefined` when nothing valid
 * remains, keeping the key absent (== "no generic agents").
 */
function sanitizeAcpAgents(
  raw: unknown,
  target: string,
): Record<string, AcpAgentConfigEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(
      `[runtime/config] ${target}: 'acpAgents' is not an object — ignoring`,
    )
    return undefined
  }
  const out: Record<string, AcpAgentConfigEntry> = {}
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { bin?: unknown }).bin === "string" &&
      (value as { bin: string }).bin.length > 0
    ) {
      out[slug] = value as AcpAgentConfigEntry
    } else {
      console.warn(
        `[runtime/config] ${target}: acpAgents.${slug} is missing a string 'bin' — ignoring`,
      )
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

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
      const cfg = parsed as AgentprotoConfig
      // Sanitize `acpAgents` in the same tolerant spirit as the rest of
      // this loader: a malformed entry is dropped (with one warning) so a
      // single bad hand-edit can't make every generic ACP agent
      // unresolvable. Full AIP-45 validation happens later, at
      // `acpHandleFromSpec` time, with precise field-level messages.
      if (cfg.acpAgents !== undefined) {
        cfg.acpAgents = sanitizeAcpAgents(cfg.acpAgents, target)
      }
      return cfg
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
