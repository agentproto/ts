/**
 * Default instructions composer — moved to `@agentproto/agent` so every
 * harness (not just mastra-agent) renders an AGENT.md the same way; see
 * `packages/runtime/src/agent-projection.ts`. Re-exported here for
 * existing imports.
 */

export { composeInstructions } from "@agentproto/agent"
