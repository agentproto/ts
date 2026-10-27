/**
 * AIP-45 protocol arm: `protocol: "mcp"`.
 *
 * Wraps an MCP-over-stdio binary; tool calls flow as MCP tool
 * invocations and are mapped at this boundary into the canonical
 * StreamEvent taxonomy.
 */

import type { AgentCliClient } from "../types.js"

export function createMcpProtocolArm(): AgentCliClient {
  throw new Error("createMcpProtocolArm: not yet implemented")
}
