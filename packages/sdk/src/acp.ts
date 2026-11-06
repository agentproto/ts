/**
 * `@agentproto/sdk/acp` - AIP-44 ACP runtime surface.
 *
 * Kept on its own subpath so importing the umbrella root does not pull in
 * the ACP SDK. Peer dependency: `@agentproto/acp`.
 */

export { createAcpClient } from "@agentproto/acp/client"
export type {
  AcpClient,
  AcpClientOptions,
  AcpClientSession,
  SteerOutcome,
} from "@agentproto/acp/client"

export { createAcpServer } from "@agentproto/acp/server"
export type {
  AcpServer,
  AcpServerOptions,
  AcpServerSessionContext,
} from "@agentproto/acp/server"
