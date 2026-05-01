/**
 * @agentproto/agencies — agentagencies/v1 spec implementation.
 *
 * Operating layer for entities that exercise *agency* — both in the business
 * sense (service businesses, consultancies, freelancers) and the philosophical
 * sense (any system that acts with intention, autonomy, decision-making).
 *
 * Extends agentcompanies/v1 (org structure) + agentgovernance/v1 (audit + signing)
 * with operations doctypes: AGENCY, OPERATIONS, SERVICE, PROCEDURE, PRICING-MODEL,
 * COUNTERPARTY, ENGAGEMENT, AGREEMENT, DELIVERABLE, INVOICE, ROUTINE, CAPACITY.
 *
 * Subpath exports:
 *   - "./doctypes"     — zod schemas + inferred types for all operations doctypes
 *   - "./validators"   — per-doctype + cross-doctype validators
 *   - "./composition"  — resolver for the 4 composition patterns
 *   - "./renderers"    — canvakit template ids + variable schemas + bundled HTML
 *
 * Reference runtime (workspace walkers like `computeAgencyOverview`,
 * snapshot index helpers, FS-only orchestrators) lives in the sibling package
 * `@agentproto/agencies-engine`. Spec stays pure: zero I/O, zero filesystem deps.
 *
 * Spec doc: ./AGENTAGENCIES.md (canonical, included in npm publish)
 */

export const SPEC_NAME = "agentagencies/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export * from "./spec/doctypes/index.js"
export * from "./spec/validators/index.js"
