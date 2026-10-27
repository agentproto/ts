/**
 * @agentproto/agency - AIP-21 AGENCY.md `defineAgency` reference impl.
 *
 * A workspace-only successor to AIP-8 that drops the eleven hardcoded agency doctypes (service, engagement, agreement, deliverable, invoice, counterparty, procedure, pricing-model, routine, capacity, agency) and delegates all per-doctype schema work to AIP-18 collections - owning only the workspace root manifest, the engagement lifecycle helpers that span collections, scope axes, and cross-AIP composition with strong governance and work bindings.
 *
 * Spec: https://agentproto.sh/docs/aip-21
 *
 * Authoring paths:
 *   - TS:  `defineAgency({...})` → `AgencyV2Handle`
 *   - MD:  `parseAgencyV2Manifest(src) → agencyV2FromManifest({...})` → `AgencyV2Handle`
 */

export const SPEC_NAME = "agency/v2" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineAgency } from "./define-agency-v2.js"
export type { AgencyV2Definition, AgencyV2Handle } from "./types.js"
