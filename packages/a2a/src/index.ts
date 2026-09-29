/**
 * @agentproto/a2a — A2A (Agent2Agent) Agent Card types and builders for
 * agentproto apps. Protocol: https://a2a-protocol.org
 */

export { A2A_BINDING_JSONRPC, A2A_PROTOCOL_VERSION } from "./types.js"
export type {
  AgentCard,
  AgentCapabilities,
  AgentCardSignature,
  AgentExtension,
  AgentInterface,
  AgentProvider,
  AgentSkill,
  APIKeySecurityScheme,
  HTTPAuthSecurityScheme,
  SecurityRequirement,
  SecurityScheme,
  StringList,
} from "./types.js"
export {
  appA2aUrl,
  appExposesAnything,
  buildAppAgentCard,
  buildDaemonAgentCard,
} from "./card.js"
export type {
  AppCardExposes,
  AppCardInput,
  DaemonCardInput,
  SkillSource,
} from "./card.js"
