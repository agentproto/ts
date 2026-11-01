/**
 * The `auto` sandbox provider — a COMPOSITE over the existing `computer` and
 * `e2b` handles, not a new backend.
 *
 * It exists for one reason: the self-hosted `computer` fleet can run out of
 * host capacity (a body-coded capacity refusal), and an operator who would
 * rather take a cloud box than fail the spawn can opt into a one-way overflow
 * to e2b. The overflow is deliberately narrow:
 *
 *   - OFF by default (`config.overflow.enabled`): an operator opts into
 *     spending money on e2b, and every call is bounded by the safety rails
 *     below.
 *   - ONLY for a body-coded capacity refusal (`isCapacityRefusal`): never for
 *     auth/validation/conflict errors, a boot timeout, a permanent budget
 *     verdict, or a transport failure — a create that timed out may already
 *     have landed, so retrying elsewhere could double-provision and double-bill.
 *   - NEVER on a resume/reuse: the box already exists at exactly one provider,
 *     and an empty box at the other is worse than a clear failure. The ledger
 *     row is the authority for that provider.
 *   - Never retries `computer` after an overflow attempt fails: the caller gets
 *     the e2b error with the original computer error attached.
 *
 * Safety rails (all fail closed) sit between the capacity refusal and the
 * e2b call: residency, daily box/EUR caps, an explicit secret allowlist, a
 * template CLI-version parity check, and a `timeoutMs` ceiling priced from
 * `maxEurPerBox`. The per-box EUR cap is a CUMULATIVE wall-clock deadline
 * shared by boot, every `extendTimeout` re-arm, and a resume in the same
 * daemon process. Daily caps are best-effort and daemon-global. A refusal is
 * a typed `sandbox_overflow_refused` error that records the choice and keeps
 * the computer error as its cause.
 *
 * Secrets: the caller's `SandboxBootOpts.env` (already broker-resolved by
 * `@agentproto/sandbox`) is forwarded to the computer leg unchanged; the e2b
 * leg receives only names on an explicit allowlist. This module never reads a
 * secret from `process.env` and never logs a secret name or value.
 */

import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxProvider,
  SandboxProviderChoice,
  SandboxSpec,
  SandboxUsageWindow,
} from "@agentproto/sandbox"

import type { SandboxLedgerEntry } from "../sandbox-ledger.js"
import { readSandboxLedger } from "../sandbox-ledger.js"
import type { SandboxProviderCapabilities, SandboxProviderHandle } from "./types.js"

/** Concrete backends this provider can compose. */
export type AutoConcreteProvider = "computer" | "e2b"

/** Overflow safety rails. Every numeric cap is validated before the e2b
 *  call: an absent field takes the documented default, a present but
 *  malformed one refuses the overflow (never "unlimited"). */
export interface AutoOverflowConfig {
  enabled?: boolean
  /** Boxes already started today (UTC) before refusing another. */
  maxBoxesPerDay?: number
  /** EUR already spent on e2b today (UTC) before refusing another. */
  maxEurPerDay?: number
  /** Per-box EUR budget. Converted into a CUMULATIVE e2b lifetime ceiling:
   *  the initial `timeoutMs`, every `extendTimeout` re-arm, and a resume all
   *  share one deadline (per daemon process, see `capBootedLifetime`). */
  maxEurPerBox?: number
  /** Master switch for forwarding any broker-resolved secret to e2b. */
  allowSecrets?: boolean
  /** The ONLY secret names the e2b leg may receive. Unknown names refuse. */
  secretAllowlist?: readonly string[]
}

/** Per-leg config, read from `agent_start.sandbox.config`. */
export interface AutoSandboxConfig {
  /** Extra `computer` config, merged over the leg's own config. */
  computer?: Record<string, unknown>
  /** Fleet connection, mapped onto the computer leg's controller config. */
  fleet?: { url?: string; token?: string; tenantId?: string }
  /** Extra `e2b` config (size/template/timeout). */
  e2b?: { size?: string; template?: string; timeoutMs?: number; cliVersion?: string }
  /** `"eu-ovh"` pins the box to the self-hosted fleet (computer only).
   *  Defaults to `AGENTPROTO_TENANT_RESIDENCY`, then `"any"`. */
  residency?: "any" | "eu-ovh" | string
  /** Overflow is opt-in; absent/false means a capacity refusal is returned
   *  unchanged. Caps and the secret allowlist only apply when enabled. */
  overflow?: AutoOverflowConfig
}

/** Thrown when an enabled overflow is refused by one of the safety rails
 *  BEFORE the e2b call. `reason` is operator-facing but never contains a
 *  secret name or value. */
export class SandboxOverflowRefusedError extends Error {
  readonly code = "sandbox_overflow_refused"
  readonly reason: string
  /** The attempted choice, with the refusal recorded as its reason. */
  readonly choice?: SandboxProviderChoice

  constructor(
    reason: string,
    info: { cause?: unknown; choice?: SandboxProviderChoice } = {},
  ) {
    super(`auto sandbox: overflow refused (${reason})`)
    this.name = "SandboxOverflowRefusedError"
    this.reason = reason
    if (info.cause !== undefined) this.cause = info.cause
    if (info.choice !== undefined) this.choice = info.choice
  }
}

const DEFAULT_MAX_BOXES_PER_DAY = 10
const DEFAULT_MAX_EUR_PER_DAY = 25
const DEFAULT_MAX_EUR_PER_BOX = 2

const AUTO_KEYS = new Set(["computer", "fleet", "e2b", "residency", "overflow"])

const AUTO_CAPABILITIES: SandboxProviderCapabilities = {
  networkEgress: true,
  mounts: false,
  lifecyclePause: true,
  readOnly: false,
  exec: true,
  // The overflow leg (e2b) is not shareable between sessions; a caller that
  // needs that must pin `computer` itself.
  sharedSessions: false,
}

export interface AutoSandboxProviderDeps {
  /** Resolve a concrete provider handle (`computer` or `e2b`). Injected by
   *  the registry so `auto` reuses the same import/probe path as a direct
   *  slug, including that slug's own stored credentials. */
  resolveProvider: (slug: AutoConcreteProvider) => Promise<SandboxProviderHandle | null>
  /** Ledger reader, injectable for tests. Defaults to the daemon ledger. */
  ledger?: () => readonly SandboxLedgerEntry[]
  /** Clock, injectable for tests. */
  now?: () => Date
  /** Environment, only for the residency default. Injectable for tests. */
  env?: NodeJS.ProcessEnv
  /** e2b metadata/pricing loader, injectable for tests. Defaults to the
   *  lazy dynamic import of the optional `@agentproto/sandbox-e2b` package. */
  loadE2bLimits?: () => Promise<E2bLimitsModule>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readAutoConfig = (spec: SandboxSpec): AutoSandboxConfig => {
  const config = isRecord(spec.config) ? spec.config : {}
  return config as AutoSandboxConfig
}

/** The spec config shared by both legs, with `auto`'s own control keys
 *  stripped so a concrete provider never mistakes them for its own config. */
const baseConfig = (config: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!AUTO_KEYS.has(key)) out[key] = value
  }
  return out
}

const computerConfig = (config: AutoSandboxConfig): Record<string, unknown> => {
  const raw = isRecord(config) ? config : {}
  const base = baseConfig(raw)
  const fleet = isRecord(config.fleet) ? config.fleet : undefined
  return {
    ...base,
    ...(fleet?.url ? { controllerUrl: fleet.url } : {}),
    ...(fleet?.token ? { token: fleet.token } : {}),
    ...(fleet?.tenantId ? { tenantId: fleet.tenantId } : {}),
    ...(isRecord(config.computer) ? config.computer : {}),
  }
}

const e2bConfig = (
  config: AutoSandboxConfig,
  timeoutMs?: number,
): Record<string, unknown> => ({
  ...baseConfig(isRecord(config) ? config : {}),
  ...(isRecord(config.e2b) ? config.e2b : {}),
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
})

const specFor = (
  spec: SandboxSpec,
  slug: AutoConcreteProvider,
  config: AutoSandboxConfig,
  e2bTimeoutMs?: number,
): SandboxSpec => ({
  ...spec,
  provider: slug,
  config:
    slug === "computer" ? computerConfig(config) : e2bConfig(config, e2bTimeoutMs),
})

/** Effective residency: explicit config wins, then the host policy env, then
 *  `"any"`. An empty value is treated as unset. */
const resolveResidency = (
  config: AutoSandboxConfig,
  env: NodeJS.ProcessEnv,
): string => {
  const configured =
    config.residency ?? env.AGENTPROTO_TENANT_RESIDENCY ?? undefined
  if (configured === undefined) return "any"
  if (typeof configured !== "string") return "invalid"
  return configured.trim() === "" ? "any" : configured
}

/** Why this spawn may ONLY run on the self-hosted computer, if it may. */
const computerOnlyReason = (
  spec: SandboxSpec,
  config: AutoSandboxConfig,
  residency: string,
): string | undefined => {
  if (residency !== "any") {
    // Fail safe: only the two understood values may overflow. Any other
    // residency (known to a later policy, or a typo) pins to computer rather
    // than silently placing the box in a region the caller did not ask for.
    return residency === "eu-ovh" ? "residency eu-ovh" : "residency requires computer"
  }
  const egressIp = spec.network?.egressIp
  if (egressIp !== undefined && egressIp !== "shared") return "dedicated egressIp"
  const computer = isRecord(config.computer) ? config.computer : {}
  if (computer.daemonRoute === true) return "computer-only daemon route"
  if (typeof computer.gatewayUrl === "string" && computer.gatewayUrl.length > 0) {
    return "computer-only gateway"
  }
  if (computer.sharedSessions === true) return "shared sessions require computer"
  return undefined
}

const capacityReason = (err: unknown): string => {
  const code =
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined
  return code ? `capacity refusal (${code})` : "capacity refusal"
}

/** `major.minor.patch[-prerelease]` of the first version-looking token, for
 *  the template parity check. A partial pin yields null and never matches. */
const semverCore = (text: string): string | null => {
  const match = /(?:^|[^0-9.])(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(?![.\d])/.exec(text)
  return match ? (match[1] as string) + (match[2] ?? "") : null
}

/** An absent cap takes the default; a present but malformed one returns null,
 *  which the caller turns into a refusal (fail closed, never unlimited). */
const readCap = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

interface E2bPricingLike {
  usdPerVcpuHour: number
  usdPerGibHour: number
  eurPerUsd: number
}

interface E2bSizeLike {
  cpuCount: number
  memoryMb: number
  id: string | null
  alias?: string
  baked: { cli: string | null }
}

interface E2bTemplateLike {
  id: string | null
  alias?: string
  baked: { cli: string | null }
}

/** The slice of `@agentproto/sandbox-e2b` the rails need. Exported so tests
 *  can inject a synthetic pricing/template table without the real package. */
export interface E2bLimitsModule {
  DEFAULT_SIZE: string
  DEFAULT_TEMPLATE: string
  DEFAULT_SANDBOX_TIMEOUT_MS: number
  SIZES: Record<string, E2bSizeLike>
  TEMPLATES: Record<string, E2bTemplateLike>
  resolveE2bPricing: () => E2bPricingLike | null
}

/** Load the CONCRETE e2b package lazily: it is an optional dependency and the
 *  registry imports this module eagerly. */
const loadE2bLimits = async (): Promise<E2bLimitsModule> =>
  (await import("@agentproto/sandbox-e2b")) as unknown as E2bLimitsModule

/** The size preset the box will be created at, when it can be priced.
 *
 *  Named templates are allowed for overflow ONLY when they map to a known
 *  published image whose size is known: a size preset (by id or alias), the
 *  default channel template (built at `DEFAULT_SIZE`), or a named channel
 *  (`stable`/`dev`, also built at `DEFAULT_SIZE`). An arbitrary custom
 *  template has no recorded size, so it cannot be priced against
 *  `maxEurPerBox` and is refused rather than run uncapped. */
const resolveSize = (
  config: AutoSandboxConfig,
  limits: E2bLimitsModule,
): E2bSizeLike | null => {
  if (!limits.SIZES) return null
  const explicitSize = config.e2b?.size
  if (explicitSize !== undefined) return limits.SIZES[explicitSize] ?? null
  const template = config.e2b?.template
  if (template === undefined) return limits.SIZES[limits.DEFAULT_SIZE] ?? null
  if (template === limits.DEFAULT_TEMPLATE) {
    return limits.SIZES[limits.DEFAULT_SIZE] ?? null
  }
  const sizePreset = Object.values(limits.SIZES).find(
    entry =>
      (entry.id !== null && entry.id === template) ||
      (entry.alias !== undefined && entry.alias === template),
  )
  if (sizePreset !== undefined) return sizePreset
  const namedChannel = limits.TEMPLATES
    ? Object.values(limits.TEMPLATES).find(
        entry =>
          (entry.id !== null && entry.id === template) ||
          (entry.alias !== undefined && entry.alias === template),
      )
    : undefined
  // Both named channels are built at DEFAULT_SIZE (templates/workstation).
  return namedChannel !== undefined
    ? (limits.SIZES[limits.DEFAULT_SIZE] ?? null)
    : null
}

/** The template id the e2b provider will ACTUALLY boot, mirroring its own
 *  `resolveTemplate`: explicit template, else the size preset, else the bare
 *  default template. Exported for the template-default parity test. */
export const templateIdForParity = (
  config: AutoSandboxConfig,
  limits: E2bLimitsModule,
): string | undefined => {
  if (config.e2b?.template !== undefined) return config.e2b.template
  if (config.e2b?.size !== undefined) {
    return resolveSize(config, limits)?.id ?? undefined
  }
  return limits.DEFAULT_TEMPLATE
}

/** Cap the e2b lifetime so the box cannot spend more than `maxEurPerBox`.
 *  Pricing or size that cannot be resolved refuses the overflow.
 *
 *  Returns both the initial `timeoutMs` (never above the cap) and
 *  `maxLifetimeMs`, the CUMULATIVE wall-clock ceiling the returned sandbox is
 *  wrapped with. Wall clock is a conservative proxy for billed running time:
 *  it also counts paused intervals, so the cap can only under-spend. */
const capTimeoutMs = async (
  config: AutoSandboxConfig,
  overflow: AutoOverflowConfig,
  loadLimits: () => Promise<E2bLimitsModule>,
): Promise<{ timeoutMs: number; maxLifetimeMs: number } | { reason: string }> => {
  const capEur = readCap(overflow.maxEurPerBox, DEFAULT_MAX_EUR_PER_BOX)
  if (capEur === null) return { reason: "maxEurPerBox is not a positive number" }

  let limits: E2bLimitsModule
  try {
    limits = await loadLimits()
  } catch {
    return { reason: "e2b pricing is unavailable" }
  }
  if (typeof limits.resolveE2bPricing !== "function" || !limits.SIZES) {
    return { reason: "e2b pricing is unavailable" }
  }
  let pricing: E2bPricingLike | null
  try {
    pricing = limits.resolveE2bPricing()
  } catch {
    return { reason: "e2b pricing is unknown" }
  }
  if (pricing === null) return { reason: "e2b pricing is unknown" }
  const size = resolveSize(config, limits)
  if (size === null) return { reason: "e2b box size is unknown" }
  if (
    !Number.isFinite(size.cpuCount) ||
    !Number.isFinite(size.memoryMb) ||
    size.cpuCount < 0 ||
    size.memoryMb < 0
  ) {
    return { reason: "e2b box size is unknown" }
  }

  const eurPerMs =
    ((size.cpuCount * pricing.usdPerVcpuHour +
      (size.memoryMb / 1024) * pricing.usdPerGibHour) *
      pricing.eurPerUsd) /
    3_600_000
  if (!Number.isFinite(eurPerMs) || eurPerMs <= 0) {
    return { reason: "e2b pricing is unknown" }
  }
  const maxMs = Math.floor(capEur / eurPerMs)
  if (maxMs <= 0) return { reason: "maxEurPerBox is too small for this box size" }

  const defaultTimeout =
    typeof limits.DEFAULT_SANDBOX_TIMEOUT_MS === "number" &&
    Number.isFinite(limits.DEFAULT_SANDBOX_TIMEOUT_MS) &&
    limits.DEFAULT_SANDBOX_TIMEOUT_MS > 0
      ? limits.DEFAULT_SANDBOX_TIMEOUT_MS
      : 45 * 60_000
  const requested =
    typeof config.e2b?.timeoutMs === "number" &&
    Number.isFinite(config.e2b.timeoutMs) &&
    config.e2b.timeoutMs > 0
      ? config.e2b.timeoutMs
      : defaultTimeout
  return { timeoutMs: Math.min(requested, maxMs), maxLifetimeMs: maxMs }
}

/** Compare the recorded CLI bake of the template the provider will actually
 *  boot with the CLI pin the caller expects (the controller's `cliVersion`,
 *  else e2b's own). A template with no recorded bake is unknown and refuses,
 *  never "assume it matches". */
const templateParityIssue = async (
  config: AutoSandboxConfig,
  loadLimits: () => Promise<E2bLimitsModule>,
): Promise<string | undefined> => {
  const computerConfig = isRecord(config.computer) ? config.computer : {}
  const e2bCliVersion =
    typeof config.e2b?.cliVersion === "string" && config.e2b.cliVersion !== ""
      ? config.e2b.cliVersion
      : undefined
  const controllerCliVersion =
    typeof computerConfig.cliVersion === "string" && computerConfig.cliVersion !== ""
      ? computerConfig.cliVersion
      : undefined
  const expected = e2bCliVersion ?? controllerCliVersion
  if (expected === undefined) return undefined

  let limits: E2bLimitsModule
  try {
    limits = await loadLimits()
  } catch {
    return "e2b template metadata is unavailable"
  }
  if (!limits.TEMPLATES || !limits.SIZES) {
    return "e2b template metadata is unavailable"
  }
  const templateId = templateIdForParity(config, limits)
  if (templateId === undefined) return "e2b template CLI version is unknown"
  const entries: Array<E2bSizeLike | E2bTemplateLike> = [
    ...Object.values(limits.TEMPLATES),
    ...Object.values(limits.SIZES),
  ]
  const recorded = entries.find(entry => entry.id !== null && entry.id === templateId)?.baked
    ?.cli
  if (recorded === null || recorded === undefined) {
    return "e2b template CLI version is unknown"
  }
  const want = semverCore(expected)
  const have = semverCore(recorded)
  if (want === null || have === null || want !== have) {
    return "e2b template CLI version does not match the controller's"
  }
  return undefined
}

/** Gate the e2b leg's env on an explicit allowlist. Any secret that is not
 *  allowed refuses the overflow rather than silently producing a box missing
 *  the credentials it needs. */
const selectOverflowSecrets = (
  env: Record<string, string>,
  overflow: AutoOverflowConfig,
): { env: Record<string, string> } | { reason: string } => {
  const keys = Object.keys(env)
  if (overflow.allowSecrets !== true) {
    return keys.length === 0 ? { env: {} } : { reason: "secrets are not allowed" }
  }
  const allowed = (Array.isArray(overflow.secretAllowlist) ? overflow.secretAllowlist : []).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  )
  if (allowed.length === 0) {
    return keys.length === 0 ? { env: {} } : { reason: "secret allowlist is missing" }
  }
  const allowedSet = new Set(allowed)
  if (keys.some(name => !allowedSet.has(name))) {
    return { reason: "a secret is not on the allowlist" }
  }
  if (allowed.some(name => !(name in env))) {
    return { reason: "an allowlisted secret is missing" }
  }
  const selected: Record<string, string> = {}
  for (const name of allowed) selected[name] = env[name] as string
  return { env: selected }
}

/** Wrap a booted e2b box so EVERY `extendTimeout` re-arm is clamped to one
 *  cumulative deadline. Without this the initial `timeoutMs` cap would only
 *  bound one arm; the session proxy re-arms on prompt dispatch and every 10
 *  minutes, which could spend far past `maxEurPerBox`. */
const capBootedLifetime = (
  booted: BootedSandbox,
  deadlineMs: number,
  clock: () => Date,
): BootedSandbox => {
  const extend = booted.extendTimeout
  if (!extend) return booted
  return {
    ...booted,
    lifetimeMs: Math.max(0, deadlineMs - clock().getTime()),
    async extendTimeout(ms: number): Promise<void> {
      const remaining = deadlineMs - clock().getTime()
      if (remaining <= 0) {
        throw new SandboxOverflowRefusedError("maxEurPerBox lifetime exhausted")
      }
      await extend.call(booted, Math.min(ms, remaining))
    },
  }
}

/** Daily box-count and EUR caps, read from the e2b usage ledger. An absent or
 *  failing usage source refuses the overflow.
 *
 *  BEST EFFORT, DAEMON-GLOBAL: this is a read-then-boot check, so two
 *  concurrent spawns can both pass under the cap. It counts the e2b usage
 *  ledger, which omits paused boxes and reports `tenantId: "unknown"`, so the
 *  cap is per daemon (not per tenant/end user) and may undercount historical
 *  spend. Both limits fail closed on unknown cost but neither is a
 *  transactional quota. */
const checkDailyCaps = async (
  e2b: SandboxProviderHandle,
  overflow: AutoOverflowConfig,
  now: Date,
): Promise<string | undefined> => {
  const maxBoxes = readCap(overflow.maxBoxesPerDay, DEFAULT_MAX_BOXES_PER_DAY)
  if (maxBoxes === null) return "maxBoxesPerDay is not a positive number"
  const maxEur = readCap(overflow.maxEurPerDay, DEFAULT_MAX_EUR_PER_DAY)
  if (maxEur === null) return "maxEurPerDay is not a positive number"

  const usage = e2b.provider.usage
  if (!usage) return "e2b cost source is unavailable"

  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString()
  let windows: SandboxUsageWindow[]
  try {
    windows = await usage.call(e2b.provider, { from, to: now.toISOString() })
  } catch {
    return "e2b cost source is unavailable"
  }

  const boxes = new Set(windows.map(window => window.computer))
  if (boxes.size >= maxBoxes) return "daily box cap reached"

  let spent = 0
  for (const window of windows) {
    if (window.costEur === null || !Number.isFinite(window.costEur)) {
      return "e2b cost is unknown"
    }
    spent += window.costEur
  }
  if (spent >= maxEur) return "daily EUR cap reached"
  return undefined
}

/** Return the e2b failure, annotated with the computer failure that sent us
 *  there — never a silent retry, never a lost original cause. */
const withComputerError = (e2bErr: unknown, computerErr: unknown): unknown => {
  if (typeof e2bErr === "object" && e2bErr !== null) {
    const target = e2bErr as { cause?: unknown; computerError?: unknown }
    try {
      if (target.cause === undefined) target.cause = computerErr
      if (target.computerError === undefined) target.computerError = computerErr
    } catch {
      // A frozen error still propagates unchanged.
    }
  }
  return e2bErr
}

/** Tag a failed boot/reconnect with the concrete leg that was running, so a
 *  failed-boot ledger row names a provider `sandbox gc` can resolve instead of
 *  the composite slug. */
const withBootProvider = (err: unknown, provider: AutoConcreteProvider): unknown => {
  if (typeof err === "object" && err !== null) {
    const target = err as { provider?: unknown }
    try {
      if (target.provider === undefined) target.provider = provider
    } catch {
      // A frozen error still propagates unchanged.
    }
  }
  return err
}

const choiceLine = (choice: SandboxProviderChoice): string =>
  `[sandbox] auto: requested=${choice.requested} provider=${choice.provider}` +
  `${choice.from ? ` from=${choice.from}` : ""}${choice.reason ? ` reason=${choice.reason}` : ""}`

/**
 * Build the `auto` handle. The registry special-cases the slug before the
 * catalog so this never needs a package of its own.
 */
export function createAutoSandboxProviderHandle(
  deps: AutoSandboxProviderDeps,
): SandboxProviderHandle {
  const ledger = deps.ledger ?? (() => readSandboxLedger())
  const now = deps.now ?? (() => new Date())
  const env = deps.env ?? process.env
  const loadLimits = deps.loadE2bLimits ?? loadE2bLimits
  // Per-box cumulative deadline, so a boot -> pause -> connect in the same
  // daemon process cannot reset the maxEurPerBox ceiling.
  const lifetimeDeadlines = new Map<string, number>()
  const rememberDeadline = (sandboxId: string, maxLifetimeMs: number): number => {
    const at = now().getTime()
    const existing = lifetimeDeadlines.get(sandboxId)
    const deadline =
      existing === undefined ? at + maxLifetimeMs : Math.min(existing, at + maxLifetimeMs)
    lifetimeDeadlines.set(sandboxId, deadline)
    return deadline
  }

  const resolve = async (slug: AutoConcreteProvider): Promise<SandboxProviderHandle> => {
    const handle = await deps.resolveProvider(slug)
    if (!handle) {
      throw new Error(
        `auto sandbox: the "${slug}" provider is not available on this daemon ` +
          "(install it and run setup_sandbox_provider).",
      )
    }
    return handle
  }

  const provider: SandboxProvider = {
    async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
      const config = readAutoConfig(spec)
      const at = now().toISOString()
      const requested = "auto"
      const log = (line: string): void => opts.log?.(line)

      const pinnedReason = computerOnlyReason(spec, config, resolveResidency(config, env))
      if (pinnedReason) {
        try {
          const computer = await resolve("computer")
          const booted = await computer.provider.boot(specFor(spec, "computer", config), opts)
          const choice: SandboxProviderChoice = {
            requested,
            provider: "computer",
            reason: pinnedReason,
            at,
          }
          log(choiceLine(choice))
          return { ...booted, provider: "computer", choice }
        } catch (err) {
          throw withBootProvider(err, "computer")
        }
      }

      let computerErr: unknown
      try {
        const computer = await resolve("computer")
        const legSpec = specFor(spec, "computer", config)
        // With overflow on, a fleet-capacity refusal should overflow now
        // rather than first wait out the computer leg's fleet-capacity window
        // (default 12 min). An explicit `computer.fleetCapacityWaitMs` wins.
        const computerSpec: SandboxSpec =
          config.overflow?.enabled === true && legSpec.config?.fleetCapacityWaitMs === undefined
            ? { ...legSpec, config: { ...legSpec.config, fleetCapacityWaitMs: 0 } }
            : legSpec
        const booted = await computer.provider.boot(computerSpec, opts)
        const choice: SandboxProviderChoice = {
          requested,
          provider: "computer",
          reason: "computer-first",
          at,
        }
        log(choiceLine(choice))
        return { ...booted, provider: "computer", choice }
      } catch (err) {
        computerErr = withBootProvider(err, "computer")
      }

      // Overflow is opt-in, and ONLY a body-coded capacity refusal qualifies
      // (never a transport timeout, auth/validation error, boot timeout, or
      // permanent budget verdict).
      if (config.overflow?.enabled !== true) {
        throw computerErr
      }

      // Import the classifier lazily: `@agentproto/sandbox-computer` is an
      // OPTIONAL dependency, and this module is imported eagerly by the
      // registry. A top-level import would make `@agentproto/runtime`
      // unimportable when the package is absent and would pull its whole
      // index into the core bundle. The computer leg could not have resolved
      // without the package, so a classifier import failure simply means
      // "not a capacity refusal".
      let capacityRefusal = false
      try {
        const { isCapacityRefusal } = await import("@agentproto/sandbox-computer")
        capacityRefusal = isCapacityRefusal(computerErr)
      } catch {
        capacityRefusal = false
      }
      if (!capacityRefusal) {
        throw computerErr
      }

      const overflow = config.overflow ?? {}
      const refuse = (why: string): never => {
        const choice: SandboxProviderChoice = {
          requested,
          provider: "computer",
          from: "computer",
          reason: `overflow refused: ${why}`,
          at,
        }
        log(choiceLine(choice))
        throw new SandboxOverflowRefusedError(why, { cause: computerErr, choice })
      }

      let e2b: SandboxProviderHandle
      try {
        e2b = await resolve("e2b")
      } catch (e2bErr) {
        throw withComputerError(withBootProvider(e2bErr, "e2b"), computerErr)
      }

      const dailyIssue = await checkDailyCaps(e2b, overflow, now())
      if (dailyIssue !== undefined) return refuse(dailyIssue)

      const secrets = selectOverflowSecrets(opts.env, overflow)
      if ("reason" in secrets) return refuse(secrets.reason)

      const parityIssue = await templateParityIssue(config, loadLimits)
      if (parityIssue !== undefined) return refuse(parityIssue)

      const timeout = await capTimeoutMs(config, overflow, loadLimits)
      if ("reason" in timeout) return refuse(timeout.reason)

      const reason = capacityReason(computerErr)
      try {
        // Only names on the explicit allowlist reach the e2b leg; the computer
        // leg already received the full broker-resolved env.
        const booted = await e2b.provider.boot(
          specFor(spec, "e2b", config, timeout.timeoutMs),
          { ...opts, env: secrets.env },
        )
        const choice: SandboxProviderChoice = {
          requested,
          provider: "e2b",
          from: "computer",
          reason,
          at,
        }
        log(choiceLine(choice))
        const deadline = rememberDeadline(booted.sandboxId, timeout.maxLifetimeMs)
        return capBootedLifetime({ ...booted, provider: "e2b", choice }, deadline, now)
      } catch (e2bErr) {
        throw withComputerError(withBootProvider(e2bErr, "e2b"), computerErr)
      }
    },

    async connect(
      sandboxId: string,
      spec: SandboxSpec,
      opts: SandboxBootOpts,
    ): Promise<BootedSandbox> {
      const config = readAutoConfig(spec)
      const row = ledger().find(entry => entry.sandboxId === sandboxId)
      const slug = row?.provider
      if (slug !== "computer" && slug !== "e2b") {
        throw new Error(
          `auto sandbox: cannot resume sandbox "${sandboxId}" — its ledger row does not ` +
            "name a concrete provider, so the box cannot be found again.",
        )
      }
      const handle = await resolve(slug)
      if (!handle.provider.connect) {
        throw new Error(
          `auto sandbox: the ledger names "${slug}" for sandbox "${sandboxId}", but that ` +
            "provider cannot reconnect.",
        )
      }
      const overflow = config.overflow ?? {}
      const refuse = (why: string): never => {
        throw new SandboxOverflowRefusedError(why, {
          choice: {
            requested: "auto",
            provider: "e2b",
            from: "ledger",
            reason: `overflow refused: ${why}`,
            at: now().toISOString(),
          },
        })
      }
      let connectOpts = opts
      let connectSpec = specFor(spec, slug, config)
      let e2bDeadline: number | undefined
      if (slug === "e2b") {
        // The allowlist and the EUR ceiling apply for the whole box lifetime,
        // not just the initial overflow boot.
        const secrets = selectOverflowSecrets(opts.env, overflow)
        if ("reason" in secrets) return refuse(secrets.reason)
        const timeout = await capTimeoutMs(config, overflow, loadLimits)
        if ("reason" in timeout) return refuse(timeout.reason)

        connectOpts = { ...opts, env: secrets.env }
        e2bDeadline = rememberDeadline(sandboxId, timeout.maxLifetimeMs)
        const remaining = e2bDeadline - now().getTime()
        if (remaining <= 0) return refuse("maxEurPerBox lifetime exhausted")
        connectSpec = specFor(
          spec,
          slug,
          config,
          Math.min(timeout.timeoutMs, remaining),
        )
      }
      let booted: BootedSandbox
      try {
        booted = await handle.provider.connect(
          sandboxId,
          connectSpec,
          connectOpts,
        )
      } catch (err) {
        throw withBootProvider(err, slug)
      }
      const choice: SandboxProviderChoice = {
        requested: "auto",
        provider: slug,
        from: "ledger",
        reason: `ledger provider ${slug}`,
        at: now().toISOString(),
      }
      opts.log?.(choiceLine(choice))
      const connected = { ...booted, provider: slug, choice }
      return e2bDeadline === undefined
        ? connected
        : capBootedLifetime(connected, e2bDeadline, now)
    },
  }

  return {
    provider,
    slug: "auto",
    name: "Auto",
    version: "builtin",
    description:
      "Boots on the self-hosted computer fleet, overflowing to e2b only for a " +
      "body-coded capacity refusal when explicitly enabled. Resumes always stay " +
      "with the provider recorded in the sandbox ledger. Shared sessions and " +
      "mounts are not advertised — pin the computer provider for either.",
    requiresSetup: false,
    capabilities: AUTO_CAPABILITIES,
    setupFields: [],
    async check(): Promise<boolean> {
      // `auto` always boots `computer` first, so it is only usable when that
      // leg resolves; e2b is an optional overflow target.
      const computer = await deps.resolveProvider("computer").catch(() => null)
      return computer !== null
    },
  }
}
