/**
 * The shared distill prompt + parse moved into `@agentproto/corpus` so every
 * host (this CLI, a companion app's in-process distiller) reuses one prompt
 * instead of drifting copies. Re-exported here for the cli's distiller adapters
 * (AnthropicDistiller / CliAgentDistiller) that import from this path.
 */

export { buildDistillPrompt, parseItems } from "@agentproto/corpus"
