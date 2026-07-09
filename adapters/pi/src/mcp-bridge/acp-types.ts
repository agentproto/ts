/**
 * `AcpMcpServer` — the injected-MCP-server shape the host passes to
 * `connect({ mcpServers })`. It originates in `@agentproto/acp` and is
 * re-exported by `@agentproto/driver-agent-cli`, but the driver's bundled `.d.ts`
 * elides the external re-export (rollup-dts without resolve). We recover it via
 * indexed access on `AgentCliConnectOptions["mcpServers"]` — no extra dependency,
 * no dependence on a symbol the built types don't surface.
 */

import type { AgentCliConnectOptions } from "@agentproto/driver-agent-cli"

export type AcpMcpServer = NonNullable<AgentCliConnectOptions["mcpServers"]>[number]
