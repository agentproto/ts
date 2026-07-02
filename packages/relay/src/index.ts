export { loadConfigFromEnv } from "./config.js"
export type { RelayConfig, RateLimitConfig, TargetVia } from "./config.js"

export { createRelayServer } from "./server.js"
export type { CreateRelayServerOptions, DaemonClient } from "./server.js"

export { createRateLimiter } from "./rate-limiter.js"
export type { RateLimiter, RateLimiterOptions } from "./rate-limiter.js"

export { timingSafeEqualStrings } from "./timing-safe.js"

export {
  checkSessionAlive,
  resolveDaemonToken,
  sendAgentPrompt,
  sendTerminalInput,
} from "./daemon-client.js"
export type { SessionAliveResult, DeliveryResult } from "./daemon-client.js"
