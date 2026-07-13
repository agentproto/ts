/**
 * Environment configuration for the rendezvous server.
 *
 * All values are parsed from process.env with sensible defaults.
 * CLI arguments take precedence over env vars (handled in cli.ts).
 */

function parseIntOrDefault(val: string | undefined, def: number): number {
  if (!val) return def
  const n = parseInt(val, 10)
  if (Number.isNaN(n) || n < 0) return def
  return n
}

function parseBool(val: string | undefined): boolean {
  return val === "1" || val === "true" || val === "yes"
}

export interface RendezvousEnvConfig {
  /** Server port. Default 8788. */
  port: number
  /** Server host. Default "0.0.0.0". */
  host: string
  /** Upgrade path. Default "/v1". */
  path: string
  /** Park timeout in ms. Default 120_000. */
  parkTimeoutMs: number
  /** Idle timeout in ms. Default 900_000. */
  idleTimeoutMs: number
  /** Max message size in bytes. Default 1 MiB. */
  maxMessageBytes: number
  /** Rate limit max attempts. Default 120. */
  rateLimitMax: number
  /** Rate limit window in ms. Default 60_000. */
  rateLimitWindowMs: number
  /** Enable debug logging. Default false. */
  debug: boolean
}

export function loadEnvConfig(): RendezvousEnvConfig {
  return {
    port: parseIntOrDefault(process.env.RENDEZVOUS_PORT, 8788),
    host: process.env.RENDEZVOUS_HOST ?? "0.0.0.0",
    path: process.env.RENDEZVOUS_PATH ?? "/v1",
    parkTimeoutMs: parseIntOrDefault(process.env.RENDEZVOUS_PARK_TIMEOUT_MS, 120_000),
    idleTimeoutMs: parseIntOrDefault(process.env.RENDEZVOUS_IDLE_TIMEOUT_MS, 900_000),
    maxMessageBytes: parseIntOrDefault(process.env.RENDEZVOUS_MAX_MESSAGE_BYTES, 1024 * 1024),
    rateLimitMax: parseIntOrDefault(process.env.RENDEZVOUS_RATE_LIMIT_MAX, 120),
    rateLimitWindowMs: parseIntOrDefault(process.env.RENDEZVOUS_RATE_LIMIT_WINDOW_MS, 60_000),
    debug: parseBool(process.env.RENDEZVOUS_DEBUG),
  }
}
