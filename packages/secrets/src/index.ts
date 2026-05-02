/**
 * @agentproto/secrets — AIP-19 SECRETS.md `defineSecrets` reference impl.
 *
 * A workspace-level manifest format for declaring secret slugs, their purpose, access grants, and audit metadata — without ever storing the values themselves. Hosts resolve slugs against a real vault at reveal time.
 *
 * Spec: https://agentproto.sh/docs/aip-19
 *
 * Authoring paths:
 *   - TS:  `defineSecrets({...})` → `SecretsHandle`
 *   - MD:  `parseSecretsManifest(src) → secretsFromManifest({...})` → `SecretsHandle`
 */

export const SPEC_NAME = "agentsecrets/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineSecrets } from "./define-secrets.js"
export type { SecretsDefinition, SecretsHandle } from "./types.js"
