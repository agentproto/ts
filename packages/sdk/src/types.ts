import type { AgentHandle } from "@agentproto/agent"
import type { ToolImplementation } from "@agentproto/driver"
import type { ToolHandle } from "@agentproto/tool"

/**
 * A tool accepted by {@link createAgent}.
 *
 * A bare {@link ToolHandle} is a *contract* (AIP-14): its schema is
 * advertised to the model, but calling it needs a body. Bind a body with
 * `implementTool(handle, fn)` from `@agentproto/driver` to make it callable.
 */
// Erased at this boundary: implementations are invariant in their input
// generic (`TypedExecuteFn` takes the input as a parameter), so a concrete
// `ToolImplementation<{ city: string }>` is not assignable to the default
// `ToolImplementation<unknown>`. The runtime only ever feeds validated input.
export type SdkTool =
  | ToolHandle<any, any, any>
  | ToolImplementation<any, any, any>

/** One tool call the model asked for. */
export interface ToolCallRequest {
  /** Provider-assigned call id, echoed back on the tool result message. */
  id: string
  /** Tool id (the `ToolHandle.id`). */
  name: string
  /** Raw arguments - a JSON string (OpenAI wire) or an already-parsed object. */
  arguments: string | Record<string, unknown>
}

/** Tool schema advertised to the completion endpoint. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema for the tool input (converted from the zod `inputSchema`). */
  parameters: Record<string, unknown>
}

export interface SystemMessage {
  role: "system"
  content: string
}

export interface UserMessage {
  role: "user"
  content: string
}

export interface AssistantMessage {
  role: "assistant"
  content?: string | null
  toolCalls?: ToolCallRequest[]
}

export interface ToolMessage {
  role: "tool"
  toolCallId: string
  content: string
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage

/** Usage reported by the completion endpoint, when it reports any. */
export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface CompletionRequest {
  model: string
  messages: readonly ChatMessage[]
  tools: readonly ToolSchema[]
  signal: AbortSignal
  temperature?: number
}

export interface CompletionResponse {
  message: AssistantMessage
  usage?: CompletionUsage
}

/**
 * Pluggable model call. The default implementation speaks the OpenAI
 * `POST /chat/completions` wire shape; inject your own to route through a
 * gateway, a mock in tests, or a non-OpenAI provider.
 */
export type CompletionFn = (
  request: CompletionRequest,
) => Promise<CompletionResponse>

/** Minimal structural `fetch` so callers can inject one without DOM types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

export interface AgentRunOptions {
  /** Extra conversation turns prepended to the prompt. */
  messages?: readonly ChatMessage[]
  /** Override the agent-wide step ceiling for this run. */
  maxSteps?: number
  /** Override the agent-wide temperature for this run. */
  temperature?: number
  /** Caller abort signal, in addition to `agent.stop()`. */
  signal?: AbortSignal
}

export interface CreateAgentOptions {
  /** Agent id (AIP-42: lowercase, dashes/dots/underscores, 2–80 chars). */
  id: string
  /** Provider/model id, e.g. `anthropic/claude-sonnet-5`. */
  model: string
  /** Tools the agent may call. Bare handles are advertised but not callable. */
  tools?: readonly SdkTool[]
  /** One-paragraph purpose recorded on the AIP-42 handle. */
  description?: string
  /** System prompt prepended to every run. */
  system?: string
  /** Alias for {@link CreateAgentOptions.system}. */
  instructions?: string
  temperature?: number
  /** Model round-trips before the run gives up. Default 8. */
  maxSteps?: number
  /** Replace the default OpenAI-compatible completion call. */
  complete?: CompletionFn
  /** Base URL of an OpenAI-compatible endpoint. */
  baseUrl?: string
  /** Bearer token for the endpoint. */
  apiKey?: string
  /** Extra headers sent with every completion request. */
  headers?: Record<string, string>
  /** Injectable `fetch` (tests, custom transports). */
  fetch?: FetchLike
}

export type AgentStreamEvent =
  | { type: "start"; prompt: string; messages: readonly ChatMessage[] }
  | {
      type: "assistant"
      content: string
      toolCalls: readonly ToolCallRequest[]
      usage?: CompletionUsage
    }
  | { type: "tool-call"; call: ToolCallRequest }
  | { type: "tool-result"; call: ToolCallRequest; result: unknown }
  | { type: "tool-error"; call: ToolCallRequest; error: string }
  | {
      type: "done"
      content: string
      messages: readonly ChatMessage[]
      usage?: CompletionUsage
    }

export interface Agent {
  /** The AIP-42 id. */
  readonly id: string
  /** The model id the agent was created with. */
  readonly model: string
  /** The validated AIP-42 handle backing this agent. */
  readonly handle: AgentHandle
  /** The tool contracts this agent advertises. */
  readonly tools: readonly ToolHandle[]
  /** Run one prompt to completion and return the final assistant text. */
  run(prompt: string, options?: AgentRunOptions): Promise<string>
  /** Same loop as {@link Agent.run}, exposed as a stream of events. */
  stream(
    prompt: string,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent, string, void>
  /** Abort every in-flight run. The agent stays usable for later runs. */
  stop(): void
}
