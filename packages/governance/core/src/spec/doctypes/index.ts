/**
 * agentgovernance/v1 doctypes — zod schemas + inferred types.
 *
 * Three doctypes (domain-agnostic, reusable beyond agencies):
 *   - signature.json — universal approval primitive
 *   - audit-log.jsonl line — hash-chained event log entry
 *   - POLICY.md — declarative autonomy rule
 */

export * from "./signature.js"
export * from "./audit-event.js"
export * from "./policy.js"
