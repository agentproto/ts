/**
 * Access policy — pure logic that decides whether a caller can see a
 * piece of corpus content based on its `metadata.corpus.access` spec.
 *
 * Inputs:
 *   spec    — what the entry/source declares (classification + allowed refs)
 *   caller  — identityTree (resolved by IdentityPort)
 *
 * Output:
 *   permitted: boolean
 *   reason: human-readable
 *   redact: bytes-redaction hint for getSource() (some classifications
 *           let the caller see metadata but not body bytes)
 *
 * Default policy by classification:
 *
 *   public      — anyone can see (and read bytes)
 *   internal    — same-guild only (default for unmarked entries)
 *   restricted  — explicit allowedRoles / allowedOperators / allowedUsers
 *                 ONLY; classification fallback is deny
 *   secret      — same as restricted PLUS bytes are redacted for
 *                 callers below the bar (they see frontmatter, not body)
 *
 * Engines/UIs filter silently — no "you have N results but can't see
 * them" leakage to the caller below.
 */

export type AccessClassification =
  | "public"
  | "internal"
  | "restricted"
  | "secret"

export interface CorpusAccessSpec {
  readonly classification?: AccessClassification
  readonly allowedRoles?: readonly string[]
  readonly allowedOperators?: readonly string[]
  readonly allowedUsers?: readonly string[]
  readonly allowedGuilds?: readonly string[]
  readonly allowedOrgs?: readonly string[]
  /** Free-form host extension. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AccessCaller {
  /** identityTree most-specific → least-specific. */
  readonly identityTree: readonly string[]
}

/**
 * Per-evaluation context the adapter passes alongside the caller.
 * Distinct from the spec (entry-side) and the caller (subject-side);
 * this carries the *workspace-side* facts that classification rules
 * need but that the entry doesn't repeat per-row.
 */
export interface AccessContext {
  /**
   * Guild slug that owns the workspace this entry lives in (e.g.
   * "acme-marketing"). When set, the `internal` classification
   * requires the caller's identityTree to include
   * `ws://guilds/<homeGuild>` — i.e. an entry tagged internal is
   * visible only to that guild, not to anyone-in-any-guild.
   *
   * When omitted, `internal` falls back to "fail-closed" rather than
   * the old "any-guild" semantics, on the principle that an
   * unidentifiable workspace shouldn't leak its content.
   */
  readonly homeGuild?: string
}

export interface AccessDecision {
  readonly permitted: boolean
  readonly reason: string
  /** For getSource — true means body bytes MUST be redacted. */
  readonly redactBytes: boolean
}

const DEFAULT_CLASSIFICATION: AccessClassification = "internal"

/**
 * Evaluate access for a caller against an access spec. Returns a
 * decision the caller (engine adapter, tool) uses to filter / redact.
 *
 * Missing `access` block in frontmatter = treat as `classification:
 * internal`, no explicit allow lists. Same-guild matches via the
 * identityTree.
 */
export function evaluateAccess(
  spec: CorpusAccessSpec | undefined,
  caller: AccessCaller,
  context: AccessContext = {}
): AccessDecision {
  const classification = spec?.classification ?? DEFAULT_CLASSIFICATION

  // Explicit allow lists win across all classifications.
  if (spec) {
    if (matchesAllowed("roles", spec.allowedRoles, caller))
      return permit(`allowedRoles match`, classification)
    if (matchesAllowed("operators", spec.allowedOperators, caller))
      return permit(`allowedOperators match`, classification)
    if (matchesAllowed("users", spec.allowedUsers, caller))
      return permit(`allowedUsers match`, classification)
    if (matchesAllowed("guilds", spec.allowedGuilds, caller))
      return permit(`allowedGuilds match`, classification)
    if (matchesAllowed("orgs", spec.allowedOrgs, caller))
      return permit(`allowedOrgs match`, classification)
  }

  switch (classification) {
    case "public":
      return {
        permitted: true,
        reason: "classification=public",
        redactBytes: false,
      }
    case "internal": {
      // Internal = scoped to the workspace's home guild. The host
      // (corpus-host) is expected to supply `context.homeGuild`; when
      // it does, the caller must hold that guild in their identity
      // tree. When omitted, fail-closed — an unidentifiable workspace
      // shouldn't leak via the broadest classification.
      if (!context.homeGuild) {
        return {
          permitted: false,
          reason:
            "classification=internal but no homeGuild context — fail-closed",
          redactBytes: false,
        }
      }
      const expected = `ws://guilds/${context.homeGuild}`
      const inHomeGuild = caller.identityTree.includes(expected)
      return {
        permitted: inHomeGuild,
        reason: inHomeGuild
          ? `classification=internal + caller in ${expected}`
          : `classification=internal but caller not in ${expected}`,
        redactBytes: false,
      }
    }
    case "restricted":
      return {
        permitted: false,
        reason:
          "classification=restricted — caller not in any allowed list (roles/operators/users/guilds/orgs)",
        redactBytes: false,
      }
    case "secret":
      return {
        permitted: false,
        reason:
          "classification=secret — caller not in any allowed list; bytes redacted",
        redactBytes: true,
      }
    default: {
      // Forward-compat — unknown classification fails closed.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = classification
      return {
        permitted: false,
        reason: `unknown classification "${String(classification)}" — fail-closed`,
        redactBytes: true,
      }
    }
  }
}

function permit(
  reason: string,
  classification: AccessClassification
): AccessDecision {
  // Even when explicitly allowed, secret content still has redactBytes
  // depend on classification — callers might want to expose
  // frontmatter only. For now, explicit allow = full access.
  return {
    permitted: true,
    reason: `${reason} (classification=${classification})`,
    redactBytes: false,
  }
}

function matchesAllowed(
  kind: "roles" | "operators" | "users" | "guilds" | "orgs",
  list: readonly string[] | undefined,
  caller: AccessCaller
): boolean {
  if (!list || list.length === 0) return false
  const prefix = `ws://${kind}/`
  for (const ref of list) {
    // Tolerate both bare slugs and full ws:// refs in the allow list.
    const expanded = ref.startsWith("ws://") ? ref : prefix + ref
    if (caller.identityTree.includes(expanded)) return true
    // Glob: "ws://roles/*" matches any role in the caller's tree.
    if (expanded === `${prefix}*`) {
      if (caller.identityTree.some((r) => r.startsWith(prefix))) return true
    }
  }
  return false
}

/**
 * Extract the access spec from a frontmatter object's
 * `metadata.corpus.access`. Returns undefined when the entry has
 * none — caller treats it as `internal` (the default).
 */
export function readAccessSpec(
  frontmatter: Readonly<Record<string, unknown>>
): CorpusAccessSpec | undefined {
  const meta = frontmatter.metadata as { corpus?: { access?: unknown } } | undefined
  const access = meta?.corpus?.access
  if (!access || typeof access !== "object") return undefined
  return access as CorpusAccessSpec
}
