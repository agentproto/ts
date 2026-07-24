/**
 * `@agentproto/knowledge-engine/mcp` — AIP-32 MCP surface projection for the
 * `kb_query` + `kb_ingest` contracts.
 *
 * A later adapter (one fronting a real retrieval engine) calls
 * {@link defineKnowledgeEngineMcpDriver} with its `server` / `transport` /
 * `mcpClientFactory` to obtain a conformant provider that serves both tools
 * over MCP. Projection wiring only — no backend, connects to nothing at
 * import time. Mirrors code-brain's `mcp/index.ts`
 * (`packages/code-brain/src/mcp/index.ts`).
 */

import { defineMcpDriver, type McpDriverDefinition } from "@agentproto/driver-mcp"
import type { DriverHandle } from "@agentproto/driver"
import { kbQueryTool } from "../tools/kb-query.tool.js"
import { kbIngestTool } from "../tools/kb-ingest.tool.js"

export interface KnowledgeEngineMcpProjectionOptions {
  /** MCP server config the backend exposes the tools on. */
  readonly server: McpDriverDefinition["server"]
  /** Transport the server speaks. */
  readonly transport: McpDriverDefinition["transport"]
  /** Optional MCP protocol version pin. */
  readonly protocolVersion?: string
  /** Host-supplied connected-client factory (wraps `@modelcontextprotocol/sdk`). */
  readonly mcpClientFactory: McpDriverDefinition["mcpClientFactory"]
  /** Provider id override. Default `knowledge-engine-mcp`. */
  readonly id?: string
  /** Upstream MCP tool name for `kb_query`, when it differs from the contract id. */
  readonly queryToolName?: string
  /** Upstream MCP tool name for `kb_ingest`, when it differs from the contract id. */
  readonly ingestToolName?: string
}

/**
 * Build an AIP-32 MCP provider for the knowledge-engine contracts. Thin
 * sugar over `defineMcpDriver` that pins `implements` to the two contracts
 * this package owns — the caller supplies only the transport wiring.
 */
export function defineKnowledgeEngineMcpDriver(
  options: KnowledgeEngineMcpProjectionOptions,
): DriverHandle {
  return defineMcpDriver({
    id: options.id ?? "knowledge-engine-mcp",
    name: "Knowledge Engine (MCP projection)",
    description:
      "AIP-32 MCP projection of the kb_query / kb_ingest contracts — " +
      "dispatches the tools to an MCP endpoint supplied by the caller.",
    version: "0.1.0",
    server: options.server,
    transport: options.transport,
    ...(options.protocolVersion !== undefined
      ? { protocolVersion: options.protocolVersion }
      : {}),
    mcpClientFactory: options.mcpClientFactory,
    implements: [
      {
        tool: kbQueryTool.id,
        version: kbQueryTool.version ?? "0.1.0",
        ...(options.queryToolName !== undefined
          ? { metadata: { mcp: { toolName: options.queryToolName } } }
          : {}),
      },
      {
        tool: kbIngestTool.id,
        version: kbIngestTool.version ?? "0.1.0",
        ...(options.ingestToolName !== undefined
          ? { metadata: { mcp: { toolName: options.ingestToolName } } }
          : {}),
      },
    ],
  })
}
