/**
 * toMcpTool — expose an AIP-14 TOOL contract as a callable MCP tool whose body
 * is `runTool` (resolve DRIVER → validate → execute → validate). The mirror of
 * the Mastra `resolveTool` adapter: one TOOL handle, one resolver, three call
 * surfaces (CLI, agent, MCP) with no per-surface re-coding.
 *
 * Framework-only: it takes a handle + candidate DRIVERs and never knows what
 * the tool does. The injected per-call `context` (live capabilities such as a
 * warm browser session) is baked in at registration by the composition root —
 * an MCP client supplies only the tool's declared input, never context.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ZodRawShape, ZodType } from "zod"
import { runTool, type DriverHandle, type ResolverContext } from "@agentproto/driver"
import type {
  ToolContext,
  ToolHandle,
  ToolTransformer,
} from "@agentproto/tool"

export interface ToMcpToolOptions<
  TInput,
  TOutput,
  TContext extends ToolContext,
> {
  /** The AIP-14 contract to expose. */
  tool: ToolHandle<TInput, TOutput, TContext>
  /** Candidate DRIVERs the resolver dispatches over. */
  candidates: readonly DriverHandle[]
  /**
   * Cross-cutting concerns applied at registration, composed left-to-right
   * in declared order (first declared = outermost wrapper). Overrides the
   * contract's own `tool.transformers` when provided.
   */
  transformers?: readonly ToolTransformer[]
  /**
   * Per-call injected context (live capabilities). A value, or a factory run
   * once per invocation (e.g. to lease a fresh session). Omit for context-free
   * tools (`report.render`).
   */
  context?:
    | TContext
    | (() => TContext | Promise<TContext>)
  /** Resolver routing hints (region, pinned provider, policy tags). */
  resolverContext?: ResolverContext
  /** Resolved secrets to inject into the DriverContext. */
  secrets?: Record<string, string>
  /** Override the advertised MCP tool name (default: tool id, `:`/`.`→`_`). */
  name?: string
}

/** What `buildMcpTool` produces — registerable on any McpServer, and directly
 *  callable in tests without standing up a transport. */
export interface McpToolRegistration {
  name: string
  description: string
  inputShape: ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>
    isError?: boolean
  }>
}

/** A ZodObject exposes a `.shape` raw-shape getter; everything else doesn't. */
function asObjectShape(schema: ZodType): ZodRawShape | undefined {
  const shape = (schema as { shape?: unknown }).shape
  return shape && typeof shape === "object"
    ? (shape as ZodRawShape)
    : undefined
}

function mcpName(id: string): string {
  return id.replace(/[-:.]/g, "_")
}

function contentText(payload: unknown): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  }
}

/**
 * Build (but do not register) the MCP tool. When the contract's `inputSchema`
 * is an object schema, its fields become the MCP tool's parameters directly;
 * otherwise the input is taken under a single `input` parameter carrying the
 * whole schema.
 */
export function buildMcpTool<TInput, TOutput, TContext extends ToolContext>(
  opts: ToMcpToolOptions<TInput, TOutput, TContext>,
): McpToolRegistration {
  const { tool, candidates } = opts
  // `inputSchema` is optional (manifest-only tools declare IO via JSON Schema,
  // not a zod schema). Guard against undefined: a zod object → its shape; a
  // non-object zod schema → a single `input` field; no zod schema → no declared
  // MCP params (`{}`).
  const objectShape =
    tool.inputSchema != null ? asObjectShape(tool.inputSchema) : undefined
  let inputShape: ZodRawShape =
    objectShape ?? (tool.inputSchema != null ? { input: tool.inputSchema } : {})

  // Transformers (this option overrides the contract's own list), composed
  // LEFT-TO-RIGHT in declared order: the first transformer listed ends up
  // the OUTERMOST wrapper around the handler pipeline (see
  // ToolTransformer's JSDoc). wrapShape applies in the same declared order.
  const transformers = opts.transformers ?? tool.transformers
  for (const t of transformers ?? []) {
    if (t.wrapShape) inputShape = t.wrapShape(inputShape)
  }

  const resolveContext = async (): Promise<unknown> =>
    typeof opts.context === "function"
      ? await (opts.context as () => TContext | Promise<TContext>)()
      : opts.context

  // Base pipeline: resolve → validate → execute → validate → raw output.
  // Serialization happens at the boundary below, so transformers see the
  // unserialized value and may terminate the pipeline with a pre-serialized
  // MCP text result instead.
  let handler: (input: unknown) => Promise<unknown> = async (input) => {
    const context = await resolveContext()
    return runTool({
      tool,
      candidates,
      input,
      context,
      resolverContext: opts.resolverContext,
      secrets: opts.secrets,
    })
  }
  if (transformers) {
    for (let i = transformers.length - 1; i >= 0; i--) {
      const t = transformers[i]!
      const next = t.wrapHandler(handler as never) as (
        input: unknown,
      ) => Promise<unknown>
      handler = next
    }
  }

  return {
    name: opts.name ? mcpName(opts.name) : mcpName(tool.id),
    description: tool.description,
    inputShape,
    handler: async (args) => {
      const input = objectShape ? args : (args.input as unknown)
      const output = await handler(input)
      // A transformer that terminates the pipeline returns a pre-serialized
      // MCP text result — pass it through verbatim. Anything else (the
      // untransformed tool output) gets the default JSON serialization.
      return isMcpTextResult(output)
        ? output
        : contentText(output)
    },
  }
}

function isMcpTextResult(value: unknown): value is {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  )
}

/**
 * Register a TOOL contract as a callable MCP tool on `server`, dispatching each
 * call through `runTool`. Returns the registration (handy for diagnostics /
 * tests). Once registered, the tool is callable from any MCP host with no
 * per-host code.
 */
export function toMcpTool<TInput, TOutput, TContext extends ToolContext>(
  server: McpServer,
  opts: ToMcpToolOptions<TInput, TOutput, TContext>,
): McpToolRegistration {
  const reg = buildMcpTool(opts)
  server.tool(reg.name, reg.description, reg.inputShape, reg.handler)
  return reg
}
