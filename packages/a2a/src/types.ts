/**
 * A2A Agent Card types, hand-written from the A2A 1.0 normative definition
 * (`specification/a2a.proto`, rendered as ProtoJSON: camelCase members,
 * oneofs as wrapper keys). Field names are the protocol's, verbatim — do not
 * rename.
 */

/** The A2A spec version these types and the builders target. */
export const A2A_PROTOCOL_VERSION = "1.0" as const

/** Protocol binding token of the JSON-RPC 2.0 over HTTP binding. */
export const A2A_BINDING_JSONRPC = "JSONRPC" as const

export interface AgentProvider {
  url: string
  organization: string
}

export interface AgentExtension {
  uri?: string
  description?: string
  required?: boolean
  params?: Record<string, unknown>
}

export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  extensions?: AgentExtension[]
  extendedAgentCard?: boolean
}

export interface StringList {
  list: string[]
}

/** `schemes` maps a `securitySchemes` key to the scopes it requires. */
export interface SecurityRequirement {
  schemes: Record<string, StringList>
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  securityRequirements?: SecurityRequirement[]
}

export interface AgentInterface {
  url: string
  /** `"JSONRPC"`, `"GRPC"` or `"HTTP+JSON"`. */
  protocolBinding: string
  tenant?: string
  /** A2A `Major.Minor` this interface speaks. */
  protocolVersion: string
}

export interface HTTPAuthSecurityScheme {
  description?: string
  scheme: string
  bearerFormat?: string
}

export interface APIKeySecurityScheme {
  description?: string
  /** `"query"`, `"header"` or `"cookie"`. */
  location: string
  name: string
}

/** Oneof wrapper: exactly one member is set. */
export type SecurityScheme =
  | { httpAuthSecurityScheme: HTTPAuthSecurityScheme }
  | { apiKeySecurityScheme: APIKeySecurityScheme }

export interface AgentCardSignature {
  protected: string
  signature: string
  header?: Record<string, unknown>
}

export interface AgentCard {
  name: string
  description: string
  supportedInterfaces: AgentInterface[]
  provider?: AgentProvider
  version: string
  documentationUrl?: string
  capabilities: AgentCapabilities
  securitySchemes?: Record<string, SecurityScheme>
  securityRequirements?: SecurityRequirement[]
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
  signatures?: AgentCardSignature[]
  iconUrl?: string
}
