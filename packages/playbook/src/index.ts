/**
 * @agentproto/playbook — AIP-12 PLAYBOOK.md `definePlaybook` reference impl.
 *
 * A markdown format for prompt-overlay fragments that ride on top of an operator's persona, plus a contract for how runtimes evolve them via reflective deltas without violating locked persona traits.
 *
 * Spec: https://agentproto.sh/docs/aip-12
 *
 * Authoring paths:
 *   - TS:  `definePlaybook({...})` → `PlaybookHandle`
 *   - MD:  `parsePlaybookManifest(src) → playbookFromManifest({...})` → `PlaybookHandle`
 */

export const SPEC_NAME = "agentplaybook/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { definePlaybook } from "./define-playbook.js"
export type { PlaybookDefinition, PlaybookHandle } from "./types.js"
