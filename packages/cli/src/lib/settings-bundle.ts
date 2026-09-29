/**
 * `agentproto settings export|import` — bundle + apply logic (AIP onboarding
 * PLAN §PR-B, "bring my main setup").
 *
 * A {@link SettingsBundle} is a versioned JSON snapshot of the pieces of a
 * daemon's local setup that are safe to hand to another machine: installed
 * adapters, harness→profile presets, auth-profile METADATA (never a
 * credential), named LLM endpoints, imported-MCP pointers, and a sanitized
 * slice of `config.json`. Nothing here talks to the network — gathering and
 * applying are both pure local file I/O, dependency-injected so tests never
 * touch a real `~/.agentproto`.
 *
 * Secret discipline (see `settings-secrets.ts`):
 *   - Auth-profile credentials are NEVER included by default.
 *   - `--include-secrets <id>` seals the named profile's stored secret under
 *     a passphrase before it's embedded — the bundle file is safe to move
 *     over an untrusted channel; only someone with the passphrase (given out
 *     of band) can recover it.
 *   - An imported MCP server's `env`/`headers` can carry literal secrets
 *     (an Authorization header, an API key env var) — only the KEY NAMES are
 *     exported, never the values (mirrors `EndpointConfig.apiKeyEnv`, which
 *     is already a name-only reference).
 *   - `config.json` is walked and any key the runtime's own schema marks
 *     `secret: true` is dropped, alongside any string value that looks like
 *     an absolute filesystem path or a loopback address (machine-specific,
 *     not a credential, but still not portable) — both are reported, never
 *     silently lost.
 *   - Cron jobs are never gathered here at all: a `kind: "command"` cron
 *     action can embed an arbitrary shell command (secrets and all), and
 *     they live in the daemon's in-memory scheduler, not a plain file — see
 *     `agentproto cron list` for that surface instead.
 */

import { hostname } from "node:os"
import { readFile, writeFile } from "node:fs/promises"
import {
  KeychainStore,
  createAuthProfile,
  getAuthProfile,
  addAuthProfile,
  listAuthProfiles,
  AuthProfileValidationError,
  type AuthMethod,
  type CredentialStore,
} from "@agentproto/auth"
import {
  loadHarnessPresets,
  getHarnessPreset,
  addHarnessPreset,
  HarnessPresetValidationError,
  type HarnessPreset,
} from "@agentproto/runtime"
import { loadConfig, saveConfig, getConfigKey, setConfigKey } from "@agentproto/runtime/config"
import { findConfigKey } from "@agentproto/runtime/config-schema"
import {
  loadImportedMcps,
  addImport,
  findImport,
  secretRefKeys,
  saveImportedMcps,
  type ImportedMcpEntry,
} from "@agentproto/runtime/mcp-imports"
import {
  readEndpointsFromDisk,
  resolveEndpointsFilePath,
  type EndpointConfig,
} from "@agentproto/llm-endpoint"
import { listInstalledAdapters as listInstalledAdaptersImpl } from "../registry/resolve.js"
import {
  sealWithPassphrase,
  unsealWithPassphrase,
  type SealedEnvelope,
} from "./settings-secrets.js"

export const SETTINGS_BUNDLE_VERSION = 1 as const

// ── bundle shape ─────────────────────────────────────────────────────────

export interface ExportedAdapter {
  slug: string
  version: string
  packageName: string
}

/** Auth-profile METADATA only — id, endpoint (billing vendor), method, plus
 *  the two purely-informational fields. Never `credentialRef`/`source`
 *  (local-only store pointers, meaningless on another machine) and never a
 *  secret. */
export interface ExportedAuthProfile {
  id: string
  endpoint: string
  method: AuthMethod
  label?: string
  origin?: string
}

/** A redacted `ImportedMcpEntry` — `env`/`headers` reduced to their key
 *  NAMES so the shape of "this MCP needs these vars" survives without the
 *  values ever leaving the source machine, and `command`/`args` dropped
 *  entirely (not just their key names — there's no key to keep) when either
 *  embeds an absolute local path (`redacted` names which). */
export interface ExportedMcpImport {
  id: string
  alias: string
  addedAt: string
  /** Link back to the source config (additive; informational on import). */
  origin?: ImportedMcpEntry["origin"]
  resolve?: ImportedMcpEntry["resolve"]
  /** KEY names whose values live in the source machine's secret store —
   *  values/refs never leave it (like `headerKeys`). */
  secretRefKeys?: { headers?: string[]; env?: string[] }
  snapshot: {
    source: string
    scope: string
    name: string
    type: string
    command?: string
    args?: string[]
    url?: string
    tags?: string[]
    parseNote?: string
    envKeys?: string[]
    headerKeys?: string[]
    /** Which of `command`/`args` was dropped for embedding an absolute
     *  local path (e.g. a binary under `~/.agentproto/...`). */
    redacted?: ("command" | "args")[]
  }
}

export type ConfigSkipReason = "secret" | "machine-specific"
export interface ConfigSkip {
  path: string
  reason: ConfigSkipReason
}

/** One profile's stored secret, sealed under a passphrase (see
 *  `settings-secrets.ts`). The plaintext this envelope decrypts to is
 *  `JSON.stringify({ value, metadata })` — `kind`/`expiresAt` ride in the
 *  clear alongside since neither is secret. */
export interface SealedProfileSecret {
  profileId: string
  kind: "pat" | "assertion" | "oat" | "daemon"
  expiresAt?: string
  envelope: SealedEnvelope
}

export interface SettingsBundle {
  version: typeof SETTINGS_BUNDLE_VERSION
  createdAt: string
  /** Informational only — the exporting machine's hostname. Not an identity
   *  claim; nothing in import trusts it. */
  sourceHost: string
  adapters: ExportedAdapter[]
  harnessPresets: HarnessPreset[]
  authProfiles: ExportedAuthProfile[]
  llmEndpoints: EndpointConfig[]
  mcpServers: ExportedMcpImport[]
  config: Record<string, unknown>
  configSkipped: ConfigSkip[]
  secrets?: SealedProfileSecret[]
}

// ── gather (export) ──────────────────────────────────────────────────────

export interface SettingsGatherDeps {
  listInstalledAdapters: typeof listInstalledAdaptersImpl
  loadHarnessPresets: typeof loadHarnessPresets
  listAuthProfiles: typeof listAuthProfiles
  getAuthProfile: typeof getAuthProfile
  readEndpointsFromDisk: typeof readEndpointsFromDisk
  loadImportedMcps: typeof loadImportedMcps
  loadConfig: typeof loadConfig
  credentialStore: CredentialStore
}

export function defaultSettingsGatherDeps(): SettingsGatherDeps {
  return {
    listInstalledAdapters: listInstalledAdaptersImpl,
    loadHarnessPresets,
    listAuthProfiles,
    getAuthProfile,
    readEndpointsFromDisk,
    loadImportedMcps,
    loadConfig,
    credentialStore: new KeychainStore(),
  }
}

const ABS_PATH_RE = /^(\/|~\/|[A-Za-z]:[\\/])/
const LOOPBACK_RE = /(localhost|127\.0\.0\.1|::1)/i
// Catches a credential-shaped VALUE even when a key isn't (or can't yet be)
// declared `secret: true` in config-schema.ts — belt-and-suspenders after a
// real leak was caught in review: `profiles.<name>.tunnel.token` mirrors the
// top-level `tunnel.token` shape (see `ProfileConfig` in config.ts) but has
// no CONFIG_KEYS entry of its own, so the schema-driven check alone missed
// it. This regex-on-key-name check catches that case independently of the
// path-based one below, and any other secret nested under a name schema
// doesn't (yet) cover.
const SECRET_KEY_NAME_RE = /(token|secret|password|passwd|api[-_]?key|credential|privatekey|private[-_]?key)/i

function looksMachineSpecific(value: string): boolean {
  return ABS_PATH_RE.test(value) || LOOPBACK_RE.test(value)
}

/** `profiles.<name>.*` mirrors the top-level `daemon`/`tunnel`/`features`
 *  shape (`ProfileConfig`) one level down — config-schema.ts declares
 *  `CONFIG_KEYS` for the top-level shape only, so a nested override is
 *  checked against its top-level counterpart by stripping the
 *  `profiles.<name>` prefix. */
function normalizeProfileOverridePath(path: string): string {
  return path.replace(/^profiles\.[^.]+\./, "")
}

function isDeclaredSecretPath(path: string): boolean {
  return Boolean(findConfigKey(path)?.secret) || Boolean(findConfigKey(normalizeProfileOverridePath(path))?.secret)
}

/** Recursively drop `secret: true` config keys (schema-declared OR
 *  credential-shaped by key name — see {@link SECRET_KEY_NAME_RE}) and
 *  machine-specific string values (absolute paths, loopback addresses),
 *  reporting every drop by dotted path (never by value). Array items are
 *  filtered the same way. */
function sanitizeConfigValue(value: unknown, path: string, skipped: ConfigSkip[]): unknown {
  if (typeof value === "string") {
    if (looksMachineSpecific(value)) {
      skipped.push({ path, reason: "machine-specific" })
      return undefined
    }
    return value
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = []
    value.forEach((item, i) => {
      const sanitized = sanitizeConfigValue(item, `${path}[${i}]`, skipped)
      if (sanitized !== undefined) kept.push(sanitized)
    })
    return kept
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key
      if (isDeclaredSecretPath(childPath) || (typeof child === "string" && SECRET_KEY_NAME_RE.test(key))) {
        skipped.push({ path: childPath, reason: "secret" })
        continue
      }
      const sanitized = sanitizeConfigValue(child, childPath, skipped)
      if (sanitized !== undefined) out[key] = sanitized
    }
    return out
  }
  return value
}

export function sanitizeConfigForExport(
  cfg: Record<string, unknown>,
): { config: Record<string, unknown>; skipped: ConfigSkip[] } {
  const skipped: ConfigSkip[] = []
  const config = sanitizeConfigValue(cfg, "", skipped) as Record<string, unknown>
  return { config, skipped }
}

function redactMcpEntry(entry: ImportedMcpEntry): ExportedMcpImport {
  const { snapshot } = entry
  // A stdio MCP's command/args commonly embed an absolute local path (a
  // binary under ~/.agentproto/..., a profile directory) — that leaks the
  // username and directory layout, same category of leak config.json's
  // sanitizer already guards against. Loopback URLs are left alone: a
  // named local MCP server's address is meaningful state, not an identity
  // leak (same reasoning as llm-endpoints' `baseUrl`).
  const commandLeaksPath = snapshot.command !== undefined && ABS_PATH_RE.test(snapshot.command)
  const argsLeakPath = (snapshot.args ?? []).some(a => ABS_PATH_RE.test(a))
  const redacted: ("command" | "args")[] = []
  if (commandLeaksPath) redacted.push("command")
  if (argsLeakPath) redacted.push("args")
  return {
    id: entry.id,
    alias: entry.alias,
    addedAt: entry.addedAt,
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.resolve ? { resolve: entry.resolve } : {}),
    ...(secretRefKeys(entry) ? { secretRefKeys: secretRefKeys(entry) } : {}),
    snapshot: {
      source: snapshot.source,
      scope: snapshot.scope,
      name: snapshot.name,
      type: snapshot.type,
      ...(snapshot.command && !commandLeaksPath ? { command: snapshot.command } : {}),
      ...(snapshot.args && !argsLeakPath ? { args: snapshot.args } : {}),
      ...(snapshot.url ? { url: snapshot.url } : {}),
      ...(snapshot.tags ? { tags: snapshot.tags } : {}),
      ...(snapshot.parseNote ? { parseNote: snapshot.parseNote } : {}),
      ...(snapshot.env ? { envKeys: Object.keys(snapshot.env) } : {}),
      ...(snapshot.headers ? { headerKeys: Object.keys(snapshot.headers) } : {}),
      ...(redacted.length > 0 ? { redacted } : {}),
    },
  }
}

export interface GatherSecretsResult {
  secrets: SealedProfileSecret[]
  /** `<profileId, reason>` for a requested id that couldn't be sealed
   *  (unknown profile, source-backed with no stored secret, keychain read
   *  failure). */
  failed: { profileId: string; reason: string }[]
}

/** Seal the stored secret of each requested profile id under `passphrase`.
 *  Never throws on a per-id failure — collected in `failed` instead, so one
 *  bad id doesn't abort a multi-profile export. */
export async function gatherSealedSecrets(
  profileIds: readonly string[],
  passphrase: string,
  deps: Pick<SettingsGatherDeps, "credentialStore" | "getAuthProfile"> = defaultSettingsGatherDeps(),
): Promise<GatherSecretsResult> {
  const secrets: SealedProfileSecret[] = []
  const failed: { profileId: string; reason: string }[] = []
  for (const profileId of profileIds) {
    const profile = await deps.getAuthProfile(profileId)
    if (!profile) {
      failed.push({ profileId, reason: "no such auth profile" })
      continue
    }
    if (!profile.credentialRef) {
      failed.push({
        profileId,
        reason: profile.source
          ? "source-backed profile — no stored secret to seal"
          : "profile has no credentialRef",
      })
      continue
    }
    try {
      const stored = await deps.credentialStore.read({ path: profile.credentialRef })
      if (!stored) {
        failed.push({ profileId, reason: "credential store has no entry at credentialRef" })
        continue
      }
      const plaintext = JSON.stringify({ value: stored.value, metadata: stored.metadata })
      secrets.push({
        profileId,
        kind: stored.kind,
        ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
        envelope: sealWithPassphrase(plaintext, passphrase),
      })
    } catch (err) {
      failed.push({
        profileId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { secrets, failed }
}

export interface GatherSettingsBundleOptions {
  /** Profile ids to seal + embed (see {@link gatherSealedSecrets}). Requires
   *  `passphrase`. Empty/omitted ⇒ no secrets in the bundle (the default). */
  includeSecrets?: readonly string[]
  passphrase?: string
}

export interface GatherSettingsBundleResult {
  bundle: SettingsBundle
  /** Non-fatal notices — a requested `--include-secrets` id that failed to
   *  seal, etc. Never contains a secret value. */
  warnings: string[]
}

export async function gatherSettingsBundle(
  opts: GatherSettingsBundleOptions = {},
  deps: SettingsGatherDeps = defaultSettingsGatherDeps(),
): Promise<GatherSettingsBundleResult> {
  const warnings: string[] = []

  const adapters: ExportedAdapter[] = (await deps.listInstalledAdapters()).map(a => ({
    slug: a.slug,
    version: a.version,
    packageName: a.packageName,
  }))

  const { presets: harnessPresets } = await deps.loadHarnessPresets()

  const authProfiles: ExportedAuthProfile[] = (await deps.listAuthProfiles()).map(p => ({
    id: p.id,
    endpoint: p.endpoint,
    method: p.method,
    ...(p.label ? { label: p.label } : {}),
    ...(p.origin ? { origin: p.origin } : {}),
  }))

  const endpointsLoad = deps.readEndpointsFromDisk()
  if (endpointsLoad.errors.length > 0) {
    warnings.push(
      `skipped llm-endpoints.json: ${endpointsLoad.errors.join("; ")}`,
    )
  }
  const llmEndpoints = endpointsLoad.errors.length > 0 ? [] : endpointsLoad.endpoints

  const importedMcps = await deps.loadImportedMcps()
  const mcpServers = importedMcps.imports.map(redactMcpEntry)

  const rawConfig = (await deps.loadConfig()) as unknown as Record<string, unknown>
  const { config, skipped: configSkipped } = sanitizeConfigForExport(
    JSON.parse(JSON.stringify(rawConfig)) as Record<string, unknown>,
  )

  let secrets: SealedProfileSecret[] | undefined
  if (opts.includeSecrets && opts.includeSecrets.length > 0) {
    if (!opts.passphrase) {
      throw new Error(
        "settings export: --include-secrets requires a passphrase (--passphrase-env <VAR>)",
      )
    }
    const result = await gatherSealedSecrets(opts.includeSecrets, opts.passphrase, deps)
    secrets = result.secrets
    for (const f of result.failed) {
      warnings.push(`--include-secrets ${f.profileId}: ${f.reason}`)
    }
  }

  const bundle: SettingsBundle = {
    version: SETTINGS_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    sourceHost: hostname(),
    adapters,
    harnessPresets,
    authProfiles,
    llmEndpoints,
    mcpServers,
    config,
    configSkipped,
    ...(secrets ? { secrets } : {}),
  }
  return { bundle, warnings }
}

// ── apply (import) ───────────────────────────────────────────────────────

export interface SettingsApplyDeps {
  listInstalledAdapters: typeof listInstalledAdaptersImpl
  getHarnessPreset: typeof getHarnessPreset
  addHarnessPreset: typeof addHarnessPreset
  getAuthProfile: typeof getAuthProfile
  addAuthProfile: typeof addAuthProfile
  createAuthProfile: typeof createAuthProfile
  listAuthProfiles: typeof listAuthProfiles
  credentialStore: CredentialStore
  loadImportedMcps: typeof loadImportedMcps
  saveImportedMcps: typeof saveImportedMcps
  readEndpointsFromDisk: typeof readEndpointsFromDisk
  resolveEndpointsFilePath: typeof resolveEndpointsFilePath
  writeEndpointsFile: (path: string, endpoints: EndpointConfig[]) => Promise<void>
  loadConfig: typeof loadConfig
  saveConfig: typeof saveConfig
}

async function defaultWriteEndpointsFile(path: string, endpoints: EndpointConfig[]): Promise<void> {
  await writeFile(path, JSON.stringify({ endpoints }, null, 2) + "\n", "utf8")
}

export function defaultSettingsApplyDeps(): SettingsApplyDeps {
  return {
    listInstalledAdapters: listInstalledAdaptersImpl,
    getHarnessPreset,
    addHarnessPreset,
    getAuthProfile,
    addAuthProfile,
    createAuthProfile,
    listAuthProfiles,
    credentialStore: new KeychainStore(),
    loadImportedMcps,
    saveImportedMcps,
    readEndpointsFromDisk,
    resolveEndpointsFilePath,
    writeEndpointsFile: defaultWriteEndpointsFile,
    loadConfig,
    saveConfig,
  }
}

interface OutcomeList {
  added: string[]
  skipped: { item: string; reason: string }[]
}

export interface SettingsApplyReport {
  dryRun: boolean
  /** Adapters the bundle names that aren't installed locally — report-only,
   *  never auto-installed (an adapter install shells out and downloads
   *  arbitrary code; that stays an explicit `agentproto install <slug>`). */
  missingAdapters: ExportedAdapter[]
  authProfiles: OutcomeList
  /** Profile ids actually restored WITH their secret (unsealed + written to
   *  the credential store), vs. created as a disabled shape-only stub. */
  secretsRestored: string[]
  harnessPresets: OutcomeList
  llmEndpoints: OutcomeList
  mcpServers: OutcomeList
  /** Imported MCPs whose secrets lived in the exporting machine's secret
   *  store: entry added with EMPTY placeholders for these keys (names only);
   *  supply them locally (re-run `mcp_import` / set the values). Dangling by
   *  construction, reported like an auth profile's missing credential. */
  mcpDanglingSecrets: { id: string; headers?: string[]; env?: string[] }[]
  config: OutcomeList
}

export interface ApplySettingsBundleOptions {
  dryRun?: boolean
  /** Passphrase to unseal `bundle.secrets`. Omitted ⇒ every bundled profile
   *  is created as a disabled, secret-less stub (the safe default). */
  unsealPassphrase?: string
}

function emptyOutcome(): OutcomeList {
  return { added: [], skipped: [] }
}

export async function applySettingsBundle(
  bundle: SettingsBundle,
  opts: ApplySettingsBundleOptions = {},
  deps: SettingsApplyDeps = defaultSettingsApplyDeps(),
): Promise<SettingsApplyReport> {
  if (bundle.version !== SETTINGS_BUNDLE_VERSION) {
    throw new Error(
      `settings import: unsupported bundle version ${String(bundle.version)} (this build understands ${SETTINGS_BUNDLE_VERSION})`,
    )
  }
  const dryRun = opts.dryRun ?? false

  // ── adapters — report only ──
  const installedSlugs = new Set((await deps.listInstalledAdapters()).map(a => a.slug))
  const missingAdapters = bundle.adapters.filter(a => !installedSlugs.has(a.slug))

  // ── auth profiles (+ optional secret restore) ──
  const sealedById = new Map((bundle.secrets ?? []).map(s => [s.profileId, s]))
  const authProfiles = emptyOutcome()
  const secretsRestored: string[] = []
  for (const profile of bundle.authProfiles) {
    const existing = await deps.getAuthProfile(profile.id)
    if (existing) {
      authProfiles.skipped.push({ item: profile.id, reason: "already exists locally" })
      continue
    }
    const sealed = sealedById.get(profile.id)
    if (sealed && opts.unsealPassphrase) {
      if (dryRun) {
        authProfiles.added.push(profile.id)
        secretsRestored.push(profile.id)
        continue
      }
      try {
        const plaintext = unsealWithPassphrase(sealed.envelope, opts.unsealPassphrase)
        const { value, metadata } = JSON.parse(plaintext) as { value: string; metadata?: Record<string, unknown> }
        const created = await deps.createAuthProfile(
          {
            id: profile.id,
            endpoint: profile.endpoint,
            method: profile.method,
            credential: value,
            ...(profile.label ? { label: profile.label } : {}),
            ...(profile.origin ? { origin: profile.origin } : {}),
          },
          {
            store: deps.credentialStore,
            getProfile: deps.getAuthProfile,
            listProfiles: deps.listAuthProfiles,
            addProfile: deps.addAuthProfile,
            removeProfile: async () => false,
          },
        )
        // `createAuthProfile` always derives `kind` from `method`
        // (oauth-bearer → "oat", else "pat") and never accepts an expiry —
        // fine for a freshly-issued credential, but WRONG for a restored
        // one whose real stored kind can be "assertion" (service-auth) or
        // "daemon", and which can carry a real `expiresAt`. Overwrite the
        // just-written store entry with the sealed record's actual
        // kind/expiresAt/metadata so e.g. an assertion-backed profile isn't
        // silently reclassified as directly-bearer-usable "oat"
        // (`CredentialBroker.bearerHeaders()` treats "assertion" as needing
        // a flow-engine exchange first) and a real expiry survives the
        // round trip instead of vanishing (`isFresh()` treats an absent
        // `expiresAt` as always-fresh).
        if (created.credentialRef) {
          await deps.credentialStore.write(
            { path: created.credentialRef },
            {
              value,
              kind: sealed.kind,
              ...(sealed.expiresAt ? { expiresAt: sealed.expiresAt } : {}),
              ...(metadata ? { metadata } : {}),
            },
          )
        }
        authProfiles.added.push(profile.id)
        secretsRestored.push(profile.id)
        continue
      } catch (err) {
        authProfiles.skipped.push({
          item: profile.id,
          reason: `failed to restore sealed secret: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
    }
    // No secret to restore — a shape-only, disabled placeholder: the profile
    // exists so a harness preset CAN reference it, but it services nothing
    // until the operator supplies a credential (`agentproto auth login`,
    // `auth_profile_create`).
    if (!dryRun) {
      await deps.addAuthProfile({
        id: profile.id,
        endpoint: profile.endpoint,
        method: profile.method,
        disabled: true,
        ...(profile.label ? { label: profile.label } : {}),
        ...(profile.origin ? { origin: profile.origin } : {}),
      })
    }
    authProfiles.added.push(profile.id)
  }

  // ── harness presets ──
  const harnessPresets = emptyOutcome()
  for (const preset of bundle.harnessPresets) {
    const existing = await deps.getHarnessPreset(preset.id)
    if (existing) {
      harnessPresets.skipped.push({ item: preset.id, reason: "already exists locally" })
      continue
    }
    if (dryRun) {
      harnessPresets.added.push(preset.id)
      continue
    }
    try {
      await deps.addHarnessPreset(preset, { getProfile: deps.getAuthProfile })
      harnessPresets.added.push(preset.id)
    } catch (err) {
      const reason =
        err instanceof HarnessPresetValidationError || err instanceof AuthProfileValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      harnessPresets.skipped.push({ item: preset.id, reason })
    }
  }

  // ── llm endpoints ──
  const llmEndpoints = emptyOutcome()
  const existingEndpointsLoad = deps.readEndpointsFromDisk()
  if (existingEndpointsLoad.errors.length > 0) {
    for (const ep of bundle.llmEndpoints) {
      llmEndpoints.skipped.push({
        item: ep.id,
        reason: `local llm-endpoints.json is malformed — fix it by hand first (${existingEndpointsLoad.errors.join("; ")})`,
      })
    }
  } else {
    const existingIds = new Set(existingEndpointsLoad.endpoints.map(e => e.id))
    const merged = [...existingEndpointsLoad.endpoints]
    for (const ep of bundle.llmEndpoints) {
      if (existingIds.has(ep.id) || ep.id === "forge") {
        llmEndpoints.skipped.push({ item: ep.id, reason: "already exists locally" })
        continue
      }
      merged.push(ep)
      llmEndpoints.added.push(ep.id)
    }
    if (!dryRun && llmEndpoints.added.length > 0) {
      await deps.writeEndpointsFile(deps.resolveEndpointsFilePath(), merged)
    }
  }

  // ── imported MCP servers ──
  const mcpServers = emptyOutcome()
  const mcpDanglingSecrets: SettingsApplyReport["mcpDanglingSecrets"] = []
  let mcpConfig = await deps.loadImportedMcps()
  for (const entry of bundle.mcpServers) {
    if (findImport(mcpConfig, entry.id)) {
      mcpServers.skipped.push({ item: entry.id, reason: "already exists locally" })
      continue
    }
    mcpServers.added.push(entry.id)
    if (entry.secretRefKeys) mcpDanglingSecrets.push({ id: entry.id, ...entry.secretRefKeys })
    if (dryRun) continue
    const { envKeys, headerKeys, redacted: _redacted, ...snapshotRest } = entry.snapshot
    mcpConfig = addImport(mcpConfig, {
      alias: entry.alias,
      snapshot: {
        id: entry.id,
        ...snapshotRest,
        // Empty placeholders — the value never left the source machine.
        // The operator fills these in locally before the import is usable.
        ...(envKeys ? { env: Object.fromEntries(envKeys.map(k => [k, ""])) } : {}),
        ...(headerKeys ? { headers: Object.fromEntries(headerKeys.map(k => [k, ""])) } : {}),
      } as ImportedMcpEntry["snapshot"],
    })
  }
  if (!dryRun && mcpServers.added.length > 0) {
    await deps.saveImportedMcps(mcpConfig)
  }

  // ── config — only fill keys that are UNSET locally; never overwrite ──
  const config = emptyOutcome()
  const localConfig = await deps.loadConfig()
  let nextConfig = localConfig
  for (const { path, value } of flattenConfig(bundle.config)) {
    const current = getConfigKey(localConfig, path)
    if (current !== undefined) {
      config.skipped.push({ item: path, reason: "already set locally" })
      continue
    }
    config.added.push(path)
    if (!dryRun) nextConfig = setConfigKey(nextConfig, path, value)
  }
  if (!dryRun && config.added.length > 0) {
    await deps.saveConfig(nextConfig)
  }

  return {
    dryRun,
    missingAdapters,
    authProfiles,
    secretsRestored,
    harnessPresets,
    llmEndpoints,
    mcpServers,
    mcpDanglingSecrets,
    config,
  }
}

/** Flatten a nested plain-object config into `{path, value}` leaves — a leaf
 *  is any value that isn't itself a plain object (arrays included, so an
 *  `allowedOrigins: [...]` is one leaf, not N). Mirrors the dotted-path shape
 *  `getConfigKey`/`setConfigKey` already use. */
function flattenConfig(obj: Record<string, unknown>, prefix = ""): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenConfig(value as Record<string, unknown>, path))
    } else {
      out.push({ path, value })
    }
  }
  return out
}

/** Top-level array fields every {@link SettingsBundle} must carry — checked
 *  by {@link readSettingsBundle} so a hand-edited or foreign JSON file with
 *  a plausible-looking `version` but a missing/malformed field fails with a
 *  clear message here rather than an unhelpful raw `TypeError` deep inside
 *  `applySettingsBundle`. */
const REQUIRED_ARRAY_FIELDS = [
  "adapters",
  "harnessPresets",
  "authProfiles",
  "llmEndpoints",
  "mcpServers",
  "configSkipped",
] as const

/** Read + parse a bundle file. Throws with a clear message on bad JSON, a
 *  missing `version`, or a malformed/missing required field. */
export async function readSettingsBundle(path: string): Promise<SettingsBundle> {
  const raw = await readFile(path, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!parsed || typeof parsed !== "object" || !("version" in parsed)) {
    throw new Error(`${path} does not look like a settings bundle (missing "version")`)
  }
  const candidate = parsed as Record<string, unknown>
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(candidate[field])) {
      throw new Error(`${path} does not look like a settings bundle (missing or malformed "${field}")`)
    }
  }
  if (!candidate.config || typeof candidate.config !== "object" || Array.isArray(candidate.config)) {
    throw new Error(`${path} does not look like a settings bundle (missing or malformed "config")`)
  }
  if (candidate.secrets !== undefined && !Array.isArray(candidate.secrets)) {
    throw new Error(`${path} does not look like a settings bundle (malformed "secrets")`)
  }
  return parsed as SettingsBundle
}

export async function writeSettingsBundle(path: string, bundle: SettingsBundle): Promise<void> {
  await writeFile(path, JSON.stringify(bundle, null, 2) + "\n", "utf8")
}
