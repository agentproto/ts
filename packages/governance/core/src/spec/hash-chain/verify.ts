import { computeChainSignature } from "./compute.js"

/**
 * agentgovernance/v1 hash-chain — verifier.
 *
 * Walks an audit-log.jsonl file, recomputing each line's signature given the
 * previous one, and reports the first mismatch. Reports either:
 *   - ok with the count of verified lines + last signature (handy for anchoring)
 *   - first-mismatch diagnostic (line index, expected vs actual)
 *
 * The verifier is intentionally simple so third-party implementations in any
 * language can be tested for compatibility. See `protocol.md` for the wire
 * format and reference test vectors.
 */

export interface VerifyChainOptions {
  /** HMAC secret (must match the one used to compute signatures). */
  secret: string
  /** Workspace genesis seed (hex). Becomes prev_signature for the first line. */
  genesisSeed: string
  /** Optional inclusive starting line index (0-based). Defaults to 0. */
  rangeStart?: number
  /** Optional inclusive ending line index (0-based). Defaults to last line. */
  rangeEnd?: number
}

export type VerifyChainResult =
  | {
      ok: true
      /** Number of lines verified (inside the optional range). */
      verifiedLines: number
      /** The last line's signature — anchor candidate. */
      lastSignature: string
    }
  | {
      ok: false
      /** 0-based line index where verification failed. */
      brokenAtLine: number
      /** What the verifier computed (expected). */
      expected: string
      /** What the file claims (actual). */
      actual: string
      /** Human-readable diagnostic. */
      message: string
      /** Detail kind for programmatic handling. */
      reason:
        | "prev_signature_mismatch"
        | "signature_mismatch"
        | "missing_field"
        | "parse_error"
    }

/**
 * Verify a JSONL audit log's hash chain.
 *
 * Empty lines are skipped. Whitespace-only lines are skipped. JSON parse errors
 * are reported as `parse_error`.
 */
export function verifyChain(
  jsonl: string,
  opts: VerifyChainOptions
): VerifyChainResult {
  if (!/^[a-f0-9]{64}$/.test(opts.genesisSeed)) {
    return {
      ok: false,
      brokenAtLine: -1,
      expected: "<64-char hex>",
      actual: opts.genesisSeed,
      message: "genesisSeed must be 64-char lowercase hex",
      reason: "missing_field",
    }
  }

  const lines = jsonl
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
  const start = opts.rangeStart ?? 0
  const end = opts.rangeEnd ?? lines.length - 1

  let prevSignature = opts.genesisSeed
  let verifiedLines = 0
  let lastSignature = prevSignature

  for (let i = 0; i < lines.length; i++) {
    if (i < start) {
      // Walk forward to maintain chain state up to the range start.
      const computed = stepLineOrError(lines[i]!, prevSignature, opts.secret, i)
      if (typeof computed !== "string") return computed
      prevSignature = computed
      lastSignature = computed
      continue
    }
    if (i > end) break

    const computed = stepLineOrError(lines[i]!, prevSignature, opts.secret, i)
    if (typeof computed !== "string") return computed
    prevSignature = computed
    lastSignature = computed
    verifiedLines++
  }

  return { ok: true, verifiedLines, lastSignature }
}

/** Advance the chain by one line. Returns the new signature or a typed error result. */
function stepLineOrError(
  line: string,
  prevSignature: string,
  secret: string,
  lineIndex: number
): string | Extract<VerifyChainResult, { ok: false }> {
  let row: Record<string, unknown>
  try {
    row = JSON.parse(line) as Record<string, unknown>
  } catch (e) {
    return {
      ok: false,
      brokenAtLine: lineIndex,
      expected: "<parsable JSON>",
      actual: line.length > 80 ? line.slice(0, 80) + "..." : line,
      message: `Line ${lineIndex}: JSON parse error — ${(e as Error).message}`,
      reason: "parse_error",
    }
  }

  if (
    typeof row.prevSignature !== "string" ||
    typeof row.signature !== "string"
  ) {
    return {
      ok: false,
      brokenAtLine: lineIndex,
      expected: "<row with prevSignature and signature fields>",
      actual: JSON.stringify({
        hasPrevSignature: typeof row.prevSignature,
        hasSignature: typeof row.signature,
      }),
      message: `Line ${lineIndex}: missing prevSignature or signature`,
      reason: "missing_field",
    }
  }

  if (row.prevSignature !== prevSignature) {
    return {
      ok: false,
      brokenAtLine: lineIndex,
      expected: prevSignature,
      actual: row.prevSignature,
      message: `Line ${lineIndex}: prevSignature mismatch — chain forked or row reordered`,
      reason: "prev_signature_mismatch",
    }
  }

  const computed = computeChainSignature(row, prevSignature, secret)
  if (computed !== row.signature) {
    return {
      ok: false,
      brokenAtLine: lineIndex,
      expected: computed,
      actual: row.signature,
      message: `Line ${lineIndex}: signature mismatch — row content tampered`,
      reason: "signature_mismatch",
    }
  }

  return computed
}
