/**
 * agentgovernance/v1 validators.
 *
 * Per-doctype validators that take file content (string) and return a typed
 * ValidationResult. Cross-doctype consistency checks live alongside.
 *
 * Validators do NOT touch the filesystem — callers pass file contents in.
 * For FS-aware orchestration, see `../../runtime/`.
 */

import type { z } from "zod"
import matter from "gray-matter"

import { signatureSchema, type Signature } from "../doctypes/signature.js"
import { auditEventSchema, type AuditEvent } from "../doctypes/audit-event.js"
import { policyFrontmatterSchema, type Policy } from "../doctypes/policy.js"
import {
  verifyChain,
  type VerifyChainOptions,
  type VerifyChainResult,
} from "../hash-chain/verify.js"

export type ValidationResult<T = unknown> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: ValidationError[]; warnings: string[] }

export interface ValidationError {
  path: string[]
  message: string
  code?: string
}

/** Convert a zod error into our flat ValidationError array. */
function fromZodError(err: z.ZodError): ValidationError[] {
  return err.issues.map(issue => ({
    path: issue.path.map(p => String(p)),
    message: issue.message,
    code: issue.code,
  }))
}

function err(
  message: string,
  code: string,
  path: string[] = []
): ValidationError[] {
  return [{ path, message, code }]
}

// ─── Per-doctype validators ──────────────────────────────────────────────

/**
 * Validate a `signature.json` file content (raw JSON string).
 */
export function validateSignature(json: string): ValidationResult<Signature> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return {
      ok: false,
      errors: err(`JSON parse error: ${(e as Error).message}`, "parse_error"),
      warnings: [],
    }
  }
  const result = signatureSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, errors: fromZodError(result.error), warnings: [] }
  }
  return { ok: true, value: result.data, warnings: [] }
}

/**
 * Validate a single line of an audit-log.jsonl file.
 *
 * Whitespace is trimmed; empty input returns parse_error.
 */
export function validateAuditEvent(line: string): ValidationResult<AuditEvent> {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      errors: err("Empty line", "parse_error"),
      warnings: [],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return {
      ok: false,
      errors: err(`JSON parse error: ${(e as Error).message}`, "parse_error"),
      warnings: [],
    }
  }
  const result = auditEventSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, errors: fromZodError(result.error), warnings: [] }
  }
  return { ok: true, value: result.data, warnings: [] }
}

/**
 * Validate a POLICY.md file content (markdown with YAML frontmatter).
 */
export function validatePolicy(markdown: string): ValidationResult<Policy> {
  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(markdown)
  } catch (e) {
    return {
      ok: false,
      errors: err(
        `Frontmatter parse error: ${(e as Error).message}`,
        "parse_error"
      ),
      warnings: [],
    }
  }

  const fmResult = policyFrontmatterSchema.safeParse(parsed.data)
  if (!fmResult.success) {
    return {
      ok: false,
      errors: fromZodError(fmResult.error).map(e => ({
        ...e,
        path: ["frontmatter", ...e.path],
      })),
      warnings: [],
    }
  }
  return {
    ok: true,
    value: { frontmatter: fmResult.data, body: parsed.content },
    warnings: [],
  }
}

// ─── Cross-doctype validators ────────────────────────────────────────────

/**
 * Validate an entire audit-log.jsonl file: every line parses + every line
 * passes the audit-event schema + the hash chain verifies end-to-end.
 *
 * Returns the parsed events on success; the first mismatch (schema or chain)
 * on failure.
 */
export function validateAuditLog(
  jsonl: string,
  opts: VerifyChainOptions
): ValidationResult<{ events: AuditEvent[]; chain: VerifyChainResult }> {
  const lines = jsonl
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
  const events: AuditEvent[] = []
  const errors: ValidationError[] = []

  for (let i = 0; i < lines.length; i++) {
    const result = validateAuditEvent(lines[i]!)
    if (!result.ok) {
      errors.push(
        ...result.errors.map(e => ({ ...e, path: [`line[${i}]`, ...e.path] }))
      )
      continue
    }
    events.push(result.value)
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings: [] }
  }

  const chain = verifyChain(jsonl, opts)
  if (!chain.ok) {
    return {
      ok: false,
      errors: err(chain.message, chain.reason, [`line[${chain.brokenAtLine}]`]),
      warnings: [],
    }
  }

  return { ok: true, value: { events, chain }, warnings: [] }
}

/**
 * Verify that a signature's `documentHash` matches the SHA-256 of the artifact bytes
 * it claims to sign.
 */
export function validateSignatureAgainstArtifact(
  signature: Signature,
  artifactBytes: Uint8Array,
  computeSha256Hex: (bytes: Uint8Array) => string
): ValidationResult<true> {
  const actual = computeSha256Hex(artifactBytes)
  if (actual !== signature.documentHash) {
    return {
      ok: false,
      errors: err(
        `documentHash mismatch: signature claims ${signature.documentHash}, artifact hashes to ${actual}`,
        "document_hash_mismatch"
      ),
      warnings: [],
    }
  }
  return { ok: true, value: true, warnings: [] }
}

// Re-export from doctypes for convenience.
export type { Signature, AuditEvent, Policy }
