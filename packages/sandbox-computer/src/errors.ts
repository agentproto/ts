/**
 * Typed errors for the computer sandbox provider, mapped from the
 * controller's machine-readable error codes (AIP-36 v1.3). The `code` is the
 * stable contract; messages are human-readable and never carry secrets.
 */

import { ComputerApiError } from "./client.js"

export type ComputerSandboxErrorCode =
  | "sandbox_egress_pool_unavailable"
  | "sandbox_egress_pool_exhausted"
  | "sandbox_egress_slot_dedicated"
  | "sandbox_egress_slot_unknown"
  | "sandbox_capacity"
  | "sandbox_capacity_exceeds_budget"
  | "sandbox_fleet_capacity"
  | "sandbox_tenant_running_cap"
  | "sandbox_end_user_cap"
  | "sandbox_fleet_tenant_cap"
  | "sandbox_boot_timeout"

export interface ComputerSandboxErrorDetails {
  /** HTTP status from the controller response, when there was one. */
  status?: number
  /** `host-capacity` details: the exhausted resource (e.g. "cpu", "memory"). */
  resource?: string
  /** `host-capacity` details: the amount requested. */
  requested?: number
  /** `host-capacity` details: the amount still available. */
  available?: number
  /** `host-capacity` details: the tenant's TOTAL budget for `resource`, when
   *  the controller reported it (either on the error or via GET /v1/capacity). */
  budget?: number
  /** Count-cap details: the configured limit the refusal hit (`cap` in the
   *  controller's `end-user-cap` / `fleet-tenant-cap` body). */
  cap?: number
  /** `Retry-After` from the controller, converted to milliseconds. */
  retryAfterMs?: number
  /** `sandbox_boot_timeout`: the boot phase that was still in flight. */
  phase?: string
  /** `sandbox_boot_timeout`: the deadline the boot exceeded. */
  timeoutMs?: number
  /** `sandbox_boot_timeout`: the controller computer id, once it was known. */
  sandboxId?: string
}

export class ComputerSandboxError extends Error {
  readonly code: ComputerSandboxErrorCode
  readonly status?: number
  readonly resource?: string
  readonly requested?: number
  readonly available?: number
  readonly budget?: number
  readonly cap?: number
  readonly retryAfterMs?: number
  readonly phase?: string
  readonly timeoutMs?: number
  readonly sandboxId?: string

  constructor(code: ComputerSandboxErrorCode, message: string, details: ComputerSandboxErrorDetails = {}) {
    super(message)
    this.name = "ComputerSandboxError"
    this.code = code
    if (details.status !== undefined) this.status = details.status
    if (details.resource !== undefined) this.resource = details.resource
    if (details.requested !== undefined) this.requested = details.requested
    if (details.available !== undefined) this.available = details.available
    if (details.budget !== undefined) this.budget = details.budget
    if (details.cap !== undefined) this.cap = details.cap
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.phase !== undefined) this.phase = details.phase
    if (details.timeoutMs !== undefined) this.timeoutMs = details.timeoutMs
    if (details.sandboxId !== undefined) this.sandboxId = details.sandboxId
  }
}

const COMPUTER_SANDBOX_ERROR_CODES = new Set<ComputerSandboxErrorCode>([
  "sandbox_egress_pool_unavailable",
  "sandbox_egress_pool_exhausted",
  "sandbox_egress_slot_dedicated",
  "sandbox_egress_slot_unknown",
  "sandbox_capacity",
  "sandbox_capacity_exceeds_budget",
  "sandbox_fleet_capacity",
  "sandbox_tenant_running_cap",
  "sandbox_end_user_cap",
  "sandbox_fleet_tenant_cap",
  "sandbox_boot_timeout",
])

/** Structural check that works across package boundaries and with mocks:
 *  `instanceof` is a fast path for errors from this exact module instance,
 *  but the name + a known `code` also recognises a duplicate install or a
 *  plain object shaped like the error. */
export function isComputerSandboxError(err: unknown): err is ComputerSandboxError {
  if (err instanceof ComputerSandboxError) return true
  if (typeof err !== "object" || err === null) return false
  const candidate = err as { name?: unknown; code?: unknown }
  return (
    candidate.name === "ComputerSandboxError" &&
    typeof candidate.code === "string" &&
    COMPUTER_SANDBOX_ERROR_CODES.has(candidate.code as ComputerSandboxErrorCode)
  )
}

/** Controller body codes that mean "this host/fleet cannot take the box
 *  right now", in the contract's vocabulary. The HTTP status is not part of
 *  the test: a 503 can also be a non-capacity refusal (an exec refusing an
 *  untrusted secret), so only the body code classifies. */
const CAPACITY_REFUSAL_CONTROLLER_CODES = new Set([
  "host-capacity",
  "fleet-capacity",
  "tenant-running-cap",
  "end-user-cap",
  "fleet-tenant-cap",
])

/** Typed codes derived from those body codes. `sandbox_capacity_exceeds_budget`
 *  is deliberately absent: it is a permanent "can never fit" verdict, not an
 *  overflow signal. */
const CAPACITY_REFUSAL_TYPED_CODES = new Set<ComputerSandboxErrorCode>([
  "sandbox_capacity",
  "sandbox_fleet_capacity",
  "sandbox_tenant_running_cap",
  "sandbox_end_user_cap",
  "sandbox_fleet_tenant_cap",
])

/**
 * The single gate for capacity-driven overflow: true only for a refusal the
 * controller body-coded as a capacity/count-cap refusal. False for a
 * permanent budget verdict, a boot timeout, auth/validation/conflict errors,
 * transport errors, and any 503 whose body code is not a capacity code.
 */
export function isCapacityRefusal(err: unknown): boolean {
  if (isComputerSandboxError(err)) return CAPACITY_REFUSAL_TYPED_CODES.has(err.code)
  if (err instanceof ComputerApiError) {
    return err.code !== undefined && CAPACITY_REFUSAL_CONTROLLER_CODES.has(err.code)
  }
  // Structural fallback for a duplicate install or a mock: the body code is
  // the contract, the class identity is not.
  if (typeof err !== "object" || err === null) return false
  const candidate = err as { code?: unknown }
  return (
    typeof candidate.code === "string" &&
    CAPACITY_REFUSAL_CONTROLLER_CODES.has(candidate.code)
  )
}
