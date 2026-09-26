/**
 * Zod mirror of `AgentprotoConfig` (`config.ts`) plus a declared registry of
 * every writable key path (`CONFIG_KEYS`) — apply timing, env override,
 * secret/lockout status, and section. `AgentprotoConfig` stays the source of
 * truth (loader/CLI code keeps using the plain interface); this schema exists
 * to VALIDATE what's on disk and to give a future `config_get`/`config_set`
 * (PR-2, see `.plans/agentproto-config/PLAN.md`) one declared surface instead
 * of N bespoke tools.
 *
 * Every object schema is `.passthrough()` so an unknown key survives a
 * validate-then-resave round trip exactly like `loadConfig`/`saveConfig`
 * already preserve unknown keys today (`config.ts:525-526`) — this schema
 * narrows, it never drops.
 */

import { z } from "zod"
import { CatalogProviderSchema } from "@agentproto/model-catalog"
// The browser entry: the same pure URL helpers, without pulling node:crypto in.
import { resolvePairPageUrl, PAIR_WEB_URL } from "@agentproto/secrets/pairing/browser"
import type {
  AgentprotoConfig,
  AcpAgentConfigEntry,
  AgentsMdConfig,
  DaemonConfig,
  FeaturesConfig,
  PairingConfig,
  ProfileConfig,
  ProvenanceConfig,
  SessionsConfig,
  SpawnConfig,
  TerminalPreset,
  TitlerConfig,
  TunnelConfig,
  WorktreesConfig,
} from "./config.js"
import type {
  DefaultsAdapterAuthConfig,
  DefaultsAdapterConfig,
  McpDefaultsConfig,
  SpawnDefaultsConfig,
} from "./spawn-defaults.js"
import type { ContextContinuityPolicy } from "./context-continuity.js"
import type { DeferredToolsConfig } from "./deferred-tools.js"
import type { SpawnBrowserMode } from "./browser-mount.js"

import { DEFAULT_WORKTREE_ISOLATION, WORKTREE_ISOLATION_ENV } from "./worktree-isolation.js"
import { DEFAULT_SPAWN_ATTACH, SPAWN_ATTACH_ENV } from "./spawn-attach.js"
import { DEFAULT_SPAWN_DEDUPE, SPAWN_DEDUPE_ENV } from "./spawn-dedupe.js"
import { DEFAULT_ATTENTION_DELAY_SEC, ATTENTION_DELAY_ENV } from "./session-presence.js"
import { DEFAULT_WRAP_GH, PROVENANCE_WRAP_GH_ENV } from "./gh-provenance-shim.js"
import { DEFAULT_AGENTS_MD_INLINE_MAX_KB } from "./agents-md.js"
import { DEFAULT_TITLER_MODEL } from "./session-titler.js"
import { DEFAULT_BG_TASK_WAKE_GRACE_MS } from "./background-task-wake.js"
import { DEFAULT_ROLE_DEPTH_CUTOFF } from "./role.js"

// ── nested zod schemas, one per `config.ts` / `spawn-defaults.ts` interface ──

const contextContinuityPolicySchema: z.ZodType<ContextContinuityPolicy> = z
  .object({
    mode: z.enum(["manual", "ask", "auto"]).optional(),
    warnAtPct: z.number().optional(),
    compactAtPct: z.number().optional(),
    continueFreshAtPct: z.number().optional(),
    hardStopAtPct: z.number().optional(),
    goal: z.boolean().optional(),
    plan: z.boolean().optional(),
    decisions: z.boolean().optional(),
    changedFiles: z.boolean().optional(),
    gitStatus: z.boolean().optional(),
    tests: z.boolean().optional(),
    errors: z.boolean().optional(),
    risks: z.boolean().optional(),
    nextStep: z.boolean().optional(),
    config: z.boolean().optional(),
    label: z.string().optional(),
  })
  .passthrough()

const deferredToolsConfigSchema: z.ZodType<DeferredToolsConfig> = z.union([
  z.boolean(),
  z.object({ alwaysOn: z.array(z.string()) }).passthrough(),
])

const spawnBrowserModeSchema: z.ZodType<SpawnBrowserMode> = z.union([
  z.literal("headless"),
  z.literal(false),
])

const optionsMapSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]))

const defaultsAdapterAuthConfigSchema: z.ZodType<DefaultsAdapterAuthConfig> = z
  .object({
    mode: z.enum(["subscription", "api-key"]).optional(),
    token: z.string().optional(),
    source: z.string().optional(),
    apiKey: z.string().optional(),
    provider: CatalogProviderSchema.optional(),
  })
  .passthrough()

const defaultsAdapterConfigSchema: z.ZodType<DefaultsAdapterConfig> = z
  .object({
    skills: z.array(z.string()).optional(),
    options: optionsMapSchema.optional(),
    auth: defaultsAdapterAuthConfigSchema.optional(),
    contextContinuity: contextContinuityPolicySchema.optional(),
  })
  .passthrough()

const mcpDefaultsConfigSchema: z.ZodType<McpDefaultsConfig> = z
  .object({
    deferredTools: deferredToolsConfigSchema.optional(),
  })
  .passthrough()

const spawnDefaultsConfigSchema: z.ZodType<SpawnDefaultsConfig> = z
  .object({
    skills: z.array(z.string()).optional(),
    options: optionsMapSchema.optional(),
    adapters: z.record(z.string(), defaultsAdapterConfigSchema).optional(),
    contextContinuity: contextContinuityPolicySchema.optional(),
    defaultRoleDepthCutoff: z.number().optional(),
    maxGrantableDelegation: z.number().optional(),
    langfuseTracing: z.boolean().optional(),
    backgroundTaskWake: z
      .object({ enabled: z.boolean().optional(), graceMs: z.number().optional() })
      .passthrough()
      .optional(),
    traceRedactor: z.string().optional(),
    agentPromptInterrupt: z.boolean().optional(),
    messaging: z
      .object({
        allowSiblings: z.boolean().optional(),
        agentInterrupt: z.enum(["allow", "deny"]).optional(),
      })
      .passthrough()
      .optional(),
    mcp: mcpDefaultsConfigSchema.optional(),
    spawn: z.object({ browser: spawnBrowserModeSchema.optional() }).passthrough().optional(),
  })
  .passthrough()

const daemonConfigSchema: z.ZodType<DaemonConfig> = z
  .object({
    workspace: z.string().optional(),
    port: z.number().optional(),
    bind: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    strictOrigins: z.boolean().optional(),
    label: z.string().optional(),
    authToken: z.string().optional(),
    resumeSessionsOnBoot: z.boolean().optional(),
    idleReapAfterMs: z.number().optional(),
    crashDetectIntervalMs: z.number().optional(),
    restartSweepIntervalMs: z.number().optional(),
    turnStallAfterMs: z.number().optional(),
  })
  .passthrough()

const titlerConfigSchema: z.ZodType<TitlerConfig> = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  })
  .passthrough()

const tunnelConfigSchema: z.ZodType<TunnelConfig> = z
  .object({
    host: z.string().optional(),
    token: z.string().optional(),
    autoconnect: z.boolean().optional(),
    e2e: z.boolean().optional(),
  })
  .passthrough()

const featuresConfigSchema: z.ZodType<FeaturesConfig> = z
  .object({
    pty: z.boolean().optional(),
    llmEndpoint: z.boolean().optional(),
  })
  .passthrough()

const worktreesConfigSchema: z.ZodType<WorktreesConfig> = z
  .object({
    root: z.string().optional(),
    isolation: z.enum(["always", "on-request", "never"]).optional(),
  })
  .passthrough()

const spawnConfigSchema: z.ZodType<SpawnConfig> = z
  .object({
    attach: z.enum(["always", "on-request"]).optional(),
    dedupe: z.enum(["always", "on-request"]).optional(),
  })
  .passthrough()

const provenanceConfigSchema: z.ZodType<ProvenanceConfig> = z
  .object({ wrapGh: z.boolean().optional() })
  .passthrough()

const sessionsConfigSchema: z.ZodType<SessionsConfig> = z
  .object({
    attentionDelaySec: z.number().optional(),
    eventsDir: z.string().optional(),
  })
  .passthrough()

const agentsMdConfigSchema: z.ZodType<AgentsMdConfig> = z
  .object({ inlineMaxKb: z.number().optional() })
  .passthrough()

/** `pairing.pairPage`: a plain http(s) URL, or a template with `{fp}` in the
 *  hostname — the exact check `pair offer --qr` applies (`resolvePairPageUrl`),
 *  run against a sample fingerprint so a bad template is refused at write
 *  time, not at the next offer. */
const pairPageSchema = z.string().superRefine((value, ctx) => {
  try {
    resolvePairPageUrl(value, "0123456789abcdef")
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) })
  }
})

const pairingConfigSchema: z.ZodType<PairingConfig> = z
  .object({
    rendezvous: z.string().optional(),
    autoconnect: z.boolean().optional(),
    pairPage: pairPageSchema.optional(),
  })
  .passthrough()

const profileConfigSchema: z.ZodType<ProfileConfig> = z
  .object({
    daemon: daemonConfigSchema.optional(),
    tunnel: tunnelConfigSchema.optional(),
    features: featuresConfigSchema.optional(),
  })
  .passthrough()

const acpAgentConfigEntrySchema: z.ZodType<AcpAgentConfigEntry> = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    bin: z.string(),
    bin_args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd_flag: z.string().optional(),
    resumable: z.boolean().optional(),
    models: z
      .object({
        default: z.string().optional(),
        allowed: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    provider: z.string().optional(),
    install_hint: z.string().optional(),
  })
  .passthrough()

const terminalPresetSchema: z.ZodType<TerminalPreset> = z
  .object({
    argv: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    workspace: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough()

/**
 * Top-level mirror of `AgentprotoConfig`. `.passthrough()` at every level
 * (including here) means an unknown top-level key round-trips unchanged,
 * matching `AgentprotoConfig`'s own `[unknown: string]: unknown` index
 * signature.
 */
export const agentprotoConfigSchema = z
  .object({
    version: z.number().optional(),
    daemon: daemonConfigSchema.optional(),
    tunnel: tunnelConfigSchema.optional(),
    features: featuresConfigSchema.optional(),
    pairing: pairingConfigSchema.optional(),
    worktrees: worktreesConfigSchema.optional(),
    spawn: spawnConfigSchema.optional(),
    sessions: sessionsConfigSchema.optional(),
    provenance: provenanceConfigSchema.optional(),
    agentsMd: agentsMdConfigSchema.optional(),
    titler: titlerConfigSchema.optional(),
    profiles: z.record(z.string(), profileConfigSchema).optional(),
    activeProfile: z.string().optional(),
    defaults: spawnDefaultsConfigSchema.optional(),
    acpAgents: z.record(z.string(), acpAgentConfigEntrySchema).optional(),
    terminalPresets: z.record(z.string(), terminalPresetSchema).optional(),
  })
  .passthrough()

// ── compile-time drift guard ──
//
// `AgentprotoConfig` (config.ts) stays the source of truth. This checks, per
// top-level block, that the schema's inferred output is assignable to the
// interface — so retyping/removing a field on the schema side without
// updating the interface (or vice versa in a way that narrows the schema)
// fails `pnpm check-types`.
//
// Checked per-block (rather than as one whole-object comparison) because
// `AgentprotoConfig`'s `[unknown: string]: unknown` index signature collapses
// `keyof AgentprotoConfig` to `string | number`, which would make a
// mapped-type-over-`keyof` check vacuous.
//
// Only ONE direction (schema output → interface) is checked. The reverse
// (interface → schema output) turns out not to be meaningfully checkable
// here: every nested object schema is `.passthrough()`'d (by requirement —
// unknown keys must survive), and a `.passthrough()` schema's inferred
// output always carries an implicit `[x: string]: unknown` catchall. That
// catchall structurally satisfies ANY interface shape (every property type
// is assignable to `unknown`), so `AgentprotoConfig[K] extends
// ConfigSchemaOutput[K]` is both vacuous — it can never actually catch "the
// interface grew a field the schema forgot" — AND empirically fails to
// compile even for the most trivial single-field case, for reasons internal
// to how TypeScript resolves a passthrough object's catchall against a
// plain (non-indexed) interface. Since it can't do the job it would be
// there for, it's dropped rather than kept as a check that always passes
// (or always breaks) for reasons unrelated to real drift. The
// `findUnclassifiedConfigPaths` drift TEST (`__tests__/config-schema.test.ts`)
// covers the complementary direction at runtime: every leaf the schema
// itself declares must be classified in `CONFIG_KEYS`.
type ConfigSchemaOutput = z.infer<typeof agentprotoConfigSchema>
type Extends<A, B> = [A] extends [B] ? true : false
type AssertTrue<_T extends true> = void

type ConfigTopLevelKey =
  | "version"
  | "daemon"
  | "tunnel"
  | "features"
  | "pairing"
  | "worktrees"
  | "spawn"
  | "sessions"
  | "provenance"
  | "agentsMd"
  | "titler"
  | "profiles"
  | "activeProfile"
  | "defaults"
  | "acpAgents"
  | "terminalPresets"

type SchemaOutputMatchesInterfaceByKey = {
  [K in ConfigTopLevelKey]: Extends<NonNullable<ConfigSchemaOutput[K]>, NonNullable<AgentprotoConfig[K]>>
}
type AllTrue<T extends Record<string, boolean>> = T[keyof T] extends true ? true : false

type _SchemaOutputMatchesInterface = AssertTrue<AllTrue<SchemaOutputMatchesInterfaceByKey>>

// ── key registry ──
//
// One entry per key path a human or a future `config_get`/`config_set`
// (PR-2) can act on. `path` uses `*` for a record's dynamic key segment
// (`defaults.adapters.*.skills`, `acpAgents.*.bin`) — see `findConfigKey`.
// `schema` validates ONE value at that path, not the whole config.

export type ConfigKeyApply = "hot" | "restart"

export type ConfigKeySection =
  | "wallets"
  | "harnesses"
  | "models"
  | "defaults"
  | "remote"
  | "daemon"
  | "advanced"

export interface ConfigKeyEntry {
  /** Dot-notation path; `*` stands in for a record's dynamic key. */
  path: string
  /** Validates a single value written at this path. */
  schema: z.ZodTypeAny
  /** `"hot"`: re-read from disk at next use (next spawn / next call).
   *  `"restart"`: read once at daemon boot; a write needs a restart to
   *  take effect. */
  apply: ConfigKeyApply
  /** Env var that silently shadows this key's file value, if any. */
  env?: string
  /** The value is credential material — never echoed back in full, only
   *  `{ set }` (see `redactConfigValue`). */
  secret?: true
  /** False for a key that a future config_set must refuse (secret
   *  credential fields and daemon-lockout fields) — hand-edit only. */
  writable: boolean
  section: ConfigKeySection
  label: string
  help: string
  /** Effective default when the key is absent. Omitted when there is no
   *  single default (e.g. the default is conditional, or the daemon
   *  requires the operator to set it explicitly). */
  default?: unknown
}

const bool = z.boolean()
const str = z.string()
const num = z.number()
const strArray = z.array(z.string())

export const CONFIG_KEYS: readonly ConfigKeyEntry[] = [
  // ── daemon ──
  {
    path: "daemon.workspace",
    schema: str,
    apply: "restart",
    writable: true,
    section: "daemon",
    label: "Workspace",
    help: "Absolute path the daemon binds to at boot.",
  },
  {
    path: "daemon.port",
    schema: num,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Port",
    help: "Local HTTP port. Changing this from a UI served BY the daemon can cut the UI off; hand-edit only.",
    default: 18790,
  },
  {
    path: "daemon.bind",
    schema: str,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Bind address",
    help: "Bind address. Lockout: a bad value here can make the daemon unreachable.",
    default: "127.0.0.1",
  },
  {
    path: "daemon.allowedOrigins",
    schema: strArray,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Allowed origins",
    help: "Trusted browser origins for mutating /sessions/* routes, in addition to the hardcoded localhost defaults. Lockout: a bad value can lock a browser UI out.",
  },
  {
    path: "daemon.strictOrigins",
    schema: bool,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Strict origins",
    help: "When true, only origins in allowedOrigins are trusted (no auto-trust of localhost-on-any-port). Lockout: pairs with allowedOrigins.",
    default: false,
  },
  {
    path: "daemon.label",
    schema: str,
    apply: "restart",
    writable: true,
    section: "daemon",
    label: "Server label",
    help: "Label sent in tunnel hello frames.",
  },
  {
    path: "daemon.authToken",
    schema: str,
    apply: "restart",
    secret: true,
    writable: false,
    section: "daemon",
    label: "Auth token",
    help: "Bearer token gating the gateway at boot. Unset ⇒ mode \"none\" (open on loopback). Set via the CLI, never through config_set.",
  },
  {
    path: "daemon.resumeSessionsOnBoot",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "daemon",
    label: "Resume sessions on boot",
    help: "Eagerly re-spawn eligible agent-cli sessions that died from a daemon restart.",
    default: false,
  },
  {
    path: "daemon.idleReapAfterMs",
    schema: num,
    apply: "restart",
    env: "AGENTPROTO_IDLE_REAP_AFTER_MS",
    writable: true,
    section: "daemon",
    label: "Idle reap after (ms)",
    help: "Retire idle agent-cli sessions after this many ms. Unset/0/negative ⇒ the reaper never runs.",
    default: 0,
  },
  {
    path: "daemon.crashDetectIntervalMs",
    schema: num,
    apply: "restart",
    env: "AGENTPROTO_CRASH_DETECT_INTERVAL_MS",
    writable: true,
    section: "daemon",
    label: "Crash-detect interval (ms)",
    help: "Crash-detect sweep interval. Default-on (non-destructive observability); a non-positive value disables it.",
    default: 30_000,
  },
  {
    path: "daemon.restartSweepIntervalMs",
    schema: num,
    apply: "restart",
    env: "AGENTPROTO_RESTART_SWEEP_INTERVAL_MS",
    writable: true,
    section: "daemon",
    label: "Restart-sweep interval (ms)",
    help: "Sweep interval that executes already-scheduled session restarts. Off by default.",
    default: 0,
  },
  {
    path: "daemon.turnStallAfterMs",
    schema: num,
    apply: "restart",
    env: "AGENTPROTO_TURN_STALL_AFTER_MS",
    writable: true,
    section: "daemon",
    label: "Turn-stall threshold (ms)",
    help: "Turn-liveness watchdog threshold. Default-on (non-destructive observability); a non-positive value disables it.",
    default: 300_000,
  },
  {
    path: "sessions.eventsDir",
    schema: str,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Sessions events dir",
    help: "Root directory for per-session transcripts. Lockout: existing transcripts do not move when this changes, and a bad path can break every session reader.",
    default: "~/.agentproto/sessions",
  },
  {
    path: "profiles",
    schema: z.record(str, profileConfigSchema),
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Connection profiles",
    help: "Named daemon/tunnel/features overrides selected via --profile. Lockout in v1: edit the file by hand.",
  },
  {
    path: "activeProfile",
    schema: str,
    apply: "restart",
    writable: false,
    section: "daemon",
    label: "Active profile",
    help: "Profile used when --profile isn't passed. Lockout in v1: edit the file by hand.",
  },

  // ── remote (tunnel + pairing) ──
  {
    path: "tunnel.host",
    schema: str,
    apply: "restart",
    writable: true,
    section: "remote",
    label: "Tunnel host",
    help: "Cloud WS URL. With autoconnect=true, `serve` bootstraps with --connect <host>.",
  },
  {
    path: "tunnel.token",
    schema: str,
    apply: "restart",
    env: "AGENTPROTO_TOKEN",
    secret: true,
    writable: false,
    section: "remote",
    label: "Tunnel token",
    help: "Daemon token presented at the tunnel upgrade. Set via the CLI, never through config_set.",
  },
  {
    path: "tunnel.autoconnect",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "remote",
    label: "Tunnel autoconnect",
    help: "Whether `daemon start` connects the tunnel by default.",
    default: false,
  },
  {
    path: "tunnel.e2e",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "remote",
    label: "Tunnel end-to-end encryption",
    help: "Opt into E2E encryption of the outbound tunnel. Requires tunnel.token.",
    default: false,
  },
  {
    path: "pairing.rendezvous",
    schema: str,
    apply: "restart",
    writable: true,
    section: "remote",
    label: "Pairing rendezvous URL",
    help: "Rendezvous broker WS URL used by pair_offer and autoconnect on boot.",
  },
  {
    path: "pairing.autoconnect",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "remote",
    label: "Pairing autoconnect",
    help: "Open standing rendezvous connections for every persisted pairing on boot.",
    default: true,
  },
  {
    path: "pairing.pairPage",
    schema: pairPageSchema,
    // Read by `pair offer --qr` on every run, not at daemon boot.
    apply: "hot",
    writable: true,
    section: "remote",
    label: "Phone pair page",
    help:
      "Web page the `pair offer --qr` link opens (the offer rides in its URL fragment). A plain " +
      "http(s) URL, or a template with {fp} in the hostname for one origin per daemon, e.g. " +
      "https://{fp}.agentproto.cloud/pair. `--pair-page` overrides it.",
    default: PAIR_WEB_URL,
  },

  // ── models ──
  {
    path: "titler.model",
    schema: str,
    apply: "hot",
    writable: true,
    section: "models",
    label: "Titler model",
    help: "OpenRouter model id used to generate session titles. Requires OPENROUTER_API_KEY.",
    default: DEFAULT_TITLER_MODEL,
  },

  // ── defaults: spawn ──
  {
    path: "defaults.skills",
    schema: strArray,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Default skills",
    help: "Skills auto-applied to every agent_start spawn (unioned with per-adapter skills).",
  },
  {
    path: "defaults.options",
    schema: optionsMapSchema,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Default options",
    help: "AIP-45 options auto-applied to every agent_start spawn.",
  },
  {
    path: "defaults.defaultRoleDepthCutoff",
    schema: num,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Default role depth cutoff",
    help: "Spawn depth at/after which an agent_start with no explicit role defaults to executor rather than supervisor.",
    default: DEFAULT_ROLE_DEPTH_CUTOFF,
  },
  {
    path: "defaults.maxGrantableDelegation",
    schema: num,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Max grantable delegation",
    help: "Caps the delegation level a role pack may self-grant. Unset ⇒ no cap.",
  },
  {
    path: "defaults.spawn.browser",
    schema: spawnBrowserModeSchema,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Default spawn browser mode",
    help: "Default agent_start.browser when neither the call, its role, nor its preset says otherwise.",
    default: false,
  },
  {
    path: "worktrees.root",
    schema: str,
    apply: "hot",
    env: "AGENTPROTO_WORKTREES_ROOT",
    writable: true,
    section: "defaults",
    label: "Worktrees root",
    help: "Absolute path new `worktree new` worktrees are created under.",
    default: "~/.agentproto/worktrees",
  },
  {
    path: "worktrees.isolation",
    schema: z.enum(["always", "on-request", "never"]),
    apply: "hot",
    env: WORKTREE_ISOLATION_ENV,
    writable: true,
    section: "defaults",
    label: "Worktree isolation policy",
    help: "Whether a freshly-spawned agent_start session is isolated into its own git worktree.",
    default: DEFAULT_WORKTREE_ISOLATION,
  },
  {
    path: "spawn.attach",
    schema: z.enum(["always", "on-request"]),
    apply: "hot",
    env: SPAWN_ATTACH_ENV,
    writable: true,
    section: "defaults",
    label: "Spawn attach policy",
    help: "Whether a spawn auto-attaches to its calling session as parent lineage.",
    default: DEFAULT_SPAWN_ATTACH,
  },
  {
    path: "spawn.dedupe",
    schema: z.enum(["always", "on-request"]),
    apply: "hot",
    env: SPAWN_DEDUPE_ENV,
    writable: true,
    section: "defaults",
    label: "Spawn dedupe policy",
    help: "Whether agent_start derives an implicit idempotency key when the caller passes none.",
    default: DEFAULT_SPAWN_DEDUPE,
  },
  {
    path: "provenance.wrapGh",
    schema: bool,
    apply: "hot",
    env: PROVENANCE_WRAP_GH_ENV,
    writable: true,
    section: "defaults",
    label: "gh provenance shim",
    help: "Opt-in gh PATH shim that stamps PR bodies with agentproto provenance.",
    default: DEFAULT_WRAP_GH,
  },
  {
    path: "agentsMd.inlineMaxKb",
    schema: num,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "AGENTS.md inline threshold (KiB)",
    help: "A resolved AGENTS.md strictly under this size is inlined into the spawn prompt; at/above it, a pointer is injected instead.",
    default: DEFAULT_AGENTS_MD_INLINE_MAX_KB,
  },

  // ── defaults: context continuity ──
  {
    path: "defaults.contextContinuity",
    schema: contextContinuityPolicySchema,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Default context-continuity policy",
    help: "Global context-continuity policy fragment (mode + thresholds + checkpoint sections). Validated as one cross-field unit.",
  },

  // ── defaults: observability ──
  {
    path: "titler.enabled",
    schema: bool,
    apply: "hot",
    writable: true,
    section: "defaults",
    label: "Session titler enabled",
    help: "Generate a short title from the first completed turn of eligible sessions. Default off.",
    default: false,
  },
  {
    path: "defaults.langfuseTracing",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Langfuse tracing default",
    help: "Default per-session Langfuse tracing opt-in when agent_start omits `trace`.",
    default: false,
  },
  {
    path: "defaults.traceRedactor",
    schema: str,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Trace redactor",
    help: "Redactor slug applied to traced session content before it reaches Langfuse.",
    default: "secrets",
  },
  {
    path: "sessions.attentionDelaySec",
    schema: num,
    apply: "hot",
    env: ATTENTION_DELAY_ENV,
    writable: true,
    section: "defaults",
    label: "Attention delay (s)",
    help: "How long a session stays shown as \"running\" after its last turn ends before settling to attention/quiet.",
    default: DEFAULT_ATTENTION_DELAY_SEC,
  },
  {
    path: "defaults.mcp.deferredTools",
    schema: deferredToolsConfigSchema,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Deferred MCP tools",
    help: "Gateway-wide lazy tools/list loading. false/absent ⇒ eager (today's behaviour).",
    default: false,
  },
  {
    path: "defaults.backgroundTaskWake.enabled",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Background-task wake enabled",
    help: "Wake an idle agent session when one of its background tasks settles.",
    default: true,
  },
  {
    path: "defaults.backgroundTaskWake.graceMs",
    schema: num,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Background-task wake grace (ms)",
    help: "How long the daemon waits for the agent to wake itself before prompting it.",
    default: DEFAULT_BG_TASK_WAKE_GRACE_MS,
  },

  // ── defaults: messaging ──
  {
    path: "defaults.agentPromptInterrupt",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Default agent_prompt interrupt",
    help: "Default `interrupt` applied when agent_prompt/message_parent leaves it unset.",
    default: false,
  },
  {
    path: "defaults.messaging.allowSiblings",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Allow sibling messaging",
    help: "Let message_send/message_reply reach a sibling session (same parent).",
    default: false,
  },
  {
    path: "defaults.messaging.agentInterrupt",
    schema: z.enum(["allow", "deny"]),
    apply: "restart",
    writable: true,
    section: "defaults",
    label: "Agent-sender interrupt urgency",
    help: "Whether a SESSION sender may use urgency \"interrupt\" (vs. downgraded to \"steer\").",
    default: "deny",
  },

  // ── harnesses: per-adapter defaults ──
  {
    path: "defaults.adapters.*.skills",
    schema: strArray,
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter default skills",
    help: "Skills auto-applied to spawns of this adapter (unioned with the global default).",
  },
  {
    path: "defaults.adapters.*.options",
    schema: optionsMapSchema,
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter default options",
    help: "AIP-45 options auto-applied to spawns of this adapter.",
  },
  {
    path: "defaults.adapters.*.contextContinuity",
    schema: contextContinuityPolicySchema,
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter context-continuity policy",
    help: "Per-adapter context-continuity policy fragment, overriding the global default. Validated as one cross-field unit.",
  },
  {
    path: "defaults.adapters.*.auth.mode",
    schema: z.enum(["subscription", "api-key"]),
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter auth mode",
    help: "\"subscription\" or \"api-key\". Omitted ⇒ resolver picks by ordered preference.",
  },
  {
    path: "defaults.adapters.*.auth.token",
    schema: str,
    apply: "hot",
    secret: true,
    writable: false,
    section: "harnesses",
    label: "Adapter subscription token",
    help: "Subscription bearer token. Wallet secrets belong in auth profiles; this field is not writable through config_set.",
  },
  {
    path: "defaults.adapters.*.auth.source",
    schema: str,
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter subscription source",
    help: "Opt-in self-refreshing subscription source, e.g. \"claude-code-oauth\".",
  },
  {
    path: "defaults.adapters.*.auth.apiKey",
    schema: str,
    apply: "hot",
    secret: true,
    writable: false,
    section: "harnesses",
    label: "Adapter API key",
    help: "Explicit API key for \"api-key\" mode. Wallet secrets belong in auth profiles; this field is not writable through config_set.",
  },
  {
    path: "defaults.adapters.*.auth.provider",
    schema: CatalogProviderSchema,
    apply: "hot",
    writable: true,
    section: "harnesses",
    label: "Adapter auth provider pin",
    help: "Per-adapter provider pin, overriding the adapter's fixed/model-derived provider.",
  },

  // ── harnesses: user ACP agents ──
  //
  // Every leaf here is `writable: false`: these fields name a BINARY, argv,
  // and environment that the daemon executes on the host, the same reasoning
  // that keeps `adapter_install` off the app surface (PLAN.md Q6). The write
  // path in v1 is the CLI (`agentproto acp add/rm`, which is exempt from this
  // flag entirely) or a hand edit, never a future config_set.
  {
    path: "acpAgents.*.name",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent display name",
    help: "Display name. Defaults to the slug when omitted. Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.description",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent description",
    help: "One-line description surfaced in `acp ls`. Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.bin",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent executable",
    help: "Executable the daemon spawns on the host. Set via `agentproto acp add`; not writable through config_set.",
  },
  {
    path: "acpAgents.*.bin_args",
    schema: strArray,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent argv",
    help: "Extra argv appended after `bin`. Set via `agentproto acp add`; not writable through config_set.",
  },
  {
    path: "acpAgents.*.env",
    schema: z.record(str, str),
    apply: "hot",
    secret: true,
    writable: false,
    section: "harnesses",
    label: "ACP agent environment",
    help: "Extra environment variables for the spawned process; values may hold secrets, so a reader redacts them. Set via `agentproto acp add`; not writable through config_set.",
  },
  {
    path: "acpAgents.*.cwd_flag",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent cwd flag",
    help: "Flag the CLI uses to receive the working directory, if it needs one passed explicitly. Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.resumable",
    schema: bool,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent resumable",
    help: "Advertise resumable + native-resume continuation. Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.models.default",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent default model",
    help: "Known default model id (informational + validation hint). Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.models.allowed",
    schema: strArray,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent allowed models",
    help: "Known allowed model ids (informational + validation hint). Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.provider",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent billing provider",
    help: "Billing endpoint this CLI's own auth bills, if a single known one applies. Set via `agentproto acp add`.",
  },
  {
    path: "acpAgents.*.install_hint",
    schema: str,
    apply: "hot",
    writable: false,
    section: "harnesses",
    label: "ACP agent install hint",
    help: "Shown when `bin` is missing from PATH. Set via `agentproto acp add`.",
  },

  // ── advanced: terminal/TUI presets ──
  //
  // Same reasoning as the ACP agents above: `writable: false` on every leaf,
  // since these name a command, argv, and environment run on the host. The
  // write path in v1 is `agentproto config set` (exempt from this flag) or a
  // hand edit, never a future config_set.
  {
    path: "terminalPresets.*.argv",
    schema: strArray,
    apply: "hot",
    writable: false,
    section: "advanced",
    label: "Terminal preset argv",
    help: "Command + args to spawn. Not writable through config_set; set via `agentproto config set` or a hand edit.",
  },
  {
    path: "terminalPresets.*.env",
    schema: z.record(str, str),
    apply: "hot",
    secret: true,
    writable: false,
    section: "advanced",
    label: "Terminal preset environment",
    help: "Extra environment variables layered on the daemon's inherited env; values may hold secrets, so a reader redacts them. Not writable through config_set.",
  },
  {
    path: "terminalPresets.*.cwd",
    schema: str,
    apply: "hot",
    writable: false,
    section: "advanced",
    label: "Terminal preset cwd",
    help: "Working directory for the PTY session. Not writable through config_set.",
  },
  {
    path: "terminalPresets.*.workspace",
    schema: str,
    apply: "hot",
    writable: false,
    section: "advanced",
    label: "Terminal preset workspace",
    help: "Workspace slug used for cwd fallback when `cwd` is omitted. Not writable through config_set.",
  },
  {
    path: "terminalPresets.*.name",
    schema: str,
    apply: "hot",
    writable: false,
    section: "advanced",
    label: "Terminal preset session name",
    help: "Stable session name passed to the registry. Not writable through config_set.",
  },
  {
    path: "terminalPresets.*.label",
    schema: str,
    apply: "hot",
    writable: false,
    section: "advanced",
    label: "Terminal preset label",
    help: "Human-readable label surfaced in session listings. Not writable through config_set.",
  },

  // ── daemon-adjacent (no dedicated UI section yet — features toggles) ──
  {
    path: "features.pty",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "daemon",
    label: "PTY feature hint",
    help: "Informational hint that PTY is desired; the daemon still detects node-pty's presence at runtime.",
  },
  {
    path: "features.llmEndpoint",
    schema: bool,
    apply: "restart",
    writable: true,
    section: "daemon",
    label: "LLM Endpoint feature",
    help: "Enable the local LLM Endpoint proxy sidecar (route + MCP tools + child-process lifecycle).",
    default: false,
  },
] as const

/** Keys the schema declares that are deliberately NOT in {@link CONFIG_KEYS}
 *  — every leaf the drift test finds must land in one list or the other. */
export interface ConfigKeyNotExposedEntry {
  path: string
  reason: string
}

export const CONFIG_KEYS_NOT_EXPOSED: readonly ConfigKeyNotExposedEntry[] = [
  {
    path: "version",
    reason:
      "internal schema-version stamp; saveConfig() always overwrites it with CONFIG_VERSION on every write, never a user knob.",
  },
]

// ── helpers ──

function pathSegmentsMatch(entryPath: string, concretePath: string): boolean {
  const entrySegs = entryPath.split(".")
  const concreteSegs = concretePath.split(".")
  if (entrySegs.length !== concreteSegs.length) return false
  return entrySegs.every((seg, i) => seg === "*" || seg === concreteSegs[i])
}

/** Look up a `CONFIG_KEYS` entry for a concrete dotted path (e.g.
 *  `defaults.adapters.claude-code.skills`), matching any `*` wildcard
 *  segment. Returns `undefined` for a path with no registered entry. */
export function findConfigKey(path: string): ConfigKeyEntry | undefined {
  return CONFIG_KEYS.find(entry => pathSegmentsMatch(entry.path, path))
}

function isKnownConfigPath(path: string): boolean {
  return (
    CONFIG_KEYS.some(entry => entry.path === path) ||
    CONFIG_KEYS_NOT_EXPOSED.some(entry => entry.path === path)
  )
}

/** Just enough of zod v4's internal `_def` shape to walk the schema tree —
 *  `type` is the discriminant (`"object"`, `"record"`, `"optional"`, …). */
interface ZodInternalDef {
  type: string
  innerType?: z.ZodTypeAny
  valueType?: z.ZodTypeAny
}

function defOf(schema: z.ZodTypeAny): ZodInternalDef {
  return (schema as unknown as { _def: ZodInternalDef })._def
}

/** Unwrap a schema wrapper that doesn't change the underlying shape for
 *  enumeration purposes, so `defOf` sees the real `"object"`/`"record"`/leaf
 *  discriminant underneath. */
function unwrapForWalk(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema
  let def = defOf(current)
  while (def.type === "optional" || def.type === "nullable" || def.type === "default") {
    current = def.innerType as z.ZodTypeAny
    def = defOf(current)
  }
  return current
}

/**
 * Walk the schema and return every leaf path that has NEITHER a
 * {@link CONFIG_KEYS} entry NOR a {@link CONFIG_KEYS_NOT_EXPOSED} entry.
 * A record (`z.record`) contributes one `*` path segment and the walk
 * continues into its value schema; any path already classified (exact
 * match, including a classified record-of-object like `profiles` or
 * `defaults.contextContinuity`) is treated as an intentionally opaque unit
 * and is NOT descended into further. Exported so the drift test (and any
 * future tooling) can call it directly against {@link agentprotoConfigSchema}.
 */
export function findUnclassifiedConfigPaths(
  schema: z.ZodTypeAny = agentprotoConfigSchema,
): string[] {
  const unclassified: string[] = []

  function walk(node: z.ZodTypeAny, path: string): void {
    if (path !== "" && isKnownConfigPath(path)) return
    const unwrapped = unwrapForWalk(node)
    const def = defOf(unwrapped)
    if (def.type === "object") {
      const shape = (unwrapped as z.ZodObject).shape
      for (const [key, child] of Object.entries(shape)) {
        walk(child as z.ZodTypeAny, path ? `${path}.${key}` : key)
      }
      return
    }
    if (def.type === "record") {
      walk(def.valueType as z.ZodTypeAny, path ? `${path}.*` : "*")
      return
    }
    if (path !== "") unclassified.push(path)
  }

  walk(schema, "")
  return unclassified
}

export interface ConfigValidationResult {
  ok: boolean
  issues: string[]
}

/** Validate a whole config object against {@link agentprotoConfigSchema}.
 *  Never throws — returns the list of human-readable issues on failure. */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const result = agentprotoConfigSchema.safeParse(raw)
  if (result.success) return { ok: true, issues: [] }
  const issues = result.error.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
    return `${path}: ${issue.message}`
  })
  return { ok: false, issues }
}

export interface ConfigKeyValueValidationResult {
  ok: boolean
  error?: string
}

/**
 * Validate a single value's TYPE against the registry entry's schema for
 * `path` — no writability check. An unregistered path is accepted
 * (`ok: true`); the CLI (`agentproto config set`, the owner's own
 * escape hatch) uses this, not {@link validateConfigKeyValue}, because
 * `writable` is a policy for the future MCP/app surface, not for the local
 * CLI.
 */
export function validateConfigKeyType(path: string, value: unknown): ConfigKeyValueValidationResult {
  const entry = findConfigKey(path)
  if (!entry) return { ok: true }
  const result = entry.schema.safeParse(value)
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map(issue => issue.message).join("; "),
    }
  }
  return { ok: true }
}

/**
 * Validate a single value against the registry entry for `path`: type AND
 * writability. For the future MCP/app `config_set` surface, which must
 * refuse secret and lockout keys outright (`writable: false`) — the local
 * CLI is exempt from this and uses {@link validateConfigKeyType} instead.
 * An unregistered path is accepted (`ok: true`).
 */
export function validateConfigKeyValue(path: string, value: unknown): ConfigKeyValueValidationResult {
  const entry = findConfigKey(path)
  if (!entry) return { ok: true }
  if (!entry.writable) {
    return {
      ok: false,
      error: `"${path}" is not writable (${entry.secret ? "secret; set it via the CLI/auth profiles" : "lockout; edit ~/.agentproto/config.json by hand"}).`,
    }
  }
  return validateConfigKeyType(path, value)
}

/**
 * Redact a value read from a secret key path. Fingerprinting is deferred to
 * a later PR (see `@agentproto/auth`'s `credentialIdentity`) — for now this
 * only ever reveals whether a value is SET, never any part of it. A
 * non-secret path (or a path with no registry entry) is returned unchanged.
 */
export function redactConfigValue(path: string, value: unknown): unknown {
  const entry = findConfigKey(path)
  if (!entry?.secret) return value
  if (value === undefined) return { set: false }
  if (typeof value === "string") return { set: value.length > 0 }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        { set: typeof v === "string" && v.length > 0 },
      ]),
    )
  }
  return { set: true }
}
