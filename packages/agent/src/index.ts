/**
 * @agentproto/agent — AIP-42 AGENT.md `defineAgent` reference impl.
 *
 * A markdown + frontmatter format for declaring a runnable agent — composes identity, persona, model, tools, actions, skills, workflows, runner, memory, governance, policy, and routines into a single manifest. Standalone runnable in any AIP-9 OPERATOR-conforming runtime. Body is the system prompt. Operators (AIP-9) extend AGENT with organizational context (role, company binding, dynamic per-request resolution).
 *
 * Spec: https://agentproto.sh/docs/aip-42
 *
 * Authoring paths:
 *   - TS:  `defineAgent({...})` → `AgentHandle`
 *   - MD:  `parseAgentManifest(src) → agentFromManifest({...})` → `AgentHandle`
 */

export const SPEC_NAME = "agentagent/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineAgent } from "./define-agent.js"
export type {
  AgentDefinition,
  AgentHandle,
  AnyRef,
  ActionRef,
  ModelRef,
  MemoryConfig,
} from "./types.js"
export { agentSpec, agentVerbs } from "./spec.js"
export {
  parseAgentManifest,
  agentFromManifest,
  agentFrontmatterSchema,
  type AgentManifest,
} from "./manifest/index.js"
