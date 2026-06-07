/**
 * GraphSinkPort — the boundary into a social graph. The kit produces a
 * stream of GraphOps (pure, in land/footprint-to-graph); the host applies
 * them to the real graph.
 *
 * The op payloads are structurally identical to @agstudio/graph-social's
 * PersonInput / PostInput / EngagementInput, so the host adapter is a
 * one-line switch — `ingestPerson(store, op.person)` etc. — with no
 * field translation. The kit stays vendor-neutral (no @agstudio import);
 * the graph package stays the single source of merge semantics.
 */

export interface GraphPerson {
  readonly platform: string
  readonly handle: string
  readonly name: string
  readonly headline?: string | null
  readonly location?: string | null
  readonly bio?: string | null
  readonly profileUrl?: string | null
  readonly followerCount?: number | null
  readonly verified?: boolean | null
}

export interface GraphPost {
  readonly platform: string
  readonly urn: string
  readonly text?: string | null
  readonly url?: string | null
  readonly numLikes?: number | null
  readonly numComments?: number | null
  readonly authorHandle?: string | null
}

export interface GraphEngagement {
  readonly platform: string
  readonly post: GraphPost
  readonly reactors?: ReadonlyArray<GraphPerson & { reactionType?: string | null }>
  readonly comments?: ReadonlyArray<GraphPerson & { text?: string | null }>
}

export type GraphOp =
  | { readonly op: "person"; readonly person: GraphPerson }
  | { readonly op: "post"; readonly post: GraphPost }
  | { readonly op: "engagement"; readonly engagement: GraphEngagement }
  | {
      readonly op: "edge"
      readonly platform: string
      readonly edge: "FOLLOWS" | "CONNECTED"
      readonly from: GraphPerson
      readonly to: GraphPerson
    }

export interface GraphSinkPort {
  /** Apply one graph op. MUST be idempotent (merge-by-key). */
  apply(op: GraphOp): Promise<void>
}
