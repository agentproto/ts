/**
 * IdentityPort — resolves who is currently acting on the corpus.
 *
 * Used by the event emitter (attestations) and the access/scope policy
 * layers (which use the identityTree to match `appliesTo`). Production
 * Guilde resolves from session; the local CLI resolves from OS user.
 */

export interface CallerIdentity {
  /** Stable identity slug. Examples: "operators/sarah", "users/jeremy". */
  readonly principal: string
  /**
   * Identity tree, most-specific → least-specific. Used by the corpus
   * scope-policy middleware to match against `appliesTo`. Examples:
   *
   *   [
   *     "ws://operators/sarah",
   *     "ws://roles/senior-rep",
   *     "ws://workspaces/sales-na",
   *     "ws://guilds/acme-sales",
   *     "ws://orgs/acme-corp",
   *   ]
   *
   * Role hierarchy is resolved here (IdentityPort), not in scope matching.
   */
  readonly identityTree: readonly string[]
  /** Optional display name for `_log.md` attestations. */
  readonly displayName?: string
}

export interface IdentityPort {
  /** Resolve the current caller. Throws if no identity is in context. */
  resolve(): Promise<CallerIdentity>
}
