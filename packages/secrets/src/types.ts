/**
 * AIP-19 SecretsDefinition + SecretsHandle.
 *
 * `SecretsDefinition` was generated from
 * `resources/aip-19/draft/SECRETS.schema.json` via json-schema-to-typescript.
 * `SecretsHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

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
