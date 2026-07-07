/**
 * @agentproto/sandbox — AIP-36 SANDBOX.md `defineSandbox` reference impl.
 *
 * A composable schema block defining the `sandbox` field — provider, config, command env, network egress, resource limits — for any manifest that names a compute environment for agent-issued shell commands. Sibling primitive to STORAGE.md (AIP-35); inline or ref, mirroring AIP-17 RUNNER and AIP-19 SECRETS.
 *
 * Spec: https://agentproto.sh/docs/aip-36
 *
 * Authoring paths:
 *   - TS:  `defineSandbox({...})` → `SandboxHandle`
 *   - MD:  `parseSandboxManifest(src) → sandboxFromManifest({...})` → `SandboxHandle`
 */

export const SPEC_NAME = "agentsandbox/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineSandbox } from "./define-sandbox.js"
export type {
  SandboxDefinition,
  SandboxHandle,
  SandboxRuntimeInput,
  SandboxRuntimeHandle,
} from "./types.js"

/** The AIP-36 frontmatter zod schema, under the name consumers that accept
 *  an inline `SandboxSpec` (e.g. `@agentproto/runtime`'s `agent_start.sandbox`)
 *  validate against. Same schema `define-sandbox.ts`/`manifest/index.ts` use. */
export { sandboxFrontmatterSchema as SandboxSpecSchema } from "./schema.js"

export {
  createSandboxAgentSessionHost,
  type SandboxSpec,
  type BootedSandbox,
  type SandboxBootOpts,
  type SandboxProvider,
  type SandboxSecretsConfig,
  type CreateSandboxAgentSessionHostOpts,
  type SandboxAgentSessionHost,
} from "./agent-session-host.js"
