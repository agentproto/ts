/**
 * Thrown by a provider's `boot()` when the VENDOR ACCOUNT cannot host another
 * box: plan caps (max concurrent/total machines) surfaced as 402/403/429 or
 * an explicit quota code/message. Distinct from a generic boot failure so a
 * caller (the session spawn path) can fall back to ANOTHER provider instead
 * of surfacing the failure to the user as dead-end noise.
 */
export class SandboxQuotaError extends Error {
  /** The provider slug (e.g. "e2b", "box", "instabox") that reported the cap. */
  readonly provider: string

  constructor(provider: string, message?: string, cause?: unknown) {
    super(
      message ??
        `sandbox provider "${provider}" has no capacity left for another box ` +
          "(account limit reached): retrying on the same provider will not help; " +
          "fall back to a different sandbox provider.",
    )
    this.name = "SandboxQuotaError"
    this.provider = provider
    this.cause = cause
  }
}

/** Structural check (name-based, so it works across package boundaries and
 *  with mocked errors): true when the error means "the provider account is
 *  out of room". */
export function isSandboxQuotaError(err: unknown): boolean {
  return err instanceof Error && err.name === "SandboxQuotaError"
}
