/**
 * @agentproto/sdk - umbrella entry point.
 *
 * Re-exports the authoring primitives of the agentproto/ts monorepo from a
 * single package and adds the high-level {@link createAgent} glue:
 *
 *   - AIP-14 TOOL  - `defineTool`, `ToolHandle`
 *   - AIP-30 DRIVER - `implementTool`, `runTool`
 *   - AIP-42 AGENT - `defineAgent`, `loadAgent`, `AgentHandle`
 *   - this package - `createAgent`
 *
 * Subpath exports carry the heavier pieces so the root stays tree-shakeable:
 * `@agentproto/sdk/acp` (ACP client/server) and `@agentproto/sdk/server`
 * (the runtime gateway).
 */

export { defineTool } from "@agentproto/tool"
export type {
  ApprovalClass,
  ToolCapabilities,
  ToolContext,
  ToolDefinition,
  ToolHandle,
  ToolResult,
  ValidationResult,
} from "@agentproto/tool"

export { defineAgent, loadAgent } from "@agentproto/agent"
export type {
  AgentDefinition,
  AgentHandle,
  ModelRef,
  ToolRef,
} from "@agentproto/agent"

export { implementTool, runTool } from "@agentproto/driver"
export type {
  DriverContext,
  ToolImplementation,
  TypedExecuteFn,
} from "@agentproto/driver"

export {
  AgentCompletionError,
  AgentStepLimitError,
  AgentStoppedError,
  createAgent,
} from "./create-agent.js"
export type {
  Agent,
  AgentRunOptions,
  AgentStreamEvent,
  AssistantMessage,
  ChatMessage,
  CompletionFn,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  CreateAgentOptions,
  FetchLike,
  SdkTool,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  ToolSchema,
  UserMessage,
} from "./types.js"
