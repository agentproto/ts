/**
 * `@agentproto/code-brain/mcp` — AIP-32 MCP surface projection for the
 * `ask_codebase` contract.
 *
 * This is the tracked replacement path for the untracked home-dir MCP
 * server: a later adapter (e.g. one fronting a real code-intel engine)
 * calls {@link defineCodeBrainMcpDriver} with its `server` / `transport` /
 * `mcpClientFactory` to obtain a conformant provider that serves
 * `ask_codebase` over MCP. This module wires the projection only — it takes
 * no backend and connects to nothing at import time (v0.1 keeps the MCP
 * client injection-shaped, per `@agentproto/driver-mcp`).
 */

import { defineMcpDriver, type McpDriverDefinition } from "@agentproto/driver-mcp"
import type { DriverHandle } from "@agentproto/driver"
import { askCodebaseTool } from "../tools/ask-codebase.tool.js"

export interface CodeBrainMcpProjectionOptions {
  /** MCP server config the backend exposes `ask_codebase` on. */
  readonly server: McpDriverDefinition["server"]
  /** Transport the server speaks. */
  readonly transport: McpDriverDefinition["transport"]
  /** Optional MCP protocol version pin. */
  readonly protocolVersion?: string
  /** Host-supplied connected-client factory (wraps `@modelcontextprotocol/sdk`). */
  readonly mcpClientFactory: McpDriverDefinition["mcpClientFactory"]
  /** Provider id override. Default `code-brain-mcp`. */
  readonly id?: string
  /** Upstream MCP tool name, when it differs from the contract id `ask_codebase`. */
  readonly mcpToolName?: string
}

/**
 * Build an AIP-32 MCP provider for the `ask_codebase` contract. Thin sugar
 * over `defineMcpDriver` that pins `implements` to the single contract this
 * package owns — the caller supplies only the transport wiring.
 */
export function defineCodeBrainMcpDriver(
  options: CodeBrainMcpProjectionOptions,
): DriverHandle {
  return defineMcpDriver({
    id: options.id ?? "code-brain-mcp",
    name: "Code Brain (MCP projection)",
    description:
      "AIP-32 MCP projection of the ask_codebase contract — dispatches the " +
      "tool to an MCP endpoint supplied by the caller.",
    version: "0.1.0",
    server: options.server,
    transport: options.transport,
    ...(options.protocolVersion !== undefined
      ? { protocolVersion: options.protocolVersion }
      : {}),
    mcpClientFactory: options.mcpClientFactory,
    implements: [
      {
        tool: askCodebaseTool.id,
        version: askCodebaseTool.version ?? "0.1.0",
        ...(options.mcpToolName !== undefined
          ? { metadata: { mcp: { toolName: options.mcpToolName } } }
          : {}),
      },
    ],
  })
}
