/**
 * The one error type this package throws, with a stable machine code so a UI
 * can branch on it (e.g. show "scan a new pairing QR" for `revoked`).
 */

export type TunnelClientErrorCode =
  /** The daemon told us (authenticated, inside the E2E channel) that this
   *  pairing was revoked. Terminal: pair again from a new offer. */
  | "revoked"
  /** The daemon could not be reached (rendezvous dial, handshake or greeting
   *  failed, or no connection came up within the wait). Retried with backoff. */
  | "offline"
  /** The live connection dropped while this request was in flight. */
  | "disconnected"
  /** `client.close()` was called. */
  | "closed"
  /** The offer URL is malformed or expired. */
  | "invalid_offer"
  /** The pairing handshake over the offer failed (bad daemon signature, spent
   *  offer, fingerprint mismatch, timeout…). */
  | "pairing_failed"
  /** `confirm()` after `cancel()` (or a second `confirm()`). */
  | "cancelled"
  /** The daemon's upstream failed mid-stream (surfaced on the body stream). */
  | "stream_error"

export class TunnelClientError extends Error {
  readonly code: TunnelClientErrorCode
  constructor(code: TunnelClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TunnelClientError"
    this.code = code
  }
}

/** The actionable message for a revoked pairing. */
export function revokedError(daemonName: string): TunnelClientError {
  return new TunnelClientError(
    "revoked",
    `this device was unpaired from ${daemonName}; scan a new pairing QR`,
  )
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
