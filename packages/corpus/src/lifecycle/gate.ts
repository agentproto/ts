/**
 * Auto-promote gate — evaluates a candidate against
 * `KNOWLEDGE.md.metadata.corpus.autoPromote.requires`.
 *
 * The plan's auto-promote requirements (from the workspace manifest
 * example) typically include:
 *
 *   qualityScore: { min: 4.2 }
 *   riskScore:    { max: 1.5 }
 *   hasArchiveHash: true
 *   requiredFields: [why_it_works, transferable_pattern, use_when, avoid_when]
 *   notRestricted: true
 *
 * This gate returns a structured GateResult with pass/fail + the
 * specific rules that failed, so the caller can either auto-promote
 * (all pass) or route to human review (corpus-review collection)
 * with the failure reasons attached.
 *
 * Pure — no I/O.
 */

import type { CorpusWorkspaceSnapshot } from "../types.js"

export interface AutoPromoteRequirements {
  readonly qualityScore?: { min?: number; max?: number }
  readonly riskScore?: { min?: number; max?: number }
  readonly hasArchiveHash?: boolean
  readonly requiredFields?: readonly string[]
  readonly notRestricted?: boolean
}

export interface AutoPromoteConfig {
  readonly enabled: boolean
  readonly requires?: AutoPromoteRequirements
}

export interface CandidateForGate {
  /** Parsed candidate frontmatter (analyzed state) + body. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
  /** Optional analysis output — fields the analyst produced. */
  readonly analysis?: Readonly<Record<string, unknown>>
}

export interface GateFailure {
  readonly rule: string
  readonly message: string
}

export interface GateResult {
  readonly passed: boolean
  readonly failures: readonly GateFailure[]
  /** True when the workspace itself has auto-promote disabled. */
  readonly disabled: boolean
}

/**
 * Read the auto-promote config from a workspace snapshot. Returns
 * a "disabled" config if the workspace doesn't declare one — the
 * gate will short-circuit to "always require human review".
 */
export function extractAutoPromoteConfig(
  snapshot: CorpusWorkspaceSnapshot
): AutoPromoteConfig {
  const ws = snapshot.workspace
  if (!ws) return { enabled: false }
  const corpus = (ws.frontmatter.metadata as { corpus?: unknown })
    ?.corpus as { autoPromote?: AutoPromoteConfig } | undefined
  if (!corpus?.autoPromote) return { enabled: false }
  return corpus.autoPromote
}

/**
 * Evaluate a candidate against the workspace's auto-promote config.
 * Returns `passed: true` only when every declared requirement holds.
 */
export function evaluateGate(
  candidate: CandidateForGate,
  config: AutoPromoteConfig
): GateResult {
  if (!config.enabled) {
    return { passed: false, failures: [], disabled: true }
  }
  const requires = config.requires ?? {}
  const failures: GateFailure[] = []

  // Look at both candidate-level metadata.corpus.* (for promoted-from-analyzed
  // shape) and the candidate's flat fields (for AIP-18 collection items
  // whose fields live at the top level of frontmatter).
  const flat = candidate.frontmatter
  const corpusMeta =
    (flat.metadata as { corpus?: Record<string, unknown> })?.corpus ?? {}
  // Prefer corpus-namespaced fields when present (analyzed → promoted
  // path), falling back to flat ITEM.md fields (AIP-18 raw shape).
  const get = (key: string): unknown => {
    if (corpusMeta[key] !== undefined) return corpusMeta[key]
    if (flat[key] !== undefined) return flat[key]
    return undefined
  }

  // qualityScore
  if (requires.qualityScore) {
    const q = get("qualityScore")
    if (typeof q !== "number") {
      failures.push({
        rule: "qualityScore",
        message: "qualityScore is missing (required by autoPromote)",
      })
    } else {
      if (requires.qualityScore.min !== undefined && q < requires.qualityScore.min) {
        failures.push({
          rule: "qualityScore",
          message: `qualityScore ${q} < min ${requires.qualityScore.min}`,
        })
      }
      if (requires.qualityScore.max !== undefined && q > requires.qualityScore.max) {
        failures.push({
          rule: "qualityScore",
          message: `qualityScore ${q} > max ${requires.qualityScore.max}`,
        })
      }
    }
  }

  // riskScore
  if (requires.riskScore) {
    const r = get("riskScore")
    if (typeof r !== "number") {
      failures.push({
        rule: "riskScore",
        message: "riskScore is missing (required by autoPromote)",
      })
    } else {
      if (requires.riskScore.min !== undefined && r < requires.riskScore.min) {
        failures.push({
          rule: "riskScore",
          message: `riskScore ${r} < min ${requires.riskScore.min}`,
        })
      }
      if (requires.riskScore.max !== undefined && r > requires.riskScore.max) {
        failures.push({
          rule: "riskScore",
          message: `riskScore ${r} > max ${requires.riskScore.max}`,
        })
      }
    }
  }

  // hasArchiveHash — the candidate must point at a source whose
  // content_hash exists. We look at the candidate's `contentHash`
  // field (the AIP-18 ITEM convention) for a quick check.
  if (requires.hasArchiveHash) {
    const h = get("contentHash") ?? get("content_hash")
    if (typeof h !== "string" || !/^(sha256|sha512|blake3):/.test(h)) {
      failures.push({
        rule: "hasArchiveHash",
        message: "candidate has no archive-grade content_hash",
      })
    }
  }

  // requiredFields — every named field must be present and non-empty
  // in the analysis output (typically the body of the ITEM.md or the
  // candidate's `analysis` block).
  if (requires.requiredFields && requires.requiredFields.length > 0) {
    const analysis = candidate.analysis ?? {}
    const body = candidate.body
    for (const field of requires.requiredFields) {
      const inAnalysis =
        (analysis as Record<string, unknown>)[field]
      const inBody = body.includes(`## ${humanize(field)}`) ||
        body.includes(`## ${field}`)
      if (
        (typeof inAnalysis !== "string" || inAnalysis.trim().length === 0) &&
        !inBody
      ) {
        failures.push({
          rule: "requiredFields",
          message: `candidate is missing required field "${field}" (not in analysis.${field} nor in body section "## ${humanize(field)}")`,
        })
      }
    }
  }

  // notRestricted — candidate's metadata.corpus.access.classification
  // must not be "restricted" or "secret".
  if (requires.notRestricted) {
    const access =
      (corpusMeta as { access?: { classification?: string } }).access
    const cls = access?.classification
    if (cls === "restricted" || cls === "secret") {
      failures.push({
        rule: "notRestricted",
        message: `candidate access.classification is "${cls}" — fails notRestricted gate`,
      })
    }
  }

  return {
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    disabled: false,
  }
}

/** snake_case + camelCase → "Snake case" / "Camel case" for body matching. */
function humanize(field: string): string {
  const spaced = field
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
