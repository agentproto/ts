/**
 * @agentproto/connector — public surface.
 *
 * `ConnectorMcpDescriptor` is the portable, host-agnostic description of an MCP
 * connector (how its server runs / is reached) + the credential requirements
 * vocabulary. Consumers (guilde, a CLI, a third party) import the type to
 * describe connectors against the open standard; catalog/marketplace metadata,
 * vault wiring, and host-specific resolution stay in the consumer.
 */

// descriptor
export type {
  ConnectorMcpDescriptor,
  ConnectorMcpKind,
  HostedConnectorMcp,
  SandboxConnectorMcp,
  ExternalConnectorMcp,
  LocalDaemonConnectorMcp,
} from "./descriptor.js"

// credential requirements
export type {
  ConnectorCredentialRequirement,
  ConnectorSecretKind,
} from "./requirements.js"

// guards + schema
export {
  isHostedConnector,
  isSandboxConnector,
  isExternalConnector,
  isLocalDaemonConnector,
  connectorMcpSchema,
  parseConnectorMcp,
  safeParseConnectorMcp,
} from "./guards.js"
