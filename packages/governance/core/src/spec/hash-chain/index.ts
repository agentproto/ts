/**
 * agentgovernance/v1 hash-chain protocol.
 *
 * Each audit-log.jsonl line is canonicalized to stable bytes, then
 *   signature = HMAC-SHA256(secret, prev_signature ‖ canonical(row))
 *
 * The first line's prev_signature is the workspace genesis seed (vault-backed).
 * A verifier walks lines, recomputes signatures, compares, reports first mismatch.
 *
 * Periodic anchors: every N lines (default 1000), the latest signature is
 * published to an external sink (S3 with object-lock or transparency log) so
 * a workspace cannot rewrite history without invalidating an external anchor.
 *
 * Protocol spec: ./protocol.md (vendor-neutral, third-party implementable)
 */

export * from "./compute.js"
export * from "./verify.js"
