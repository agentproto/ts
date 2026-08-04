/**
 * Rift Card typed data contract.
 *
 * A Rift Card turns a free-text market / competitor / idea input into a
 * traceable research artefact. This module defines the domain types only;
 * no network, model, or persistence logic lives here.
 *
 * Evidence semantics (enforced by later work):
 *   - Verified     → requires link + date + bounded excerpt
 *   - Public claim → attributed to a named source
 *   - Inference    → requires ≥ 2 distinct source IDs + uncertainty
 */

// ─── Evidence labels ────────────────────────────────────────────────

/**
 * Evidence classification for a Claim.
 *
 * Stable string-enum values. The Evidence PR will enforce the semantic
 * rules documented here; this module is type-level contract only.
 */
export type EvidenceLabel = "Verified" | "Public claim" | "Inference"

// ─── Source-quality metadata (slot for later PR) ────────────────────

/**
 * Metadata the source-quality gate will populate. The Foundation
 * defines the shape; later work fills it. All fields are optional
 * until that gate exists.
 */
export interface SourceQuality {
  /** Numeric quality score (0–1 range or similar). */
  score?: number
  /** Human-readable quality tier (e.g. "primary", "secondary"). */
  tier?: string
  /** ISO-8601 timestamp of the quality assessment. */
  assessedAt?: string
}

// ─── Source ─────────────────────────────────────────────────────────

/**
 * A bibliographic source cited by one or more Claims.
 *
 * Provenance fields (url, title, publishedAt/observedAt, excerpt) are
 * optional here; the Evidence PR will enforce which are required per
 * evidence label.
 */
export interface Source {
  /** Stable identifier (slug or UUID). */
  id: string
  /** Source-kind discriminator (e.g. "article", "survey", "filing"). */
  type: string
  /** Canonical URL when available. */
  url?: string
  /** Human-readable title of the source document. */
  title?: string
  /** ISO-8601 date the source was published. Mutually exclusive with observedAt. */
  publishedAt?: string
  /** ISO-8601 date the source was observed (for ephemeral or undated sources). */
  observedAt?: string
  /** Bounded text excerpt (required for Verified evidence). */
  excerpt?: string
  /** IDs of Claims that cite this source (back-reference for later use). */
  claimIds: string[]
  /** Source-quality metadata — populated by the later source-quality gate. */
  quality?: SourceQuality
}

// ─── Claim ──────────────────────────────────────────────────────────

/**
 * A single factual assertion derived from research.
 */
export interface Claim {
  /** Stable identifier (slug or UUID). */
  id: string
  /** One-sentence factual assertion. */
  text: string
  /** Evidence classification. */
  evidenceLabel: EvidenceLabel
  /** Source IDs backing this claim (≥ 1 for Verified/Public claim, ≥ 2 for Inference). */
  sourceIds: string[]
  /** Uncertainty note — required when evidenceLabel is "Inference". */
  uncertainty?: string
}

// ─── Input ──────────────────────────────────────────────────────────

export type MarketSignalStrength = "strong" | "moderate" | "weak" | "unclear"

export interface RiftInput {
  /** Free-text description of the market, competitor, or idea. */
  rawText: string
  /** Optional human-readable title for the input. */
  title?: string
  /** Optional user-supplied tags. */
  tags?: string[]
}

// ─── Recommendation ─────────────────────────────────────────────────

export type Recommendation = "build" | "wait" | "reject"

export interface RecommendationRationale {
  recommendation: Recommendation
  /** Ordered reasons supporting the recommendation. */
  reasons: string[]
}

// ─── Generated drafts (placeholder slots) ───────────────────────────

export interface PrdDraft {
  placeholder: true
  content?: string
}

export interface LandingPageDraft {
  placeholder: true
  content?: string
}

export interface XPostDraft {
  placeholder: true
  content?: string
}

export interface GeneratedDrafts {
  prd: PrdDraft
  landingPage: LandingPageDraft
  xPost: XPostDraft
}

// ─── Rift Card ──────────────────────────────────────────────────────

export interface RiftCard {
  /** Auto-generated stable ID (deterministic in mock data). */
  id: string
  /** The original input that produced this card. */
  input: RiftInput
  /** Claims derived from research. */
  claims: Claim[]
  /** All sources cited by this card's claims. */
  sources: Source[]
  /** Market signal strength as assessed by later research. */
  marketSignal?: MarketSignalStrength
  /** Recommendation and rationale — filled by later analysis. */
  recommendation?: RecommendationRationale
  /** Generated content drafts — placeholder slots for later work. */
  drafts?: GeneratedDrafts
  /** ISO-8601 timestamp of card creation. */
  createdAt: string
  /** ISO-8601 timestamp of last update. */
  updatedAt: string
}

// ─── App-shell state ────────────────────────────────────────────────

export type CardStatus = "loading" | "ready" | "error"

export interface RiftAppState {
  /** Cards currently held by the shell. */
  cards: RiftCard[]
  /** Status of the currently-displayed card index. */
  activeCardStatus: CardStatus
  /** Index into cards[] for the active card (-1 when empty). */
  activeCardIndex: number
}
