/**
 * @agentproto/agent-runtime
 *
 * MultiAgentRuntime kernel: seven swappable ports + reference adapters.
 * Top-level entry re-exports the kernel surface; adapters are imported
 * from explicit subpaths to keep tree-shaking honest.
 */

/** AIP-70 registry spec id for this package (`runtime/v1`, AIP-48). */
export const SPEC_NAME = "runtime/v1" as const

export * from "./ports.js"
export * from "./runtime.js"
export * from "./manifest.js"
