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
import type { ToolContext, ToolHandle } from "@agentproto/tool"

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
  const inputShape: ZodRawShape =
    objectShape ?? (tool.inputSchema != null ? { input: tool.inputSchema } : {})

  const resolveContext = async (): Promise<unknown> =>
    typeof opts.context === "function"
      ? await (opts.context as () => TContext | Promise<TContext>)()
      : opts.context

  return {
    name: opts.name ? mcpName(opts.name) : mcpName(tool.id),
    description: tool.description,
    inputShape,
    handler: async (args) => {
      const input = objectShape ? args : (args.input as unknown)
      const context = await resolveContext()
      const output = await runTool({
        tool,
        candidates,
        input,
        context,
        resolverContext: opts.resolverContext,
        secrets: opts.secrets,
      })
      return contentText(output)
    },
  }
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
