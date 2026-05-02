/**
 * @agentproto/office — AIP-22 OFFICE.md `defineOffice` reference impl.
 *
 * A live operating workspace for an organisation — declares which collections (roles, objectives, departments, teams, policies) are tracked, the org-tree containment, reporting hierarchy, and cross-AIP composition with governance, work, knowledge, and agency. Distinct from AIP-6's static company profile (companies.sh community standard).
 *
 * Spec: https://agentproto.sh/docs/aip-22
 *
 * Authoring paths:
 *   - TS:  `defineOffice({...})` → `OfficeHandle`
 *   - MD:  `parseOfficeManifest(src) → officeFromManifest({...})` → `OfficeHandle`
 */

export const SPEC_NAME = "agentoffice/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineOffice } from "./define-office.js"
export type { OfficeDefinition, OfficeHandle } from "./types.js"
