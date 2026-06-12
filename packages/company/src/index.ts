/**
 * @agentproto/company — AIP-6 COMPANY.md `defineCompany` reference impl.
 *
 * A filesystem-first, vendor-neutral file format for representing AI companies — their org structure, roles, and objectives — as portable git-native packages.
 *
 * Spec: https://agentproto.sh/docs/aip-6
 *
 * Authoring paths:
 *   - TS:  `defineCompany({...})` → `CompanyHandle`
 *   - MD:  `parseCompanyManifest(src) → companyFromManifest({...})` → `CompanyHandle`
 */

export const SPEC_NAME = "agentcompany/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineCompany } from "./define-company.js"
export { companyPositions } from "./structure.js"
export type { CompanyDefinition, CompanyHandle } from "./types.js"
