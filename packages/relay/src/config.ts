/**
 * Startup config, read once from env at process boot. Deliberately
 * fails loud (throws) on anything that would otherwise leave the relay
 * running in an unsafe or ambiguous state — this service is designed to
 * sit on the public internet behind a tunnel, so there is no such thing
 * as a "harmless" missing setting here.
 */

export type TargetVia = "agent" | "terminal"

export interface RateLimitConfig {
  /** Max requests allowed per window. */
  max: number
  /** Window size in milliseconds. */
  windowMs: number
}

export interface RelayConfig {
  /** The ONE session id/name this relay instance may wake up. Never
   *  accepted as a request parameter — baked in at startup only. */
  targetSession: string
  /** How `text` gets delivered to the target session. */
  targetVia: TargetVia
  /** Shared-secret bearer token gating POST /relay/inbound. */
  token: string
  /** Base URL of the agentproto daemon this relay talks to. */
  daemonUrl: string
  rateLimit: RateLimitConfig
}

const DEFAULT_DAEMON_URL = "http://127.0.0.1:18790"
const DEFAULT_TARGET_VIA: TargetVia = "agent"
const DEFAULT_RATE_LIMIT_MAX = 20
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const targetSession = (env.AGENTPROTO_RELAY_TARGET_SESSION ?? "").trim()
  if (!targetSession) {
    throw new Error(
      "AGENTPROTO_RELAY_TARGET_SESSION is required — set it to the id or name of " +
        "the ONE session this relay is allowed to wake up. It is never accepted as " +
        "a request parameter, by design.",
    )
  }

  const rawVia = (env.AGENTPROTO_RELAY_TARGET_VIA ?? DEFAULT_TARGET_VIA).trim()
  if (rawVia !== "agent" && rawVia !== "terminal") {
    throw new Error(
      `AGENTPROTO_RELAY_TARGET_VIA must be "agent" or "terminal" (got "${rawVia}").`,
    )
  }

  const token = env.AGENTPROTO_RELAY_TOKEN ?? ""
  if (!token) {
    throw new Error(
      "AGENTPROTO_RELAY_TOKEN is required — refusing to start without a shared " +
        "secret. This service is designed to be exposed publicly; there is no " +
        "no-auth fallback.",
    )
  }

  const daemonUrl = (env.AGENTPROTO_DAEMON_URL || DEFAULT_DAEMON_URL).replace(/\/+$/, "")

  return {
    targetSession,
    targetVia: rawVia,
    token,
    daemonUrl,
    rateLimit: {
      max: parsePositiveInt(env.AGENTPROTO_RELAY_RATE_LIMIT, DEFAULT_RATE_LIMIT_MAX),
      windowMs: parsePositiveInt(
        env.AGENTPROTO_RELAY_RATE_WINDOW_MS,
        DEFAULT_RATE_LIMIT_WINDOW_MS,
      ),
    },
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}
