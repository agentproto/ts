/**
 * @agentproto/agent-runtime
 *
 * MultiAgentRuntime kernel: seven swappable ports + reference adapters.
 * Top-level entry re-exports the kernel surface; adapters are imported
 * from explicit subpaths to keep tree-shaking honest.
 */

export * from "./ports.js"
export * from "./runtime.js"
export * from "./manifest.js"
