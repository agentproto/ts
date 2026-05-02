/**
 * @agentproto/agency-v2 — AIP-21 AGENCY.md `defineAgencyV2` reference impl.
 *
 * A workspace-only successor to AIP-8 that drops the eleven hardcoded agency doctypes (service, engagement, agreement, deliverable, invoice, counterparty, procedure, pricing-model, routine, capacity, agency) and delegates all per-doctype schema work to AIP-18 collections — owning only the workspace root manifest, the engagement lifecycle helpers that span collections, scope axes, and cross-AIP composition with strong governance and work bindings.
 *
 * Spec: https://agentproto.sh/docs/aip-21
 *
 * Authoring paths:
 *   - TS:  `defineAgencyV2({...})` → `AgencyV2Handle`
 *   - MD:  `parseAgencyV2Manifest(src) → agencyV2FromManifest({...})` → `AgencyV2Handle`
 */

export const SPEC_NAME = "agentagency-v2/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineAgencyV2 } from "./define-agency-v2.js"
export type { AgencyV2Definition, AgencyV2Handle } from "./types.js"
