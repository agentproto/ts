import { defineAgent } from "@agentproto/agent"
import type { ToolImplementation } from "@agentproto/driver"
import { validateInput } from "@agentproto/tool"
import type { ToolHandle } from "@agentproto/tool"
import { z } from "zod"
import type {
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
  ToolCallRequest,
  ToolSchema,
} from "./types.js"

const DEFAULT_MAX_STEPS = 8
const DEFAULT_BASE_URL = "https://api.openai.com/v1"

/** Thrown when {@link Agent.stop} (or the caller's signal) cancels a run. */
export class AgentStoppedError extends Error {
  constructor() {
    super("agent run stopped")
    this.name = "AgentStoppedError"
  }
}

/** Thrown when a run needs more than `maxSteps` model round-trips. */
export class AgentStepLimitError extends Error {
  constructor(id: string, maxSteps: number) {
    super(`agent '${id}' exceeded maxSteps (${maxSteps})`)
    this.name = "AgentStepLimitError"
  }
}

/** The endpoint rejected a completion request (non-2xx). */
export class AgentCompletionError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`completion request failed (HTTP ${status}): ${detail}`)
    this.name = "AgentCompletionError"
    this.status = status
  }
}

/**
 * Build a runnable agent from an id, a model, and a set of tools.
 *
 * The returned handle is backed by a validated AIP-42 `AgentHandle` (so the
 * identity, model and tool refs are checked with the same rules a manifest
 * goes through) and exposes a small tool-calling loop:
 *
 * ```ts
 * const weather = implementTool(
 *   defineTool({ id: "weather", description: "Get weather", inputSchema: z.object({ city: z.string() }) }),
 *   async ({ input }) => ({ city: input.city, tempC: 21 }),
 * )
 * const agent = createAgent({ id: "greeter", model: "anthropic/claude-sonnet-5", tools: [weather] })
 * console.log(await agent.run("Weather in Paris?"))
 * ```
 *
 * Calls the model through an OpenAI-compatible `POST /chat/completions`
 * endpoint by default (override with `complete`, `baseUrl`, `apiKey`, or
 * `fetch`). No I/O happens until `run`/`stream` is called.
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const id = options.id
  const model = options.model
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("createAgent: model is required")
  }

  const entries = (options.tools ?? []).map(normalizeTool)
  const byName = new Map<string, Entry>()
  for (const entry of entries) {
    if (byName.has(entry.handle.id)) {
      throw new Error(`createAgent: duplicate tool id '${entry.handle.id}'`)
    }
    byName.set(entry.handle.id, entry)
  }

  const handle = defineAgent({
    schema: "agent/v1",
    id,
    description: options.description ?? `Agent ${id}.`,
    model,
    tools: entries.map((entry) => entry.handle.id),
  })

  const system = options.system ?? options.instructions
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const complete = options.complete ?? createDefaultCompletion(options)
  const active = new Set<AbortController>()

  async function* iterate(
    prompt: string,
    runOptions: AgentRunOptions = {},
  ): AsyncGenerator<AgentStreamEvent, string, void> {
    const controller = new AbortController()
    active.add(controller)
    const unlink = linkAbort(runOptions.signal, () => controller.abort())
    const signal = controller.signal
    const steps = runOptions.maxSteps ?? maxSteps
    const temperature = runOptions.temperature ?? options.temperature
    const toolSchemas = entries.map((entry) => toToolSchema(entry.handle))

    const messages: ChatMessage[] = []
    if (system) messages.push({ role: "system", content: system })
    if (runOptions.messages) messages.push(...runOptions.messages)
    messages.push({ role: "user", content: prompt })

    yield { type: "start", prompt, messages: [...messages] }

    let usage: CompletionUsage | undefined
    try {
      for (let step = 0; step < steps; step++) {
        throwIfStopped(signal)
        const response = await completeOrStop(complete, {
          model,
          messages,
          tools: toolSchemas,
          signal,
          ...(temperature !== undefined ? { temperature } : {}),
        })
        if (response.usage) usage = response.usage

        const assistant: AssistantMessage = {
          role: "assistant",
          content: response.message.content ?? "",
          ...(response.message.toolCalls?.length
            ? { toolCalls: response.message.toolCalls }
            : {}),
        }
        messages.push(assistant)
        yield {
          type: "assistant",
          content: assistant.content ?? "",
          toolCalls: assistant.toolCalls ?? [],
          ...(response.usage ? { usage: response.usage } : {}),
        }

        const calls = assistant.toolCalls ?? []
        if (calls.length === 0) {
          const content = assistant.content ?? ""
          yield {
            type: "done",
            content,
            messages: [...messages],
            ...(usage ? { usage } : {}),
          }
          return content
        }

        for (const call of calls) {
          throwIfStopped(signal)
          yield { type: "tool-call", call }
          try {
            const result = await invokeTool(byName, call, signal)
            yield { type: "tool-result", call, result }
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: serializeResult(result),
            })
          } catch (error) {
            if (signal.aborted) throw new AgentStoppedError()
            const message = errorMessage(error)
            yield { type: "tool-error", call, error: message }
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: JSON.stringify({ error: message }),
            })
          }
        }
      }

      throwIfStopped(signal)
      throw new AgentStepLimitError(id, steps)
    } finally {
      unlink()
      active.delete(controller)
    }
  }

  return {
    id,
    model,
    handle,
    tools: entries.map((entry) => entry.handle),
    async run(prompt: string, runOptions?: AgentRunOptions): Promise<string> {
      let final = ""
      for await (const event of iterate(prompt, runOptions)) {
        if (event.type === "done") final = event.content
      }
      return final
    },
    stream(prompt: string, runOptions?: AgentRunOptions) {
      return iterate(prompt, runOptions)
    },
    stop() {
      for (const controller of active) controller.abort()
      active.clear()
    },
  }
}

interface Entry {
  handle: ToolHandle
  implementation: ToolImplementation | null
}

function normalizeTool(tool: SdkTool): Entry {
  const maybeImplementation = tool as ToolImplementation
  if (
    maybeImplementation &&
    typeof maybeImplementation === "object" &&
    "tool" in maybeImplementation &&
    "body" in maybeImplementation &&
    typeof maybeImplementation.body === "function"
  ) {
    return {
      handle: maybeImplementation.tool,
      implementation: maybeImplementation,
    }
  }
  return { handle: tool as ToolHandle, implementation: null }
}

function toToolSchema(handle: ToolHandle): ToolSchema {
  return {
    name: handle.id,
    description: handle.description,
    parameters: inputSchemaToJson(handle),
  }
}

function inputSchemaToJson(handle: ToolHandle): Record<string, unknown> {
  if (handle.inputSchema) {
    try {
      const schema = handle.inputSchema as unknown as Parameters<
        typeof z.toJSONSchema
      >[0]
      const json = z.toJSONSchema(schema, { io: "input" }) as Record<
        string,
        unknown
      >
      return json
    } catch {
      // A schema the converter cannot express still gets advertised as a
      // permissive object rather than dropping the tool from the request.
    }
  }
  if (handle.inputs) return { ...(handle.inputs as Record<string, unknown>) }
  return { type: "object", properties: {} }
}

async function invokeTool(
  byName: Map<string, Entry>,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const entry = byName.get(call.name)
  if (!entry) throw new Error(`unknown tool '${call.name}'`)
  if (!entry.implementation) {
    throw new Error(
      `tool '${call.name}' has no implementation - bind one with implementTool(tool, fn)`,
    )
  }

  const input = parseArguments(call)
  const validation = validateInput(entry.handle, input)
  if (!validation.ok) {
    throw new Error(`tool '${call.name}' input invalid: ${validation.error.message}`)
  }

  return entry.implementation.body({
    input: validation.value,
    context: { signal },
    driverCtx: { secrets: {}, authState: "unknown" },
    signal,
  })
}

function parseArguments(call: ToolCallRequest): unknown {
  if (typeof call.arguments !== "string") return call.arguments
  const raw = call.arguments.trim()
  if (raw === "") return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`tool '${call.name}' received malformed JSON arguments`)
  }
}

function serializeResult(result: unknown): string {
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result) ?? String(result)
  } catch {
    return String(result)
  }
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentStoppedError()
}

async function completeOrStop(
  complete: CompletionFn,
  request: CompletionRequest,
): Promise<CompletionResponse> {
  try {
    return await complete(request)
  } catch (error) {
    if (request.signal.aborted) throw new AgentStoppedError()
    throw error
  }
}

function linkAbort(
  outer: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!outer) return () => {}
  if (outer.aborted) {
    onAbort()
    return () => {}
  }
  const listener = () => onAbort()
  outer.addEventListener("abort", listener, { once: true })
  return () => outer.removeEventListener("abort", listener)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Default model call: an OpenAI-compatible `POST /chat/completions`.
 *
 * Reads `baseUrl` / `apiKey` / `headers` / `fetch` from the options and
 * falls back to `AGENTPROTO_BASE_URL` / `OPENAI_BASE_URL`,
 * `AGENTPROTO_API_KEY` / `OPENAI_API_KEY`, and the global `fetch`.
 */
function createDefaultCompletion(options: CreateAgentOptions): CompletionFn {
  return async (request) => {
    const fetchImpl =
      options.fetch ??
      (globalThis as unknown as { fetch?: FetchLike }).fetch
    if (!fetchImpl) {
      throw new Error(
        "createAgent: no fetch available - pass `fetch`, `complete`, or run on Node 18+",
      )
    }

    const endpoint = resolveEndpoint(
      options.baseUrl ?? readEnv("AGENTPROTO_BASE_URL") ?? readEnv("OPENAI_BASE_URL"),
    )
    const apiKey =
      options.apiKey ?? readEnv("AGENTPROTO_API_KEY") ?? readEnv("OPENAI_API_KEY")

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }
    if (request.temperature !== undefined) body.temperature = request.temperature

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })

    if (!response.ok) {
      throw new AgentCompletionError(response.status, truncate(await safeText(response)))
    }

    return parseCompletion(await response.json())
  }
}

function resolveEndpoint(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined
  const value = process.env?.[name]
  return value && value.length > 0 ? value : undefined
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "assistant": {
      const wire: Record<string, unknown> = {
        role: "assistant",
        content: message.content ?? null,
      }
      if (message.toolCalls?.length) {
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments:
              typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments),
          },
        }))
      }
      return wire
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    case "system":
    case "user":
      return { role: message.role, content: message.content }
  }
}

interface WireToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface WireCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function parseCompletion(payload: unknown): CompletionResponse {
  const wire = payload as WireCompletion
  const message = wire.choices?.[0]?.message
  if (!message) {
    throw new Error("completion response carried no choices[0].message")
  }

  const toolCalls: ToolCallRequest[] = (message.tool_calls ?? []).map(
    (call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }),
  )

  const usage: CompletionUsage | undefined = wire.usage
    ? {
        ...(wire.usage.prompt_tokens !== undefined
          ? { inputTokens: wire.usage.prompt_tokens }
          : {}),
        ...(wire.usage.completion_tokens !== undefined
          ? { outputTokens: wire.usage.completion_tokens }
          : {}),
        ...(wire.usage.total_tokens !== undefined
          ? { totalTokens: wire.usage.total_tokens }
          : {}),
      }
    : undefined

  return {
    message: {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    ...(usage ? { usage } : {}),
  }
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
