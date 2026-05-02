/**
 * AIP-24 AssemblyDefinition + AssemblyHandle.
 *
 * `AssemblyDefinition` was generated from
 * `resources/aip-24/draft/ASSEMBLY.schema.json` via json-schema-to-typescript.
 * `AssemblyHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-24 ASSEMBLY.md (workspace root or per-context view). The single doctype 'assembly.workspace/v1' is used in both modes; the host distinguishes by checking whether `extends` is set. The discriminating field is `mode` — advisory | voting | peer | hierarchy — each selecting a different synthesis substrate. The `members[]` array references AIP-25 personas; AIP-24 does NOT define a member-as-doctype.
 */
export type AssemblyDefinition = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the AIP-24 workspace doctype.
   */
  schema: "assembly.workspace/v1"
  /**
   * Stable kebab-case identifier for the assembly or view.
   */
  name: string
  /**
   * Human-readable assembly title.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this assembly is, who it serves, why this mode is the right pattern.
   */
  description: string
  /**
   * Semantic version of the WORKSPACE shape. Bump on member roster / synthesis rule / locked-trait / audit policy changes. Independent of the assembly's content version.
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent ASSEMBLY.md. Presence makes the manifest a VIEW; absence makes it a WORKSPACE ROOT. Recursive composition; maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this VIEW adapts the assembly for. Hosts MUST refuse the view if any binding does not resolve. Not inherited; views declare their own scope.
   */
  appliesTo?: string[]
  /**
   * The collaboration pattern. ONE-WAY SWITCH: once set at any ancestor, descendants MUST NOT change to a different mode. Refusal: assembly_mode_change (HARD). 'advisory' = silent overlay producing persona fragments (the implemented anchor — Simone's Council); 'voting' = quorum decision body; 'peer' = network of equals exchanging messages; 'hierarchy' = reporting tree with bottom-up aggregation.
   */
  mode: "advisory" | "voting" | "peer" | "hierarchy"
  /**
   * Member roster. Each member is a ref to an AIP-25 persona with assembly-specific role config. Merge-by-id (the role id, not the persona ref) across the extends chain.
   */
  members?: Member[]
  /**
   * How member outputs combine into a single guidance / decision / message log / hierarchy output.
   */
  synthesis?: {
    /**
     * Synthesis rules in declaration order. A rule MAY declare itself terminal to short-circuit further rule processing. Merge-by-id with parent.
     */
    rules?: SynthesisRule[]
    /**
     * Severity-to-risk-level mapping. Severity ranges MUST be monotonic non-overlapping integer intervals. Whole-array override across the extends chain (child's mapping replaces parent's).
     */
    riskLevels?: RiskLevel[]
  }
  /**
   * Anti-poisoning floor. Substrings (or regexes / semantic patterns per matchMode) that an output's text MUST NOT contain. UNION across the extends chain — additive only, child cannot remove parent's entries. Refusal: assembly_locked_trait_removed (HARD).
   */
  lockedTraits?: string[]
  /**
   * Algorithm used to check outputs against lockedTraits. 'substring' (default, matches Simone v1) — case-insensitive substring match. 'regex' — RFC-3987-ish regex. 'semantic' — embedding match against the trait's semantic neighborhood; hosts that don't support semantic MUST fall back to substring with assembly_locked_trait_match_mode_unsupported warning.
   */
  matchMode?: "substring" | "regex" | "semantic"
  /**
   * Audit policy. Composes with AIP-7 governance for signing. The runtime tables (consultations, overlays, decisions, message logs) are host-side data shaped by this policy; AIP-24 does not prescribe table names.
   */
  audit?: {
    /**
     * Consultation persistence policy.
     */
    consultations?: {
      /**
       * Whether each member invocation is persisted as a consultation row. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false. Refusal: assembly_audit_disable (HARD).
       */
      enabled?: boolean
      /**
       * Retention policy for consultation rows. 'forever' — never evicted. 'days:<n>' — evict rows older than n days.
       */
      retention?: string
    }
    /**
     * Overlay artifact persistence policy.
     */
    overlays?: {
      /**
       * Whether overlay fragments (advisory) / decision records (voting) / message log entries (peer) / rolled-up outputs (hierarchy) are persisted. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false. Refusal: assembly_audit_disable (HARD).
       */
      enabled?: boolean
      /**
       * Cap on concurrent active artifacts (typically advisory overlay fragments). Older artifacts are evicted on write to keep the count under the cap.
       */
      maxActive?: number
      /**
       * ISO 8601 duration applied as default TTL to advisory overlay fragments that don't specify their own. Examples: P14D (14 days), P3D (3 days), PT1H (1 hour).
       */
      defaultTtl?: string
    }
    /**
     * Signing posture, composing with AIP-7 governance. 'required' — every artifact MUST carry a signature; 'optional' — signatures permitted; 'none' — no signing. ONE-WAY SWITCH on downgrade: once 'required' at any ancestor, descendants MUST NOT downgrade. Refusal: assembly_signing_downgrade (HARD).
     */
    signing?: "required" | "optional" | "none"
  }
  /**
   * OPTIONAL — AIP-23 base identity ref. The identity the assembly modulates (advisory) or attributes to (voting / peer / hierarchy).
   */
  identity?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Approval gates, signing keys, and audit retention compose with audit.signing and the workspace's one-way switches.
   */
  governance?: string
  /**
   * OPTIONAL — AIP-20 work workspace the assembly's artifacts attach to. Advisory overlays describe the agent's behavior on items in this workspace; voting decisions approve work items; hierarchy outputs roll up severity from work-item reviews.
   */
  work?: string
  /**
   * OPTIONAL — AIP-9 default executor operator. The runtime that calls defineAssemblyWorkspace, runs the member-execution pipeline, and persists the artifacts.
   */
  executor?: string
  /**
   * Trigger defaults. Per-member overrides live on the members[] entries.
   */
  defaults?: {
    /**
     * OPTIONAL — default trigger heuristic for invoking the assembly. 'every-n-messages' — sample every N user messages; 'on-mode-change' — invoke when the conversation's mode changes; 'manual' — invoke only on explicit request; 'periodic' — invoke on triggerInterval_ms cadence; 'custom:<id>' — host-defined.
     */
    triggerHeuristic?: string
    /**
     * OPTIONAL — interval in milliseconds for periodic mode. Required when triggerHeuristic = 'periodic'.
     */
    triggerInterval_ms?: number
  }
  /**
   * Display hints for UIs that render the assembly. Runtime-agnostic.
   */
  display?: {
    /**
     * OPTIONAL — default grouping for assembly views. 'phase' (advisory), 'role' (any mode), 'severity' (advisory / hierarchy).
     */
    defaultGrouping?: "phase" | "role" | "severity"
  }
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain. MUST NOT change the meaning of any spec field. The four one-way switches are spec-level invariants; vendor namespaces cannot bypass them.
   */
  metadata?: {
    [k: string]: unknown
  }
}

/**
 * One member of the assembly. Carries the persona ref (the unit of identity) and the assembly-specific role config (phase / weight / voteClass / parent — depending on mode).
 */
export interface Member {
  /**
   * Stable kebab-case role id within the assembly. Merge key. MUST be unique within a single manifest layer; collisions within one layer refuse with assembly_member_id_collision (HARD). Across layers, child replaces parent's by id.
   */
  id: string
  /**
   * AIP-25 persona ref. Required. Hosts MUST resolve the persona at load time; unresolvable refs refuse with assembly_member_persona_unresolvable (HARD).
   */
  persona: string
  /**
   * Human-readable role label (e.g. Therapist, Sentinel, CFO, Brand Critic, Department Head).
   */
  role: string
  /**
   * OPTIONAL — for advisory mode. Built-in: 'session' (per-message review), 'standing' (periodic deep dive), 'sentinel' (safety pre-filter). Custom phase ids are permitted; the host filters members to the active phase before invocation.
   */
  phase?: string
  /**
   * OPTIONAL — which trigger kinds invoke this member. When omitted, the member is invoked on every assembly trigger.
   */
  triggers?: ("sample" | "sentinel-match" | "scheduled" | "manual" | "periodic")[]
  /**
   * OPTIONAL — for voting mode. Multiplier on the cast vote. Default 1.0. Higher for senior reviewers, lower for junior. Quorum thresholds compute against the sum of weights in the voteClass.
   */
  weight?: number
  /**
   * OPTIONAL — for voting mode. Which proposal classes this member is empowered to vote on. Examples: ['budget', 'security', 'architecture']. When omitted, the member votes on every class.
   */
  voteClass?: string[]
  /**
   * OPTIONAL — for hierarchy mode. Reporting parent's role id. Outputs cascade bottom-up; the parent receives this member's output as input. The host MUST detect cycles (assembly_hierarchy_cycle, HARD) and refuse parents that don't resolve to a member id (assembly_hierarchy_invalid_parent, HARD).
   */
  parent?: string
  /**
   * OPTIONAL — per-member execution cap in milliseconds. The host MUST cancel the member's invocation when the timeout elapses; cancelled invocations produce no output (treated as missing in synthesis).
   */
  timeout_ms?: number
  /**
   * OPTIONAL — input-gathering configuration. When omitted, the host uses 'working-memory' with no params.
   */
  gatherInput?: {
    /**
     * Built-in: 'working-memory' (the agent's working memory for the current user/thread), 'recent-messages' (last N raw messages), 'digest' (a multi-day summary), 'last-message-only' (just the last user message). 'custom:<id>' delegates to a host-registered gather strategy.
     */
    strategy: string
    /**
     * Strategy-specific parameters. Examples: { limit: 20 } for recent-messages; { window_days: 7 } for digest.
     */
    params?: {
      [k: string]: unknown
    }
  }
}
/**
 * One synthesis rule. Rules apply in declaration order; a rule MAY declare itself terminal (via params or kind) to short-circuit further rule processing.
 */
export interface SynthesisRule {
  /**
   * Stable kebab-case rule id. Merge key. Same id across the extends chain → child replaces parent's; new ids appended.
   */
  id: string
  /**
   * Built-in: 'terminal' | 'priority' | 'aggregate' | 'quorum' | 'majority' | 'unanimity' | 'escalate-on-severity'. Custom kinds are free-form strings resolved through the host's rule registry; unregistered kinds refuse with assembly_synthesis_rule_invalid (HARD).
   */
  kind: string
  /**
   * OPTIONAL — '*' (all members) or an array of member ids the rule applies to. Members listed MUST exist in the merged members[] array; unresolvable ids refuse with assembly_synthesis_unknown_member (HARD).
   */
  appliesTo?: "*" | [string, ...string[]]
  /**
   * Kind-specific parameters. Examples: { triggerSeverity: 9 } for terminal; { triggerKind: sycophancy } for priority; { threshold: 0.66 } for quorum; { topN: 2 } for aggregate; { tieBreaker: chair-vote } for majority.
   */
  params?: {
    [k: string]: unknown
  }
}
/**
 * One severity-to-risk-level mapping entry.
 */
export interface RiskLevel {
  /**
   * Closed integer interval [min, max]. Severity values within the interval map to this level. Intervals across the riskLevels[] array MUST be monotonic non-overlapping.
   *
   * @minItems 2
   * @maxItems 2
   */
  range: [number, number]
  /**
   * Risk-level label. The four built-in labels match the working Council implementation.
   */
  label: "ok" | "watch" | "intervene" | "escalate"
}

export type AssemblyHandle = Readonly<AssemblyDefinition>
