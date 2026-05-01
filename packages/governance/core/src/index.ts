/**
 * @agentproto/governance — agentgovernance/v1 spec implementation.
 *
 * Universal contractual approval framework: signatures, audit logs, policies.
 * All doctypes are workspace files; this package is filesystem-first and
 * vendor-neutral (no Mastra, LangChain, Temporal imports).
 *
 * Subpath exports:
 *   - "./doctypes"   — zod schemas + inferred types for signature, audit-event, policy
 *   - "./hash-chain" — canonical row hashing + chain compute/verify
 *   - "./validators" — per-doctype validators
 *
 * Reference runtime (audit-chain writer, sign-artifact orchestrator, _index
 * helpers) lives in the sibling package `@agentproto/governance-engine`. Spec
 * stays pure: zero I/O, zero filesystem deps. Consumers needing only types +
 * validators (CI validators, third-party language ports) avoid pulling node:fs.
 *
 * Spec doc: ./AGENTGOVERNANCE.md (canonical)
 *           src/spec/agentgovernance-v1.md (source of truth)
 */

export const SPEC_NAME = "agentgovernance/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export * from "./spec/doctypes/index.js"
export * from "./spec/validators/index.js"
export * from "./spec/hash-chain/index.js"
