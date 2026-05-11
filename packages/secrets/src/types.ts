/**
 * AIP-19 SecretsDefinition + SecretsHandle.
 *
 * `SecretsDefinition` was generated from
 * `resources/aip-19/draft/SECRETS.schema.json` via json-schema-to-typescript.
 * `SecretsHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 *
 * The `exposures` field on each entry was added by hand (not regen'd
 * yet) — runtime exposure descriptors live in `./exposure/types.ts` so
 * they can be consumed independently by hosts that don't need the
 * full SECRETS.md doctype machinery (Guilde's connector registry,
 * @agentproto/egress's proxy core).
 */

import type { SecretExposure } from "./exposure/types.js"

export type SecretEntry = {
  [k: string]: unknown
} & {
  /**
   * Machine identifier. Lowercase, digits, dashes; optional <namespace>/ prefix. 2–80 chars total. Unique within the workspace inventory.
   */
  slug: string
  name: string
  description: string
  /**
   * Value shape. 'opaque' = single string. 'oauth' = { accessToken, refreshToken, expiresAt }. 'keypair' = { public, private }. 'json' = arbitrary structured.
   */
  kind?: "opaque" | "oauth" | "keypair" | "json"
  /**
   * Vault URI (optional). Default: host-resolved by slug. Setting it explicitly exposes infra topology and SHOULD be reviewer-audited.
   */
  backend?: string
  access?: AccessGrants
  audit?: AuditConfig
  tags?: string[]
  metadata?: {
    [k: string]: unknown
  }
  /**
   * How this secret is exposed to the runtime that consumes it (env,
   * file, egress placeholder, future MCP-header / HTTP-bearer / etc.).
   * Optional — hosts MAY honor or remap based on their own catalog.
   * Discriminated by `kind`; consumers ignore unknown kinds.
   *
   * See `@agentproto/secrets/exposure` for the variant types.
   */
  exposures?: SecretExposure[]
} & {
  /**
   * Machine identifier. Lowercase, digits, dashes; optional <namespace>/ prefix. 2–80 chars total. Unique within the workspace inventory.
   */
  slug: string
  name: string
  description: string
  /**
   * Value shape. 'opaque' = single string. 'oauth' = { accessToken, refreshToken, expiresAt }. 'keypair' = { public, private }. 'json' = arbitrary structured.
   */
  kind?: "opaque" | "oauth" | "keypair" | "json"
  /**
   * Vault URI (optional). Default: host-resolved by slug. Setting it explicitly exposes infra topology and SHOULD be reviewer-audited.
   */
  backend?: string
  access?: AccessGrants
  audit?: AuditConfig
  tags?: string[]
  metadata?: {
    [k: string]: unknown
  }
  /**
   * How this secret is exposed to the runtime that consumes it (env,
   * file, egress placeholder, future MCP-header / HTTP-bearer / etc.).
   * Optional — hosts MAY honor or remap based on their own catalog.
   * Discriminated by `kind`; consumers ignore unknown kinds.
   *
   * See `@agentproto/secrets/exposure` for the variant types.
   */
  exposures?: SecretExposure[]
}
/**
 * A single access-grant entry. Exactly ONE of role/userId/cap/tool/workflow.
 */
export type AccessEntry = {
  role?: string
  userId?: string
  cap?: string
  tool?: string
  workflow?: string
} & AccessEntry1 & {
    role?: string
    userId?: string
    cap?: string
    tool?: string
    workflow?: string
  } & AccessEntry1 & {
    role?: string
    userId?: string
    cap?: string
    tool?: string
    workflow?: string
  } & AccessEntry1
export type AccessEntry1 =
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }
  | {
      [k: string]: unknown
    }

/**
 * Validates the YAML frontmatter portion of an AIP-19 SECRETS.md manifest. The manifest declares secret slugs + access policy + audit metadata. Values are NEVER stored in the manifest.
 */
export interface SecretsDefinition {
  /**
   * @minItems 1
   */
  secrets: [SecretEntry, ...SecretEntry[]]
}
export interface AccessGrants {
  reveal?: AccessEntry[]
  bind?: AccessEntry[]
  /**
   * Reserved for a future rotation AIP. Hosts MAY ignore.
   */
  rotate?: AccessEntry[]
}
export interface AuditConfig {
  /**
   * ISO 8601 duration ('P7Y') or shorthand ('7y', '90d').
   */
  retention?: string
  pii?: boolean
  classification?: string[]
}

export type SecretsHandle = Readonly<SecretsDefinition>
