/**
 * `config_get` / `config_set` — the one MCP (+ HTTP) surface for reading and
 * writing `~/.agentproto/config.json`, built on the zod schema + key
 * registry `config-schema.ts` (PR-1) declared. See
 * `.plans/agentproto-config/PLAN.md` PR-2.
 *
 * `config_get` reports, per registered key: the raw file `value`, the
 * `effective` value actually in force (env > config > registry default,
 * using the SAME resolvers the daemon itself uses where one exists —
 * `loadWorktreeIsolation`, `loadSpawnAttach`, `loadSpawnDedupe`,
 * `resolveAttentionDelaySec`, `loadProvenanceWrapGh`,
 * `loadAgentsMdInlineMaxKb`), and — for a `restart`-class key — whether the
 * file has changed since the daemon booted (`pendingRestart`, computed
 * against the BOOT SNAPSHOT captured once in `index.ts`, never re-read).
 *
 * `config_set` writes exactly one key through the registry's allowlist:
 * rejects an unknown key or a non-`writable` one (secret / lockout fields —
 * see `config-schema.ts`'s `CONFIG_KEYS` docs), type-validates the value,
 * then validates the WHOLE resulting config before saving, optionally
 * gated by an optimistic-concurrency `revision` (sha256 of the file bytes).
 * It never restarts anything — it only reports whether the daemon needs
 * one (`applied: "restart-required"`) and whether an env var already
 * shadows the write (`shadowedByEnv`).
 *
 * Registered on the root `/mcp` server only (see `index.ts`) — NOT added to
 * `DEFAULT_ORCHESTRATOR_TOOLS` (`orchestrator-gateway.ts`), so a scoped
 * child orchestrator can never reconfigure the daemon it runs on.
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { credentialIdentity } from "@agentproto/auth"

import {
  loadConfig,
  saveConfig,
  getConfigKey,
  setConfigKey,
  CONFIG_FILE_PATH,
  type AgentprotoConfig,
} from "./config.js"
import {
  CONFIG_KEYS,
  findConfigKey,
  validateConfig,
  validateConfigKeyType,
  redactConfigValue,
  type ConfigKeyEntry,
  type ConfigKeySection,
} from "./config-schema.js"
import {
  loadWorktreeIsolation,
  WORKTREE_ISOLATION_ENV,
  parseWorktreeIsolationMode,
} from "./worktree-isolation.js"
import { loadSpawnAttach, SPAWN_ATTACH_ENV, parseSpawnAttachMode } from "./spawn-attach.js"
import { loadSpawnDedupe, SPAWN_DEDUPE_ENV, parseSpawnDedupeMode } from "./spawn-dedupe.js"
import { resolveAttentionDelaySec, ATTENTION_DELAY_ENV } from "./session-presence.js"
import { loadProvenanceWrapGh, PROVENANCE_WRAP_GH_ENV, parseWrapGh } from "./gh-provenance-shim.js"
import { loadAgentsMdInlineMaxKb } from "./agents-md.js"
import type { RuntimeEvents } from "./events.js"

/** Boot-computed values for the four `daemon.*` restart-class knobs whose
 *  actual env>config>default resolution happens CLI-side (`serve.ts`'s
 *  `resolveIdleReapAfterMs` & co.) before `createGateway` ever runs — the
 *  runtime layer never re-implements that resolution, it just reports the
 *  number the daemon actually booted with (same values fed to
 *  `daemon_health` / `GET /health`). Keyed by the registry's own dotted
 *  path so `describeKey` can look one up generically. */
export interface BootDaemonKnobs {
  "daemon.idleReapAfterMs"?: number
  "daemon.crashDetectIntervalMs"?: number
  "daemon.restartSweepIntervalMs"?: number
  "daemon.turnStallAfterMs"?: number
}

export interface ConfigToolsDeps {
  /** Defaults to the real `loadConfig` — tests inject a stub bound to a
   *  temp-dir path so nothing here ever touches the real `~/.agentproto`. */
  loadCfg?: () => Promise<AgentprotoConfig>
  /** Defaults to the real `saveConfig`. */
  saveCfg?: (next: AgentprotoConfig) => Promise<void>
  /** Defaults to `CONFIG_FILE_PATH()` — the path `revision` is hashed from
   *  and the value returned as `config_get`'s top-level `path`. */
  configPath?: () => string
  /** The config the daemon booted with, captured ONCE in `index.ts` where
   *  `daemonConfig` is loaded — never re-read at call time. This is the
   *  baseline `pendingRestart` compares the live file against for every
   *  `apply: "restart"` key. */
  bootConfig: AgentprotoConfig
  /** The daemon-wide event bus `config:changed` is emitted on. */
  events: RuntimeEvents
  /** See {@link BootDaemonKnobs}. Omitted in a host that doesn't wire the
   *  four idle-reap/crash-detect/restart-sweep/turn-stall knobs (tests) —
   *  those four keys then fall back to the generic boot-value-or-default
   *  rule like every other `restart`-class key. */
  bootDaemonKnobs?: BootDaemonKnobs
}

export interface ConfigKeySecretDescriptor {
  set: boolean
  fingerprint?: string
  last4?: string
}

export interface ConfigKeyDescriptor {
  path: string
  value: unknown
  effective: unknown
  source: "env" | "config" | "default"
  envOverride?: string
  apply: "hot" | "restart"
  pendingRestart: boolean
  writable: boolean
  /** Present only for `secret: true` registry entries. A scalar secret
   *  (`daemon.authToken`, `tunnel.token`, `defaults.adapters.*.auth.{token,
   *  apiKey}`) reports `{ set, fingerprint?, last4? }` computed from the
   *  EFFECTIVE value via `credentialIdentity` — never the secret itself.
   *  An env-map secret (`acpAgents.*.env`, `terminalPresets.*.env`) reports
   *  one `{ set }` per key instead, since there's no single value to
   *  fingerprint. */
  secret?: ConfigKeySecretDescriptor | Record<string, { set: boolean }>
}

export interface ConfigGetInput {
  keys?: string[]
  section?: ConfigKeySection
}

export interface ConfigGetOutput {
  revision: string
  path: string
  keys: ConfigKeyDescriptor[]
}

export interface ConfigSetInput {
  key: string
  value?: unknown
  unset?: boolean
  revision?: string
}

export type ConfigSetErrorCode =
  | "invalid_input"
  | "unknown_key"
  | "not_writable"
  | "invalid_value"
  | "invalid_config"
  | "stale_revision"

export type ConfigSetResult =
  | {
      ok: true
      key: string
      applied: "hot" | "restart-required"
      shadowedByEnv?: string
      revision: string
    }
  | {
      ok: false
      error: ConfigSetErrorCode
      message: string
      /** Only set for `stale_revision` — the file's CURRENT revision, so a
       *  caller can re-fetch and retry. */
      revision?: string
    }

// ── env-override parsing, keyed by env var name ──
//
// Mirrors each module's own precedence rule (env > config > default) just
// enough to LABEL `source`/`envOverride` for observability — the actual
// runtime behaviour these knobs drive is unchanged and unaffected by this
// file. For a key with a real runtime resolver (`HOT_RESOLVERS` below) the
// resolver itself is called for `effective`; this map is only consulted to
// decide whether that effective value should be labelled "env".

function parseFiniteInt(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parsePositiveInt(raw: string): number | undefined {
  const n = parseFiniteInt(raw)
  return n !== undefined && n > 0 ? n : undefined
}

function parseNonEmptyString(raw: string): string | undefined {
  return raw.length > 0 ? raw : undefined
}

const ENV_PARSERS: Record<string, (raw: string) => unknown> = {
  [WORKTREE_ISOLATION_ENV]: parseWorktreeIsolationMode,
  [SPAWN_ATTACH_ENV]: parseSpawnAttachMode,
  [SPAWN_DEDUPE_ENV]: parseSpawnDedupeMode,
  [PROVENANCE_WRAP_GH_ENV]: raw => parseWrapGh(raw),
  [ATTENTION_DELAY_ENV]: raw => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  },
  AGENTPROTO_TOKEN: parseNonEmptyString,
  AGENTPROTO_WORKTREES_ROOT: parseNonEmptyString,
  AGENTPROTO_IDLE_REAP_AFTER_MS: parsePositiveInt,
  AGENTPROTO_CRASH_DETECT_INTERVAL_MS: parseFiniteInt,
  AGENTPROTO_RESTART_SWEEP_INTERVAL_MS: parsePositiveInt,
  AGENTPROTO_TURN_STALL_AFTER_MS: parseFiniteInt,
}

/** Registry-template path (NOT a concrete wildcard-expanded one — none of
 *  these entries are wildcarded) → the runtime's own resolver, called with
 *  the live `loadCfg` so it folds in env precedence exactly as the real
 *  spawn/session-presence/gh-shim/agents-md code paths do. Every entry here
 *  is `apply: "hot"`. */
const HOT_RESOLVERS: Record<string, (loadCfg: () => Promise<AgentprotoConfig>) => Promise<unknown>> = {
  "worktrees.isolation": loadWorktreeIsolation,
  "spawn.attach": loadSpawnAttach,
  "spawn.dedupe": loadSpawnDedupe,
  "sessions.attentionDelaySec": resolveAttentionDelaySec,
  "provenance.wrapGh": loadProvenanceWrapGh,
  "agentsMd.inlineMaxKb": loadAgentsMdInlineMaxKb,
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function computeRevision(path: string): Promise<string> {
  try {
    const raw = await fs.readFile(path, "utf8")
    return createHash("sha256").update(raw, "utf8").digest("hex")
  } catch {
    return ""
  }
}

/** Expand one registry entry into every CONCRETE dotted path present in
 *  `cfg` — a non-wildcard entry expands to itself; a wildcarded one (the
 *  `*` stands in for a record's dynamic key, e.g. `acpAgents.*.bin`)
 *  expands to one path per key ACTUALLY PRESENT in the file's record at
 *  that position, never an invented one. */
function expandEntry(entry: ConfigKeyEntry, cfg: AgentprotoConfig): string[] {
  const segs = entry.path.split(".")
  const starIdx = segs.indexOf("*")
  if (starIdx === -1) return [entry.path]
  const prefixSegs = segs.slice(0, starIdx)
  const suffixSegs = segs.slice(starIdx + 1)
  const parent = prefixSegs.length > 0 ? getConfigKey(cfg, prefixSegs.join(".")) : cfg
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return []
  return Object.keys(parent as Record<string, unknown>).map(key =>
    [...prefixSegs, key, ...suffixSegs].join("."),
  )
}

/** Resolve `{ keys?, section? }` into the concrete `(entry, path)` pairs to
 *  describe. No filter ⇒ every registry key, wildcards expanded against
 *  `cfg`. A filter entry containing `*` is matched against a template's
 *  OWN path and expanded the same way; a concrete filter entry is matched
 *  via `findConfigKey` (which already resolves a wildcard template) and
 *  returned as that ONE path, not every sibling. */
function resolveRequestedPaths(
  keys: string[] | undefined,
  section: ConfigKeySection | undefined,
  cfg: AgentprotoConfig,
): Array<{ entry: ConfigKeyEntry; path: string }> {
  const templates = CONFIG_KEYS.filter(e => !section || e.section === section)
  const out: Array<{ entry: ConfigKeyEntry; path: string }> = []
  const seen = new Set<string>()

  const add = (entry: ConfigKeyEntry, path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    out.push({ entry, path })
  }

  if (!keys || keys.length === 0) {
    for (const entry of templates) {
      for (const path of expandEntry(entry, cfg)) add(entry, path)
    }
    return out
  }

  for (const key of keys) {
    if (key.includes("*")) {
      const entry = templates.find(e => e.path === key)
      if (!entry) continue
      for (const path of expandEntry(entry, cfg)) add(entry, path)
    } else {
      const entry = findConfigKey(key)
      if (!entry) continue
      if (section && entry.section !== section) continue
      add(entry, key)
    }
  }
  return out
}

/** Compute the enriched `secret` block from an EFFECTIVE value — never the
 *  raw file value, since `effective` is what the daemon actually uses
 *  (e.g. an env-shadowed `tunnel.token`). Scalar ⇒ `credentialIdentity`
 *  (fingerprint + last4, same helper `auth_profile_list` uses); an
 *  object (env map) ⇒ one `{ set }` per key, no fingerprint. */
function describeSecret(value: unknown): ConfigKeyDescriptor["secret"] {
  if (value === undefined) return { set: false }
  if (typeof value === "string") {
    if (value.length === 0) return { set: false }
    return { set: true, ...credentialIdentity(value) }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        { set: typeof v === "string" && v.length > 0 },
      ]),
    )
  }
  return { set: true }
}

async function describeKey(
  entry: ConfigKeyEntry,
  path: string,
  liveCfg: AgentprotoConfig,
  deps: ConfigToolsDeps,
): Promise<ConfigKeyDescriptor> {
  const rawValue = getConfigKey(liveCfg, path)
  const bootValue = getConfigKey(deps.bootConfig, path)
  const envRaw = entry.env ? process.env[entry.env] : undefined
  const envParser = entry.env ? ENV_PARSERS[entry.env] : undefined
  const envParsed = envRaw !== undefined && envParser ? envParser(envRaw) : undefined

  let effective: unknown
  let source: "env" | "config" | "default"

  if (entry.apply === "hot") {
    const resolver = HOT_RESOLVERS[entry.path]
    if (resolver) {
      effective = await resolver(() => Promise.resolve(liveCfg))
    } else {
      effective = rawValue !== undefined ? rawValue : entry.default
    }
    source = envParsed !== undefined ? "env" : rawValue !== undefined ? "config" : "default"
  } else {
    const bootKnob = deps.bootDaemonKnobs?.[path as keyof BootDaemonKnobs]
    if (bootKnob !== undefined) {
      effective = bootKnob
    } else if (envParsed !== undefined) {
      effective = envParsed
    } else {
      effective = bootValue !== undefined ? bootValue : entry.default
    }
    source = envParsed !== undefined ? "env" : bootValue !== undefined ? "config" : "default"
  }

  const envOverride = source === "env" ? entry.env : undefined
  const pendingRestart = entry.apply === "restart" ? !deepEqual(rawValue, bootValue) : false

  const isSecret = entry.secret === true
  const displayValue = isSecret ? redactConfigValue(path, rawValue) : rawValue
  const displayEffective = isSecret ? redactConfigValue(path, effective) : effective

  return {
    path,
    value: displayValue,
    effective: displayEffective,
    source,
    ...(envOverride ? { envOverride } : {}),
    apply: entry.apply,
    pendingRestart,
    writable: entry.writable,
    ...(isSecret ? { secret: describeSecret(effective) } : {}),
  }
}

export async function configGet(
  input: ConfigGetInput,
  deps: ConfigToolsDeps,
): Promise<ConfigGetOutput> {
  const loadCfg = deps.loadCfg ?? loadConfig
  const path = deps.configPath ? deps.configPath() : CONFIG_FILE_PATH()
  const liveCfg = await loadCfg()
  const revision = await computeRevision(path)
  const requested = resolveRequestedPaths(input.keys, input.section, liveCfg)
  const keys = await Promise.all(
    requested.map(({ entry, path: p }) => describeKey(entry, p, liveCfg, deps)),
  )
  return { revision, path, keys }
}

export async function configSet(
  input: ConfigSetInput,
  deps: ConfigToolsDeps,
): Promise<ConfigSetResult> {
  const loadCfg = deps.loadCfg ?? loadConfig
  const saveCfg = deps.saveCfg ?? saveConfig
  const path = deps.configPath ? deps.configPath() : CONFIG_FILE_PATH()

  const hasValue = input.value !== undefined
  const wantsUnset = input.unset === true
  if (hasValue === wantsUnset) {
    return {
      ok: false,
      error: "invalid_input",
      message: "config_set: give exactly one of `value` or `unset: true`.",
    }
  }

  const entry = findConfigKey(input.key)
  if (!entry) {
    return {
      ok: false,
      error: "unknown_key",
      message: `config_set: "${input.key}" is not a known config key.`,
    }
  }
  if (!entry.writable) {
    return {
      ok: false,
      error: "not_writable",
      message: `config_set: "${input.key}" is not writable (${
        entry.secret ? "secret; set it via the CLI/auth profiles" : "lockout; edit ~/.agentproto/config.json by hand"
      }).`,
    }
  }

  const newValue = wantsUnset ? undefined : input.value
  if (!wantsUnset) {
    const validation = validateConfigKeyType(input.key, newValue)
    if (!validation.ok) {
      return { ok: false, error: "invalid_value", message: `config_set: ${validation.error}` }
    }
  }

  const currentRevision = await computeRevision(path)
  if (input.revision !== undefined && input.revision !== currentRevision) {
    return {
      ok: false,
      error: "stale_revision",
      message: "config_set: the config file changed since this revision was read.",
      revision: currentRevision,
    }
  }

  const liveCfg = await loadCfg()
  const next = setConfigKey(liveCfg, input.key, newValue)
  const wholeValidation = validateConfig(next)
  if (!wholeValidation.ok) {
    return {
      ok: false,
      error: "invalid_config",
      message: `config_set: resulting config would be invalid: ${wholeValidation.issues.join("; ")}`,
    }
  }

  await saveCfg(next)
  const revision = await computeRevision(path)

  const applied: "hot" | "restart-required" = entry.apply === "hot" ? "hot" : "restart-required"
  const envRaw = entry.env ? process.env[entry.env] : undefined
  const envParser = entry.env ? ENV_PARSERS[entry.env] : undefined
  const envParsed = envRaw !== undefined && envParser ? envParser(envRaw) : undefined
  const shadowedByEnv = envParsed !== undefined ? entry.env : undefined

  deps.events.emit({
    type: "config:changed",
    at: new Date().toISOString(),
    keys: [input.key],
    applied,
  })
  console.log(`[runtime/config] config:changed key=${input.key} applied=${applied}`)

  return {
    ok: true,
    key: input.key,
    applied,
    ...(shadowedByEnv ? { shadowedByEnv } : {}),
    revision,
  }
}

function text(value: object): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

const CONFIG_SECTIONS = [
  "wallets",
  "harnesses",
  "models",
  "defaults",
  "remote",
  "daemon",
  "advanced",
] as const

export function registerConfigTools(server: McpServer, deps: ConfigToolsDeps): void {
  server.tool(
    "config_get",
    "Read `~/.agentproto/config.json` over the declared key registry " +
      "(`config-schema.ts`'s `CONFIG_KEYS`). Omit both `keys` and `section` " +
      "to get EVERY registered key; a wildcarded registry entry (e.g. " +
      "`acpAgents.*.bin`) expands to one row per concrete key actually " +
      "present in the file, never an invented one. Each row reports the " +
      "raw file `value`, the `effective` value actually in force right now " +
      "(env var beats config file beats registry default, using the " +
      "daemon's own resolvers where one exists), `source` (which of those " +
      "three won), `envOverride` when an env var is shadowing the file, " +
      "`apply` (\"hot\" = takes effect on next use; \"restart\" = only " +
      "after a daemon restart), `pendingRestart` (a restart-class key " +
      "whose file value differs from what the running daemon booted " +
      "with), `writable` (whether config_set will accept a write here), " +
      "and, for a secret field, `secret: { set, fingerprint?, last4? }` " +
      "computed server-side; the credential itself is NEVER returned, by " +
      "this tool or any other. Also returns a top-level `revision` (sha256 " +
      "of the file bytes, for `config_set`'s optimistic-concurrency " +
      "`revision`) and `path` (the config file's absolute path).",
    {
      keys: z
        .array(z.string())
        .optional()
        .describe(
          "Dotted paths to read (e.g. \"daemon.port\", \"acpAgents.*.bin\" to " +
            "expand every present agent, or a concrete \"acpAgents.myagent.bin\" " +
            "for just one). Omit for every registered key.",
        ),
      section: z
        .enum(CONFIG_SECTIONS)
        .optional()
        .describe("Keep only registry keys in this section."),
    },
    async ({ keys, section }) => {
      const result = await configGet({ keys, section }, deps)
      return text(result)
    },
  )

  server.tool(
    "config_set",
    "Write ONE key in `~/.agentproto/config.json`, allowlisted against the " +
      "key registry (`config-schema.ts`'s `CONFIG_KEYS`): an unknown key or " +
      "one marked `writable: false` (a secret field, since wallet secrets " +
      "belong in auth profiles, or a daemon lockout field that could cut " +
      "the app off from the daemon) is rejected outright, never written. " +
      "Give exactly one of `value` (type-checked against the key's own " +
      "schema, then the WHOLE resulting config is re-validated before " +
      "saving) or `unset: true` (delete the key). Pass `revision` (from a " +
      "prior `config_get`) to reject the write with `stale_revision` if " +
      "the file changed since; omit it to write unconditionally. Never " +
      "restarts anything: the result's `applied` says \"hot\" (takes " +
      "effect on next use) or \"restart-required\", and `shadowedByEnv` " +
      "names an env var that already overrides this key's file value, if " +
      "any. Emits a `config:changed` event on success. Registered on the " +
      "root /mcp server only; a scoped child orchestrator cannot call " +
      "this.",
    {
      key: z.string().describe("Dotted registry path, e.g. \"daemon.label\"."),
      value: z.any().optional().describe("The new value. Mutually exclusive with `unset`."),
      unset: z.boolean().optional().describe("Delete the key. Mutually exclusive with `value`."),
      revision: z
        .string()
        .optional()
        .describe("Optimistic-concurrency token from a prior config_get; omit to write unconditionally."),
    },
    async ({ key, value, unset, revision }) => {
      const result = await configSet({ key, value, unset, revision }, deps)
      if (!result.ok) {
        return errorText(`config_set failed [${result.error}]: ${result.message}`)
      }
      return text(result)
    },
  )
}
