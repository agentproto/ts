/**
 * Shared types for pluggable sandbox providers.
 *
 * The sandbox family is a `@agentproto/provider-kit` consumer, same shape as
 * the tunnel family (`remote-providers/types.ts`): {@link SandboxProviderHandle}
 * extends the kit's generic `AdapterHandle` (slug/name/version/description/
 * requiresSetup/check) with the AIP-36 capability namespace and the concrete
 * `@agentproto/sandbox` `SandboxProvider` (`boot()`) the handle wraps.
 */

import type { AdapterHandle, SetupField } from "@agentproto/provider-kit"
import type { SandboxProvider } from "@agentproto/sandbox"

/**
 * Declared capabilities of a sandbox provider — pure metadata, surfaced in
 * `list_sandbox_providers`. Never carries secrets. Namespace mirrors AIP-36
 * SANDBOX.md (`network.egress`, `mounts`, `lifecycle.pause_after_idle`,
 * `read_only`, `limits.timeout_ms`).
 */
export interface SandboxProviderCapabilities {
  /** Sandbox can be given a network egress allowlist (AIP-36 `network.egress`). */
  networkEgress: boolean
  /** Sandbox supports mounting external filesystems (AIP-36 `mounts`). */
  mounts: boolean
  /** Sandbox can be paused (not just killed) between turns (AIP-36 `lifecycle.pause_after_idle`). */
  lifecyclePause: boolean
  /** Sandbox can be started read-only (AIP-36 `read_only`). */
  readOnly: boolean
  /** Hard cap on `limits.timeout_ms`, when the provider enforces one. */
  maxTimeoutMs?: number
}

/**
 * A sandbox provider as an adapter-kit handle. Rides on the kit's generic
 * {@link AdapterHandle} and adds the sandbox-specific `capabilities` plus
 * the `@agentproto/sandbox` `SandboxProvider` the handle wraps — the thing
 * `createSandboxAgentSessionHost` actually boots.
 */
export interface SandboxProviderHandle extends AdapterHandle {
  readonly provider: SandboxProvider
  readonly capabilities: SandboxProviderCapabilities
  /**
   * Credential fields this provider accepts via `setup_sandbox_provider`
   * (e.g. e2b's `apiKey`). Omit (or empty) when the provider needs no
   * credentials (e.g. `local`).
   */
  readonly setupFields?: readonly SetupField[]
}
