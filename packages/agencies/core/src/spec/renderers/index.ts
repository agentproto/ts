/**
 * agentagencies/v1 renderers — thin wrappers over canvakit templates.
 *
 * Each renderer exposes:
 *   - A canonical template id (e.g., `agency.engagement-dashboard`)
 *   - The bundled template file path (relative to the package root)
 *   - A typed variables schema + builder
 *
 * Apps wire the template id to their canvakit renderer of choice
 * (e.g., @canvakit/core's mustache engine). This package does NOT depend on
 * canvakit at runtime — only on the spec for template ids + variable shapes.
 *
 * Seven templates ship out of the box:
 *   - agency.engagement-dashboard — operator-facing live dashboard (Phase 1)
 *   - agency.invoice-pdf          — printable invoice (Phase 1)
 *   - agency.agency-overview      — agency-wide rollup, snapshot-driven (Phase 1)
 *   - agency.agreement-signing    — multi-party signing portal for AGREEMENT.md
 *   - agency.deliverable-review   — counterparty validation page
 *   - agency.procedure-card       — narrative card view of a PROCEDURE.md
 *   - agency.agency-profile       — public profile rendering of AGENCY.md
 */

// ─── Live dashboards & rollups ─────────────────────────────────────────

export {
  ENGAGEMENT_DASHBOARD_TEMPLATE_ID,
  ENGAGEMENT_DASHBOARD_TEMPLATE_PATH,
  engagementDashboardVariablesSchema,
  engagementDashboardVariables,
  type EngagementDashboardVariables,
} from "./engagement-dashboard.js"

export {
  AGENCY_OVERVIEW_TEMPLATE_ID,
  AGENCY_OVERVIEW_TEMPLATE_PATH,
  agencyOverviewVariablesSchema,
  agencyOverviewVariables,
  agencyOverviewSnapshotSchema,
  isAgencyOverviewSnapshotStale,
  AGENCY_OVERVIEW_FRESHNESS_MS,
  type AgencyOverviewVariables,
  type AgencyOverviewSnapshot,
} from "./agency-overview.js"

// ─── Frozen archives ───────────────────────────────────────────────────

export {
  INVOICE_PDF_TEMPLATE_ID,
  INVOICE_PDF_TEMPLATE_PATH,
  invoicePdfVariablesSchema,
  invoicePdfVariables,
  type InvoicePdfVariables,
} from "./invoice-pdf.js"

// ─── Signing & review portals ──────────────────────────────────────────

export {
  AGREEMENT_SIGNING_TEMPLATE_ID,
  AGREEMENT_SIGNING_TEMPLATE_PATH,
  agreementSigningVariablesSchema,
  agreementSigningVariables,
  type AgreementSigningVariables,
} from "./agreement-signing.js"

export {
  DELIVERABLE_REVIEW_TEMPLATE_ID,
  DELIVERABLE_REVIEW_TEMPLATE_PATH,
  deliverableReviewVariablesSchema,
  deliverableReviewVariables,
  type DeliverableReviewVariables,
} from "./deliverable-review.js"

// ─── Documentation surfaces ────────────────────────────────────────────

export {
  PROCEDURE_CARD_TEMPLATE_ID,
  PROCEDURE_CARD_TEMPLATE_PATH,
  procedureCardVariablesSchema,
  procedureCardVariables,
  type ProcedureCardVariables,
} from "./procedure-card.js"

export {
  AGENCY_PROFILE_TEMPLATE_ID,
  AGENCY_PROFILE_TEMPLATE_PATH,
  agencyProfileVariablesSchema,
  agencyProfileVariables,
  type AgencyProfileVariables,
} from "./agency-profile.js"

// Backward-compat alias — the original plan called the agreement template
// `agency.agreement-signing` (renamed from `agency.agreement-pdf`). Keep
// the old constant exported for now so external code that imported it
// before the rename keeps working.
/** @deprecated use AGREEMENT_SIGNING_TEMPLATE_ID */
export { AGREEMENT_SIGNING_TEMPLATE_ID as AGREEMENT_PDF_TEMPLATE_ID } from "./agreement-signing.js"
