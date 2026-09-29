/**
 * A2A Agent Card types, hand-written from the A2A JSON specification
 * (protocol version {@link A2A_PROTOCOL_VERSION}). Field names are the
 * protocol's, verbatim — do not rename.
 */

/** The A2A spec version these types and the builders target. */
export const A2A_PROTOCOL_VERSION = "0.3.0" as const

export interface AgentProvider {
  organization: string
  url: string
}

export interface AgentExtension {
  uri: string
  description?: string
  required?: boolean
  params?: Record<string, unknown>
}

export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
  extensions?: AgentExtension[]
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  security?: Array<Record<string, string[]>>
}

export interface AgentInterface {
  url: string
  transport: string
}

export interface HTTPAuthSecurityScheme {
  type: "http"
  scheme: string
  bearerFormat?: string
  description?: string
}

export interface APIKeySecurityScheme {
  type: "apiKey"
  in: "query" | "header" | "cookie"
  name: string
  description?: string
}

export type SecurityScheme = HTTPAuthSecurityScheme | APIKeySecurityScheme

export interface AgentCard {
  protocolVersion: string
  name: string
  description: string
  /** Preferred endpoint (JSON-RPC unless `preferredTransport` says otherwise). */
  url: string
  preferredTransport?: string
  additionalInterfaces?: AgentInterface[]
  iconUrl?: string
  provider?: AgentProvider
  version: string
  documentationUrl?: string
  capabilities: AgentCapabilities
  securitySchemes?: Record<string, SecurityScheme>
  security?: Array<Record<string, string[]>>
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
  supportsAuthenticatedExtendedCard?: boolean
}
