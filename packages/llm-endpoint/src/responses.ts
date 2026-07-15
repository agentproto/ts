/**
 * OpenAI Responses API → OpenAI Chat Completions facade.
 *
 * Codex custom providers require `wire_api = "responses"` and POST to
 * `<base_url>/responses`. This module translates those requests into the
 * provider's OpenAI-compatible chat/completions endpoint and converts the
 * upstream response back into the Responses API contract.
 */

// ── Request types ──────────────────────────────────────────────────────────

export interface ResponsesInputText {
  type: 'input_text';
  text: string;
}

export interface ResponsesOutputText {
  type: 'output_text';
  text: string;
}

export type ResponsesContentItem = ResponsesInputText | ResponsesOutputText;

export interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesContentItem[];
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesReasoning {
  effort?: 'low' | 'medium' | 'high';
  summary?: 'auto' | 'detailed' | 'concise' | 'auto_verbose';
}

export interface ResponsesTextControls {
  verbosity?: 'low' | 'medium' | 'high';
  format?: unknown;
}

export interface ResponsesRequestBody {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesFunctionTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  stream?: boolean;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  // Provider metadata that the facade accepts but cannot preserve across the
  // chat/completions translation; they are dropped after validation.
  store?: boolean;
  include?: string[];
  client_metadata?: Record<string, string>;
  service_tier?: string;
  prompt_cache_key?: string;
  stream_options?: unknown;
  reasoning?: ResponsesReasoning;
  text?: ResponsesTextControls;
  // Explicitly unsupported.
  previous_response_id?: string;
}

// ── Chat Completions types ─────────────────────────────────────────────────

export interface ChatCompletionsMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionsTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  strict?: boolean;
}

export interface ChatCompletionsRequestBody {
  model: string;
  messages: ChatCompletionsMessage[];
  tools?: ChatCompletionsTool[];
  tool_choice?: unknown;
  stream?: boolean;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
}

// ── Validation ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected ${field} to be a string`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, field);
}

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`Expected ${field} to be a number`);
  }
  return value;
}

function assertOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new TypeError(`Expected ${field} to be a boolean`);
  }
  return value;
}

function validateContentItem(item: unknown): ResponsesContentItem {
  if (!isPlainObject(item)) {
    throw new TypeError('Input message content items must be objects');
  }
  const type = item.type;
  if (type !== 'input_text' && type !== 'output_text') {
    throw new TypeError(
      `Unsupported input message content item type "${String(type)}"; only "input_text" and "output_text" are supported`
    );
  }
  return { type, text: assertString(item.text, 'content item text') };
}

function validateInputItem(item: unknown): ResponsesInputItem {
  if (!isPlainObject(item)) {
    throw new TypeError('Input items must be objects');
  }
  const type = item.type;
  if (type === 'message') {
    const role = assertString(item.role, 'input message role');
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
      throw new TypeError(
        `Unsupported input message role "${role}"; only "user", "assistant", "system", and "developer" are supported`
      );
    }
    let content: string | ResponsesContentItem[];
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content.map(validateContentItem);
    } else {
      throw new TypeError('Input message content must be a string or an array of content items');
    }
    return { type: 'message', role, content };
  }
  if (type === 'function_call_output') {
    return {
      type: 'function_call_output',
      call_id: assertString(item.call_id, 'function_call_output call_id'),
      output: typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? {}),
    };
  }
  throw new TypeError(
    `Unsupported input item type "${String(type)}"; only "message" and "function_call_output" are supported`
  );
}

function validateTool(tool: unknown): ResponsesFunctionTool {
  if (!isPlainObject(tool)) {
    throw new TypeError('Tools must be objects');
  }
  if (tool.type !== 'function') {
    throw new TypeError(
      `Unsupported tool type "${String(tool.type)}"; only "function" tools are supported`
    );
  }
  return {
    type: 'function',
    name: assertString(tool.name, 'tool name'),
    description: assertOptionalString(tool.description, 'tool description'),
    parameters: isPlainObject(tool.parameters) ? tool.parameters : undefined,
    strict: assertOptionalBoolean(tool.strict, 'tool strict'),
  };
}

/**
 * Validates and normalizes an incoming OpenAI Responses API request body.
 * Throws a descriptive TypeError for unsupported constructs before any
 * provider I/O occurs.
 */
export function validateResponsesRequest(body: unknown): ResponsesRequestBody {
  if (!isPlainObject(body)) {
    throw new TypeError('Request body must be a JSON object');
  }

  const model = assertString(body.model, 'model');

  let input: string | ResponsesInputItem[];
  if (typeof body.input === 'string') {
    input = body.input;
  } else if (Array.isArray(body.input)) {
    input = body.input.map(validateInputItem);
  } else {
    throw new TypeError('"input" must be a string or an array of input items');
  }

  const instructions = assertOptionalString(body.instructions, 'instructions');

  let tools: ResponsesFunctionTool[] | undefined;
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      throw new TypeError('"tools" must be an array');
    }
    tools = body.tools.map(validateTool);
  }

  let toolChoice: ResponsesRequestBody['tool_choice'];
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    if (typeof body.tool_choice === 'string') {
      const tc = body.tool_choice;
      if (tc !== 'auto' && tc !== 'none' && tc !== 'required') {
        throw new TypeError(
          `Unsupported tool_choice "${tc}"; must be "auto", "none", "required", or a function object`
        );
      }
      toolChoice = tc;
    } else if (isPlainObject(body.tool_choice)) {
      const tc = body.tool_choice;
      if (tc.type !== 'function') {
        throw new TypeError(
          `Unsupported tool_choice type "${String(tc.type)}"; only "function" is supported`
        );
      }
      toolChoice = {
        type: 'function',
        name: assertString(tc.name, 'tool_choice function name'),
      };
    } else {
      throw new TypeError('"tool_choice" must be a string or an object');
    }
  }

  // Unsupported constructs that cannot be preserved across the translation.
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new TypeError(
      '"previous_response_id" is not supported; the facade translates each request independently'
    );
  }
  if (
    body.text !== undefined &&
    body.text !== null &&
    isPlainObject(body.text) &&
    body.text.format !== undefined &&
    body.text.format !== null
  ) {
    throw new TypeError(
      '"text.format" / structured output is not supported by this facade'
    );
  }

  const result: ResponsesRequestBody = {
    model,
    input,
    instructions,
    tools,
    tool_choice: toolChoice,
    stream: assertOptionalBoolean(body.stream, 'stream'),
    parallel_tool_calls: assertOptionalBoolean(body.parallel_tool_calls, 'parallel_tool_calls'),
    max_output_tokens: assertOptionalNumber(body.max_output_tokens, 'max_output_tokens'),
    max_tokens: assertOptionalNumber(body.max_tokens, 'max_tokens'),
    temperature: assertOptionalNumber(body.temperature, 'temperature'),
    top_p: assertOptionalNumber(body.top_p, 'top_p'),
    // Harmless provider metadata: accepted to keep Codex happy, but dropped
    // before the upstream call because chat/completions does not preserve them.
    store: assertOptionalBoolean(body.store, 'store'),
    include: Array.isArray(body.include) ? body.include.map((v) => assertString(v, 'include')) : undefined,
    client_metadata: isPlainObject(body.client_metadata) ? body.client_metadata as Record<string, string> : undefined,
    service_tier: assertOptionalString(body.service_tier, 'service_tier'),
    prompt_cache_key: assertOptionalString(body.prompt_cache_key, 'prompt_cache_key'),
    stream_options: body.stream_options,
    reasoning: body.reasoning !== undefined && body.reasoning !== null
      ? {
          effort: ['low', 'medium', 'high'].includes(String((body.reasoning as any).effort))
            ? (String((body.reasoning as any).effort) as 'low' | 'medium' | 'high')
            : undefined,
          summary: ['auto', 'detailed', 'concise', 'auto_verbose'].includes(
            String((body.reasoning as any).summary)
          )
            ? (String((body.reasoning as any).summary) as 'auto' | 'detailed' | 'concise' | 'auto_verbose')
            : undefined,
        }
      : undefined,
    text: body.text !== undefined && body.text !== null
      ? { verbosity: ['low', 'medium', 'high'].includes(String((body.text as any).verbosity))
          ? (String((body.text as any).verbosity) as 'low' | 'medium' | 'high')
          : undefined }
      : undefined,
  };

  return result;
}

// ── Request translation: Responses → Chat Completions ──────────────────────

function flattenContent(content: string | ResponsesContentItem[]): string {
  if (typeof content === 'string') return content;
  return content.map((c) => c.text).join('');
}

function translateInputToMessages(
  input: string | ResponsesInputItem[],
  instructions: string | undefined
): ChatCompletionsMessage[] {
  const messages: ChatCompletionsMessage[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input) {
    if (item.type === 'message') {
      messages.push({
        role: item.role === 'developer' ? 'system' : item.role,
        content: flattenContent(item.content),
      });
    } else if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      });
    }
  }

  return messages;
}

function translateToolToChatCompletions(tool: ResponsesFunctionTool): ChatCompletionsTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    strict: tool.strict,
  };
}

function translateToolChoice(toolChoice: ResponsesRequestBody['tool_choice']): unknown {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  return {
    type: 'function',
    function: { name: toolChoice.name },
  };
}

/**
 * Converts a validated Responses API request into an OpenAI Chat Completions
 * request that the existing provider infrastructure can forward.
 */
export function responsesToChatCompletionsRequest(
  body: ResponsesRequestBody,
  _resolvedTarget: { provider: string; model: string }
): ChatCompletionsRequestBody {
  const messages = translateInputToMessages(body.input, body.instructions);

  const result: ChatCompletionsRequestBody = {
    model: _resolvedTarget.model,
    messages,
    stream: body.stream,
    parallel_tool_calls: body.parallel_tool_calls,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
  };

  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map(translateToolToChatCompletions);
  }

  if (body.tool_choice) {
    result.tool_choice = translateToolChoice(body.tool_choice);
  }

  // Map Responses reasoning.effort to the OpenAI chat/completions parameter.
  // Reasoning summary is Responses-API-specific and is dropped.
  if (body.reasoning?.effort) {
    result.reasoning_effort = body.reasoning.effort;
  }

  return result;
}

// ── Response translation: Chat Completions → Responses API ─────────────────

function generateResponseId(): string {
  return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateOutputItemId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function chatChoiceToOutputItems(choice: any): any[] {
  const output: any[] = [];
  const msg = choice && choice.message;
  if (!msg) return output;

  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    output.push({
      type: 'message',
      id: generateOutputItemId('msg'),
      role: 'assistant',
      content: [
        { type: 'output_text', text, annotations: [] },
      ],
    });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function || {};
      output.push({
        type: 'function_call',
        id: tc.id || generateOutputItemId('fc'),
        call_id: tc.id || generateOutputItemId('call'),
        name: fn.name || '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      });
    }
  }

  return output;
}

function chatUsageToResponsesUsage(usage: any): any {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: usage?.total_tokens ?? prompt + completion,
  };
}

/**
 * Converts a non-streaming OpenAI Chat Completions JSON response into an
 * OpenAI Responses API JSON response.
 */
export function chatCompletionsJsonToResponses(
  jsonStr: string,
  opts: { requestedModel: string; responseId?: string }
): string {
  try {
    const upstream = JSON.parse(jsonStr);
    if (upstream && typeof upstream === 'object' && upstream.error) {
      return JSON.stringify({
        error: upstream.error,
      });
    }

    const choice = upstream.choices && upstream.choices[0];
    const responseId = opts.responseId || upstream.id || generateResponseId();
    const now = Math.floor(Date.now() / 1000);

    const response = {
      id: responseId,
      object: 'response',
      created_at: now,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: opts.requestedModel,
      output: chatChoiceToOutputItems(choice),
      parallel_tool_calls: upstream.parallel_tool_calls ?? false,
      tool_choice: 'auto',
      tools: [],
      usage: chatUsageToResponsesUsage(upstream.usage),
    };

    return JSON.stringify(response);
  } catch {
    return jsonStr;
  }
}

// ── Streaming translation ──────────────────────────────────────────────────

interface StreamState {
  responseId: string;
  requestedModel: string;
  textItemId: string | null;
  textStarted: boolean;
  toolItems: Map<number, { id: string; callId: string; name: string; index: number }>;
  accUsage: { prompt_tokens?: number; completion_tokens?: number };
  finished: boolean;
  sentCreated: boolean;
}

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createInitialResponse(responseId: string, model: string): any {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Converts an upstream OpenAI Chat Completions SSE stream into an OpenAI
 * Responses API SSE stream. Emits the events Codex needs:
 *   response.created
 *   response.output_item.added
 *   response.output_text.delta
 *   response.output_item.done
 *   response.custom_tool_call_input.delta
 *   response.completed
 */
export class OpenAIChatToResponsesStreamConverter {
  private state: StreamState;
  private buffer = '';

  constructor(opts: { requestedModel: string; responseId?: string }) {
    this.state = {
      responseId: opts.responseId || generateResponseId(),
      requestedModel: opts.requestedModel,
      textItemId: null,
      textStarted: false,
      toolItems: new Map(),
      accUsage: {},
      finished: false,
      sentCreated: false,
    };
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    const parts = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      const transformed = this.transformEvent(part);
      if (transformed) out.push(...transformed);
    }
    return out;
  }

  flush(): string[] {
    if (this.buffer.trim()) {
      const transformed = this.transformEvent(this.buffer);
      this.buffer = '';
      return transformed || [];
    }
    return [];
  }

  private ensureCreated(): string[] {
    if (this.state.sentCreated) return [];
    this.state.sentCreated = true;
    return [sse('response.created', {
      type: 'response.created',
      response: createInitialResponse(this.state.responseId, this.state.requestedModel),
    })];
  }

  private transformEvent(rawEvent: string): string[] | null {
    const lines = rawEvent.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return null;

    const out: string[] = [];
    for (const dl of dataLines) {
      if (dl === '[DONE]') {
        if (this.state.finished) continue;
        out.push(...this.finalize());
        this.state.finished = true;
        continue;
      }

      let data: any;
      try { data = JSON.parse(dl); } catch { continue; }

      const choice = data.choices && data.choices[0];
      const delta = choice && choice.delta;
      const content = delta && delta.content;
      const toolCalls = delta && delta.tool_calls;

      out.push(...this.ensureCreated());

      // Text streaming.
      if (typeof content === 'string') {
        if (!this.state.textItemId) {
          this.state.textItemId = generateOutputItemId('msg');
          out.push(sse('response.output_item.added', {
            type: 'response.output_item.added',
            item: {
              type: 'message',
              id: this.state.textItemId,
              role: 'assistant',
              content: [],
            },
            output_index: 0,
          }));
        }
        if (content) {
          if (!this.state.textStarted) {
            out.push(sse('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: this.state.textItemId,
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            }));
            this.state.textStarted = true;
          }
          out.push(sse('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: this.state.textItemId,
            output_index: 0,
            content_index: 0,
            delta: content,
          }));
        }
      }

      // Tool call streaming.
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          let tool = this.state.toolItems.get(idx);
          if (tc.function && tc.function.name && !tool) {
            tool = {
              id: tc.id || generateOutputItemId('fc'),
              callId: tc.id || generateOutputItemId('call'),
              name: tc.function.name,
              index: idx,
            };
            this.state.toolItems.set(idx, tool);
            out.push(sse('response.output_item.added', {
              type: 'response.output_item.added',
              item: {
                type: 'function_call',
                id: tool.id,
                call_id: tool.callId,
                name: tool.name,
                arguments: '',
              },
              output_index: this.state.textItemId ? 1 : 0,
            }));
          }
          if (tool && tc.function && tc.function.arguments) {
            out.push(sse('response.custom_tool_call_input.delta', {
              type: 'response.custom_tool_call_input.delta',
              item_id: tool.id,
              call_id: tool.callId,
              delta: tc.function.arguments,
            }));
          }
        }
      }

      // Usage accumulation.
      const u = data.x_groq && data.x_groq.usage ? data.x_groq.usage : data.usage;
      if (u) {
        if (u.prompt_tokens != null) this.state.accUsage.prompt_tokens = u.prompt_tokens;
        if (u.completion_tokens != null) this.state.accUsage.completion_tokens = u.completion_tokens;
      }

      // Finish reason handling.
      const fr = choice && choice.finish_reason;
      if (fr && !this.state.finished) {
        out.push(...this.finalize());
        this.state.finished = true;
      }
    }

    return out.length ? out : null;
  }

  private finalize(): string[] {
    const out: string[] = [];

    if (this.state.textItemId) {
      if (this.state.textStarted) {
        out.push(sse('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: this.state.textItemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        }));
      }
      out.push(sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: this.state.textItemId,
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        },
        output_index: 0,
      }));
    }

    this.state.toolItems.forEach((tool, idx) => {
      out.push(sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: tool.id,
          call_id: tool.callId,
          name: tool.name,
          arguments: '',
        },
        output_index: this.state.textItemId ? 1 + idx : idx,
      }));
    });

    const usage = {
      input_tokens: this.state.accUsage.prompt_tokens || 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: this.state.accUsage.completion_tokens || 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (this.state.accUsage.prompt_tokens || 0) + (this.state.accUsage.completion_tokens || 0),
    };

    out.push(sse('response.completed', {
      type: 'response.completed',
      response: {
        id: this.state.responseId,
        object: 'response',
        status: 'completed',
        output: [],
        usage,
      },
    }));

    return out;
  }
}
