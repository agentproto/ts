/**
 * @agentproto/runner — AIP-17 RUNNER.md `defineRunner` reference impl.
 *
 * A composable schema block defining the `runner` field — engine (in-process / subprocess / sandbox), optional container image, declarative dependency needs, and resource limits — reused by every manifest format that runs code. Permissions (secrets, network) and IO are defined elsewhere; this block scopes only to the process boundary.
 *
 * Spec: https://agentproto.sh/docs/aip-17
 *
 * Authoring paths:
 *   - TS:  `defineRunner({...})` → `RunnerHandle`
 *   - MD:  `parseRunnerManifest(src) → runnerFromManifest({...})` → `RunnerHandle`
 */

export const SPEC_NAME = "agentrunner/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineRunner } from "./define-runner.js"
export type { RunnerDefinition, RunnerHandle } from "./types.js"
