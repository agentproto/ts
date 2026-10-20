/**
 * Typed errors for the computer sandbox provider, mapped from the
 * controller's machine-readable error codes (AIP-36 v1.3). The `code` is the
 * stable contract; messages are human-readable and never carry secrets.
 */

export type ComputerSandboxErrorCode =
  | "sandbox_egress_pool_unavailable"
  | "sandbox_egress_pool_exhausted"
  | "sandbox_egress_slot_dedicated"
  | "sandbox_egress_slot_unknown"
  | "sandbox_capacity"

export interface ComputerSandboxErrorDetails {
  /** HTTP status from the controller response, when there was one. */
  status?: number
  /** `host-capacity` details: the exhausted resource (e.g. "cpu", "memory"). */
  resource?: string
  /** `host-capacity` details: the amount requested. */
  requested?: number
  /** `host-capacity` details: the amount still available. */
  available?: number
  /** `Retry-After` from the controller, converted to milliseconds. */
  retryAfterMs?: number
}

export class ComputerSandboxError extends Error {
  readonly code: ComputerSandboxErrorCode
  readonly status?: number
  readonly resource?: string
  readonly requested?: number
  readonly available?: number
  readonly retryAfterMs?: number

  constructor(code: ComputerSandboxErrorCode, message: string, details: ComputerSandboxErrorDetails = {}) {
    super(message)
    this.name = "ComputerSandboxError"
    this.code = code
    if (details.status !== undefined) this.status = details.status
    if (details.resource !== undefined) this.resource = details.resource
    if (details.requested !== undefined) this.requested = details.requested
    if (details.available !== undefined) this.available = details.available
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
  }
}

const COMPUTER_SANDBOX_ERROR_CODES = new Set<ComputerSandboxErrorCode>([
  "sandbox_egress_pool_unavailable",
  "sandbox_egress_pool_exhausted",
  "sandbox_egress_slot_dedicated",
  "sandbox_egress_slot_unknown",
  "sandbox_capacity",
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
