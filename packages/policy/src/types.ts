/**
 * AIP-38 PolicyDefinition + PolicyHandle.
 *
 * `PolicyDefinition` was generated from
 * `resources/aip-38/draft/POLICY.schema.json` via json-schema-to-typescript.
 * `PolicyHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-38 POLICY.md manifest, OR the inline form embedded in any other manifest's `policy:` block. Grants on AIP-39 ACTION ids; principals via AIP-23 identity-ref schemes.
 */
export interface PolicyDefinition {
  schema: "policy/v1"
  /**
   * Standalone-only. Globally addressable id `@<owner-slug>/<policy-slug>`.
   */
  id?: string
  /**
   * Standalone-only. Spec version of THIS file.
   */
  version?: string
  /**
   * Default decision when no grant matches. `deny` strongly recommended; `allow` is audit-significant.
   */
  default?: "allow" | "deny"
  /**
   * Access grants. Each grant ties a principal (AIP-23) to a set of actions (AIP-39).
   */
  grants?: Grant[]
  /**
   * Per-block behavioural defaults. Keys are AIP block names (storage, sandbox, code, secrets); values are partial block configs.
   */
  defaults?: {
    [k: string]: {
      [k: string]: unknown
    }
  }
  /**
   * Resource limits. Each `{ kind, value, scope?, per?, applies_to? }`.
   */
  limits?: Limit[]
  /**
   * Cross-cutting must-haves (MFA, signing, approvals). ANDed across composed policies.
   */
  requirements?: Requirement[]
  /**
   * Free-form, namespaced.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export interface Grant {
  /**
   * AIP-23 identity-ref. Schemes: operator://, user://, org://, guild://, bot://, group://, role://, *.
   */
  principal:
    | {
        name: string
        email: string
        avatar?: string
        gpg_key?: string
        role?: string
        metadata?: {}
        [k: string]: unknown
      }
    | {
        ref: string
        role?: string
        [k: string]: unknown
      }
    | {
        file: string
        role?: string
        [k: string]: unknown
      }
    | string
  /**
   * @minItems 1
   */
  actions: [ActionGrant, ...ActionGrant[]]
  /**
   * Conditions ANDed (all must hold). Unknown conditions skip the grant.
   */
  conditions?: Condition[]
  /**
   * Time-bound grant; expires at granted_at + ttl_seconds.
   */
  ttl_seconds?: number
  /**
   * ISO 8601. Audit metadata.
   */
  granted_at?: string
  /**
   * Who issued this grant. Audit metadata.
   */
  granted_by?:
    | {
        name: string
        email: string
        avatar?: string
        gpg_key?: string
        role?: string
        metadata?: {}
        [k: string]: unknown
      }
    | {
        ref: string
        role?: string
        [k: string]: unknown
      }
    | {
        file: string
        role?: string
        [k: string]: unknown
      }
    | string
  /**
   * Soft-revoke marker. A revoked grant evaluates as no-grant.
   */
  revoked?: boolean
}
export interface ActionGrant {
  /**
   * AIP-39 ACTION reference. Bare id (e.g. `storage:commit`), workspace-relative path, or registry slug (`@agentik/actions/standard/storage-commit`). `*` suffix permits wildcards (`storage:*`).
   */
  action: string
  /**
   * Optional scope narrowing for this grant (action-specific).
   */
  scope?: string
}
export interface Condition {
  /**
   * Condition kind. Standard: `during-business-hours`, `ip-range`, `mfa-recent`, `approval-from`, `signed-by`. Hosts MAY register custom kinds.
   */
  kind: string
  [k: string]: unknown
}
export interface Limit {
  /**
   * Limit kind. Standard: `max-concurrent-sandboxes`, `rate-tool-calls`, `max-egress-bytes-per-day`. Host-extensible.
   */
  kind: string
  value: number
  /**
   * Per what? `user`, `workspace`, `org`, host-specific.
   */
  scope?: string
  /**
   * For rate-style limits.
   */
  per?: "second" | "minute" | "hour" | "day"
  /**
   * Action refs the limit applies to. Empty / missing = all actions.
   */
  applies_to?: string[]
  [k: string]: unknown
}
export interface Requirement {
  /**
   * Requirement kind. Standard: `mfa-recent`, `signed-by`, `approval-from`. Host-extensible.
   */
  kind: string
  /**
   * Action refs this requirement applies to. Empty / missing = all actions.
   */
  applies_to?: string[]
  [k: string]: unknown
}

export type PolicyHandle = Readonly<PolicyDefinition>
