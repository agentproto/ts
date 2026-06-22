/**
 * @agentproto/mastra — AIP-42 AGENT.md → Mastra runtime adapter.
 *
 * Public surface:
 *   - `buildMastraAgent(handle, opts)`  — build a `new Agent({...})`
 *     from a parsed AGENT.md handle, given resolvers for model/tools/
 *     workflows/memory.
 *   - `composeInstructions(handle, body)` — default body→prompt
 *     composer. Override via `opts.formatInstructions`.
 *   - resolver / option / result types for typed integration.
 *
 * Mastra is a peer dependency. Install `@mastra/core` (>=1.x) in the
 * host package; this adapter doesn't bundle it.
 */

export { buildMastraAgent } from "./build-agent.js"
export { composeInstructions } from "./instructions.js"
export type {
  BuildMastraAgentOptions,
  BuildMastraAgentResult,
  ModelResolver,
  ToolResolver,
  WorkflowResolver,
  MemoryBuilder,
  VoiceBuilder,
  InstructionsFormatter,
  LanguageModelLike,
  MastraToolLike,
  MastraMemoryLike,
  MastraVoiceLike,
  MastraWorkflowLike,
  AgentHandle,
  AnyRef,
  ActionRef,
  ModelRef,
  MemoryConfig,
} from "./types.js"

// Component C — portable playbook overlay InputProcessor factory (AIP-12).
// Guilde's guildePlaybookOverlayProcessor can become a thin wrapper around this.
export { makePlaybookOverlayProcessor } from "./playbook-overlay-processor.js"
export type { PlaybookOverlayProcessorOptions } from "./playbook-overlay-processor.js"

// Component D — on-demand knowledge recall tool factory.
export { makeQueryKnowledgeTool } from "./tools/query-knowledge.js"
export type {
  QueryKnowledgeToolOptions,
  QueryKnowledgeTool,
  QueryKnowledgeInput,
} from "./tools/query-knowledge.js"
