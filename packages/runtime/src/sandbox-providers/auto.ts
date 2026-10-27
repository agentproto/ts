/**
 * The `auto` sandbox provider — a COMPOSITE over the existing `computer` and
 * `e2b` handles, not a new backend.
 *
 * It exists for one reason: the self-hosted `computer` fleet can run out of
 * host capacity (a body-coded capacity refusal), and an operator who would
 * rather take a cloud box than fail the spawn can opt into a one-way overflow
 * to e2b. The overflow is deliberately narrow:
 *
 *   - OFF by default (`config.overflow.enabled`), until the caps in a later
 *     wave make it safe to spend money unattended.
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
 * Secrets: the caller's `SandboxBootOpts.env` (already broker-resolved by
 * `@agentproto/sandbox`) is forwarded to whichever leg boots. This module
 * never reads `process.env` and never logs config values.
 */

import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxProvider,
  SandboxProviderChoice,
  SandboxSpec,
} from "@agentproto/sandbox"

import type { SandboxLedgerEntry } from "../sandbox-ledger.js"
import { readSandboxLedger } from "../sandbox-ledger.js"
import type { SandboxProviderCapabilities, SandboxProviderHandle } from "./types.js"

/** Concrete backends this provider can compose. */
export type AutoConcreteProvider = "computer" | "e2b"

/** Per-leg config, read from `agent_start.sandbox.config`. Everything here
 *  except `overflow` (and the PR6 caps that do not exist yet) is optional. */
export interface AutoSandboxConfig {
  /** Extra `computer` config, merged over the leg's own config. */
  computer?: Record<string, unknown>
  /** Fleet connection, mapped onto the computer leg's controller config. */
  fleet?: { url?: string; token?: string; tenantId?: string }
  /** Extra `e2b` config (size/template/timeout). */
  e2b?: { size?: string; template?: string; timeoutMs?: number }
  /** `"eu-ovh"` pins the box to the self-hosted fleet (computer only). The
   *  full residency policy (including the env default) lands in PR6. */
  residency?: "any" | "eu-ovh" | string
  /** Overflow is opt-in; absent/false means a capacity refusal is returned
   *  unchanged. */
  overflow?: { enabled?: boolean }
}

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

const e2bConfig = (config: AutoSandboxConfig): Record<string, unknown> => ({
  ...baseConfig(isRecord(config) ? config : {}),
  ...(isRecord(config.e2b) ? config.e2b : {}),
})

const specFor = (spec: SandboxSpec, slug: AutoConcreteProvider, config: AutoSandboxConfig): SandboxSpec => ({
  ...spec,
  provider: slug,
  config: slug === "computer" ? computerConfig(config) : e2bConfig(config),
})

/** Why this spawn may ONLY run on the self-hosted computer, if it may. */
const computerOnlyReason = (
  spec: SandboxSpec,
  config: AutoSandboxConfig,
): string | undefined => {
  if (config.residency !== undefined && config.residency !== "any") {
    // Fail safe: only the two understood values may overflow. Any other
    // residency (known to a later policy, or a typo) pins to computer rather
    // than silently placing the box in a region the caller did not ask for.
    return config.residency === "eu-ovh" ? "residency eu-ovh" : "residency requires computer"
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

      const pinnedReason = computerOnlyReason(spec, config)
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
        const booted = await computer.provider.boot(specFor(spec, "computer", config), opts)
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

      const reason = capacityReason(computerErr)
      try {
        const e2b = await resolve("e2b")
        // The SAME broker-resolved env object the computer leg received —
        // never process.env, never a re-derivation.
        const booted = await e2b.provider.boot(specFor(spec, "e2b", config), opts)
        const choice: SandboxProviderChoice = {
          requested,
          provider: "e2b",
          from: "computer",
          reason,
          at,
        }
        log(choiceLine(choice))
        return { ...booted, provider: "e2b", choice }
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
      let booted: BootedSandbox
      try {
        booted = await handle.provider.connect(
          sandboxId,
          specFor(spec, slug, config),
          opts,
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
      return { ...booted, provider: slug, choice }
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
