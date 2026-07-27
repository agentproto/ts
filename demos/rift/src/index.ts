/**
 * @agentproto/rift-demo — barrel export.
 *
 * Public API surface for the Rift demo foundation. Later PRs will
 * extend this with research pipeline, evidence gates, and UI.
 */

export type {
  RiftInput,
  RiftCard,
  Claim,
  Source,
  EvidenceLabel,
  SourceQuality,
  MarketSignalStrength,
  Recommendation,
  RecommendationRationale,
  PrdDraft,
  LandingPageDraft,
  XPostDraft,
  GeneratedDrafts,
  RiftAppState,
  CardStatus,
} from "./types.js"

export {
  createRiftApp,
  createInitialState,
  validateInput,
  validateCard,
  type RiftApp,
} from "./app.js"

export {
  SOURCES,
  MOCK_INPUT,
  MOCK_CLAIMS,
  MOCK_DRAFTS,
  MOCK_CARD,
  MOCK_CARDS,
} from "./mock-data.js"

export {
  getSourcesForClaim,
  getClaimsForSource,
  resolveEvidence,
  type ClaimWithEvidence,
} from "./evidence.js"

export {
  checkSourceQuality,
  type SourceQualityIssue,
  type SourceQualityIssueCode,
} from "./source-quality.js"
