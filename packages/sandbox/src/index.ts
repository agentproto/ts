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
export type { SandboxDefinition, SandboxHandle } from "./types.js"
