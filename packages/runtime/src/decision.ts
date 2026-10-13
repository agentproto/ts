/**
 * `decide(policy, evidence)` — the reusable typed decision primitive behind
 * the cost-efficient review router (plan step 0). One closed choice out;
 * the caller maps choice → action (review binding, steward action, …). The
 * primitive never spawns agents, never selects arbitrary model ids, and can
 * only return choices the policy declares.
 *
 * Resolution order (frozen):
 *   1. Ordered rules, first-wins. `floor: true` rules set a mandatory
 *      minimum; nothing below may settle. A floor already pinning the
 *      strongest choice resolves with ZERO model calls.
 *   2. One bounded typed-choice classifier call (`classify` dep — the Jev
 *      adapter in `decision-tools.ts`) for the ambiguous remainder. A
 *      choice is accepted only inside the closed set, with finite
 *      probabilities, at/above `minProbability` with `minMargin` — and only
 *      when evidence meets the completeness requirement.
 *   3. Exactly ONE tool-less LLM escalation (`escalate` dep) on uncertainty
 *      or classifier failure. Its self-reported confidence is NOT calibrated
 *      and is never threshold-checked; its choice is closed-set validated.
 *   4. The policy's conservative default (raised to any matched floor).
 *
 * Missing/invalid probabilities are uncertainty, not certainty. Classifier
 * or escalation failure is recorded as failure — never as approval. Cache
 * keys fold policy hash + evidence hash + classifier config; concurrent
 * identical decisions share one computation.
 */

import type { DecisionPolicy, DecisionWhen } from "./decision-policy.js"
import { decisionPolicyHash, hashStable, stableStringify } from "./decision-policy.js"
import type { JevChoiceQuestion } from "./jev-client.js"

// ── deps (injected — the primitive stays free of network/config coupling) ─

export type ClassifierOutcome =
  | {
      readonly ok: true
      readonly choice: string
      readonly probabilities: Readonly<Record<string, number>>
      readonly confidence?: number
      readonly model?: string
    }
  | { readonly ok: false; readonly error: string }

export type EscalationOutcome =
  | { readonly ok: true; readonly choice: string; readonly evidenceRefs?: readonly string[] }
  | { readonly ok: false; readonly error: string }

export interface DecideDeps {
  /** One bounded typed-choice classifier call (e.g. the generic Jev client). */
  readonly classify?: (input: {
    readonly state: unknown
    readonly question: JevChoiceQuestion
  }) => Promise<ClassifierOutcome>
  /** One tool-less LLM escalation. No tools, no repo access, closed choice out. */
  readonly escalate?: (input: {
    readonly packet: string
  }) => Promise<EscalationOutcome>
}

// ── outcome ───────────────────────────────────────────────────────────────

export type DecisionSource = "rule" | "rule-floor" | "classifier" | "escalation" | "default"

export interface DecisionEscalationHistoryEntry {
  readonly stage: "classifier" | "escalation"
  readonly ok: boolean
  readonly suggestion?: string
  readonly error?: string
}

export interface DecisionOutcome {
  readonly choice: string
  readonly source: DecisionSource
  /** Why this source fired (uncertainty, failure kind, clamping, …). */
  readonly reason?: string
  readonly matchedRules: readonly string[]
  readonly probabilities?: Readonly<Record<string, number>>
  readonly confidence?: number
  /** top1 − top2 over the policy's allowed choices, when computable. */
  readonly margin?: number
  readonly classifierModel?: string
  /** Classifier suggestions that fell below a mandatory floor. */
  readonly clampedToFloor?: boolean
  readonly escalations: number
  readonly escalationHistory: readonly DecisionEscalationHistoryEntry[]
  readonly evidenceRefs: readonly string[]
  readonly truncated: boolean
  readonly incompleteEvidence: boolean
  readonly policyHash: string
  readonly evidenceHash: string
  readonly classifierConfigHash: string
  /** Served from the decision cache (a previous computation). */
  readonly cached?: boolean
  /** Joined an in-flight identical computation instead of starting one. */
  readonly shared?: boolean
}

// ── evidence projection (tier 1 / tier 2 export policy) ───────────────────

/** Key-name classes the DEFAULT export policy keeps inside the process. */
const DENY_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly klass: "paths" | "code" | "messages" }> = [
  { re: /^paths?$/i, klass: "paths" },
  { re: /Path$/, klass: "paths" },
  { re: /_paths?$/, klass: "paths" },
  { re: /^dirs?$/i, klass: "paths" },
  { re: /^files$/i, klass: "paths" },
  { re: /fileContents/i, klass: "code" },
  { re: /^hunks?$/i, klass: "code" },
  { re: /^diff/i, klass: "code" },
  { re: /^code$/i, klass: "code" },
  { re: /^patch(es)?$/i, klass: "code" },
  { re: /^source$/i, klass: "code" },
  { re: /^content$/i, klass: "code" },
  { re: /^snippet/i, klass: "code" },
  { re: /^blob$/i, klass: "code" },
  { re: /^messages?$/i, klass: "messages" },
  { re: /_messages?$/, klass: "messages" },
  { re: /^transcript/i, klass: "messages" },
  { re: /^prompts?$/i, klass: "messages" },
  { re: /^replies$/i, klass: "messages" },
  { re: /^chat/i, klass: "messages" },
  { re: /^(out|in)put$/i, klass: "messages" },
  { re: /^std(out|err)$/i, klass: "messages" },
]

function deniedClass(
  key: string,
  evidencePolicy: DecisionPolicy["evidence"],
): "paths" | "code" | "messages" | null {
  for (const { re, klass } of DENY_PATTERNS) {
    if (!re.test(key)) continue
    if (klass === "paths" && evidencePolicy.allowPaths) return null
    if (klass === "code" && evidencePolicy.allowCode) return null
    if (klass === "messages" && evidencePolicy.allowMessages) return null
    return klass
  }
  return null
}

function getAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

const STRING_VALUE_CAP = 200

/** Project `evidence` into the tier-1 classifier state: field allowlist (or
 *  the closed default export), per-value string caps, then a serialized
 *  size ceiling that drops whole fields (largest first) until it fits.
 *  Denies/size drops are reported so the caller can mark omissions. */
export function projectTier1Evidence(
  policy: DecisionPolicy,
  evidence: Record<string, unknown>,
): { state: Record<string, unknown>; omitted: string[]; truncated: boolean } {
  const ep = policy.evidence
  const omitted: string[] = []
  const entries: Array<[string, unknown]> = []

  if (ep.tier1Fields) {
    for (const field of ep.tier1Fields) {
      const v = getAtPath(evidence, field)
      if (v === undefined) continue
      entries.push([field, v])
    }
    for (const key of Object.keys(evidence)) {
      if (!ep.tier1Fields.includes(key)) omitted.push(key)
    }
  } else {
    for (const [key, value] of Object.entries(evidence)) {
      const denied = deniedClass(key, ep)
      if (denied) {
        omitted.push(key)
        continue
      }
      entries.push([key, value])
    }
  }

  const capValue = (v: unknown): unknown => {
    if (typeof v === "string" && v.length > STRING_VALUE_CAP) return `${v.slice(0, STRING_VALUE_CAP)}…[truncated]`
    if (Array.isArray(v)) return v.map(capValue)
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = capValue(val)
      return out
    }
    return v
  }

  let truncated = false
  const capEntries = (): Array<[string, unknown]> =>
    entries.map(([k, v]) => [k, capValue(v)])

  const serialize = (es: Array<[string, unknown]>): string => {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of es) obj[k] = v
    return stableStringify(obj)
  }

  let working = capEntries()
  let serialized = serialize(working)
  if (serialized.length > ep.maxTier1Chars) {
    // Drop the largest remaining field (by serialized size) until it fits.
    for (;;) {
      let biggestIdx = -1
      let biggestSize = -1
      working.forEach(([k, v], i) => {
        const size = stableStringify({ [k]: v }).length
        if (size > biggestSize) {
          biggestSize = size
          biggestIdx = i
        }
      })
      if (biggestIdx < 0) {
        working = []
        truncated = true
        break
      }
      const droppedEntry = working.splice(biggestIdx, 1)[0]
      if (droppedEntry === undefined) {
        working = []
        truncated = true
        break
      }
      omitted.push(droppedEntry[0])
      truncated = true
      serialized = serialize(working)
      if (serialized.length <= ep.maxTier1Chars) break
    }
  }

  const state: Record<string, unknown> = {}
  for (const [k, v] of working) state[k] = v
  if (omitted.length > 0) state.__omitted__ = omitted
  return { state, omitted, truncated }
}

/** Tier-2 packet for the ONE tool-less escalation: ordered prompt lines —
 *  policy context and the uncertainty reason FIRST, evidence last — capped at
 *  `escalation.maxInputChars` so truncation only ever eats evidence, with an
 *  explicit omission marker. */
export function buildEscalationPacket(
  policy: DecisionPolicy,
  evidence: Record<string, unknown>,
  context: { readonly uncertainty: string; readonly classifierSuggestion?: string },
): { packet: string; truncated: boolean } {
  const ep = policy.evidence
  const projected: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const [key, value] of Object.entries(evidence)) {
    const denied = deniedClass(key, ep)
    if (denied) {
      omitted.push(key)
      continue
    }
    projected[key] = value
  }
  if (omitted.length > 0) projected.__omitted__ = omitted
  const header =
    `policy: ${policy.name ?? "decision"}\n` +
    `choices: ${policy.choices.join(", ")}\n` +
    `uncertainty: ${context.uncertainty}\n` +
    (context.classifierSuggestion !== undefined
      ? `classifierSuggestion: ${context.classifierSuggestion}\n`
      : "") +
    `criteria: ${stableStringify(policy.criteria)}\n` +
    "evidence: "
  const body = header + stableStringify(projected)
  if (body.length <= policy.escalation.maxInputChars) return { packet: body, truncated: false }
  return {
    packet: `${body.slice(0, policy.escalation.maxInputChars)}\n[omitted: escalation packet truncated]`,
    truncated: true,
  }
}

// ── rule evaluation ───────────────────────────────────────────────────────

export function evaluateWhen(when: DecisionWhen, evidence: Record<string, unknown>): boolean {
  if ("allOf" in when) return when.allOf.every(w => evaluateWhen(w, evidence))
  if ("anyOf" in when) return when.anyOf.some(w => evaluateWhen(w, evidence))
  if ("not" in when) return !evaluateWhen(when.not, evidence)
  // Leaf: a missing field never satisfies a positive comparison. `neq` is
  // also false on a missing field — absence is not a difference.
  const value = getAtPath(evidence, when.field)
  if (value === undefined) return false
  if ("eq" in when) return value === when.eq
  if ("neq" in when) return value !== when.neq
  if ("gte" in when) return typeof value === "number" && Number.isFinite(value) && value >= when.gte
  if ("lte" in when) return typeof value === "number" && Number.isFinite(value) && value <= when.lte
  if ("contains" in when) {
    if (Array.isArray(value)) return value.includes(when.contains)
    if (typeof value === "string" && typeof when.contains === "string") return value.includes(when.contains)
    return false
  }
  return false
}

// ── cache ─────────────────────────────────────────────────────────────────

const DECISION_CACHE_MAX = 500
const decisionCache = new Map<string, DecisionOutcome>()
const inFlight = new Map<string, Promise<DecisionOutcome>>()

/** Drop every cached decision (tests, policy swaps). */
export function clearDecisionCache(): void {
  decisionCache.clear()
}

export function decisionCacheSize(): number {
  return decisionCache.size
}

// ── decide ────────────────────────────────────────────────────────────────

function usableConfidence(
  choice: string,
  probabilities: Readonly<Record<string, number>>,
  explicit: number | undefined,
): number | null {
  const candidates = [explicit, probabilities[choice]]
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1) return c
  }
  return null
}

/** top1 − top2 over the POLICY's allowed choices only (probabilities for
 *  undeclared choices do not dilute the margin). */
function marginOverAllowed(
  policy: DecisionPolicy,
  probabilities: Readonly<Record<string, number>>,
): number | null {
  const allowed = policy.choices
    .map(c => probabilities[c])
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1)
  if (allowed.length === 0) return null
  const sorted = [...allowed].sort((a, b) => b - a)
  const top = sorted[0]!
  const second = sorted.length > 1 ? sorted[1]! : 0
  return top - second
}

function evidenceIncomplete(evidence: Record<string, unknown>): boolean {
  if (evidence.complete === false) return true
  const c = evidence.completeness
  return typeof c === "number" && Number.isFinite(c) && c < 1
}

function evidenceRefsOf(evidence: Record<string, unknown>): string[] {
  const refs = evidence.evidenceRefs
  if (!Array.isArray(refs)) return []
  return refs.filter((r): r is string => typeof r === "string")
}

async function decideOnce(
  policy: DecisionPolicy,
  evidence: Record<string, unknown>,
  deps: DecideDeps,
): Promise<DecisionOutcome> {
  const policyHash = decisionPolicyHash(policy)
  const evidenceHash = hashStable(evidence)
  const classifierConfigHash = hashStable({
    kind: policy.classifier.kind,
    model: policy.classifier.model ?? null,
    minProbability: policy.classifier.minProbability,
    minMargin: policy.classifier.minMargin,
    escalationEnabled: policy.escalation.enabled,
    escalationLimit: policy.escalation.limit,
    hasClassifier: deps.classify !== undefined,
    hasEscalation: deps.escalate !== undefined,
  })
  const base = { policyHash, evidenceHash, classifierConfigHash } as const
  const choiceIndex = (c: string): number => policy.choices.indexOf(c)
  const strongest = policy.choices[policy.choices.length - 1]!

  // Tier-1 projection is pure; hoist it so every path reports truncation.
  const { state, truncated } = projectTier1Evidence(policy, evidence)
  const incomplete = truncated || evidenceIncomplete(evidence)

  // ── 1. rules first ──────────────────────────────────────────────────────
  const matchedRules: string[] = []
  const escalationHistory: DecisionEscalationHistoryEntry[] = []
  const escalationsRun = (): number => escalationHistory.filter(h => h.stage === "escalation").length
  let floorChoice: string | null = null
  let resolved: { choice: string; ruleId: string; clamped: boolean } | null = null
  for (const rule of policy.rules) {
    if (!evaluateWhen(rule.when, evidence)) continue
    matchedRules.push(rule.id)
    if (rule.floor) {
      if (floorChoice === null || choiceIndex(rule.choose) > choiceIndex(floorChoice)) {
        floorChoice = rule.choose
      }
      continue
    }
    if (resolved) continue // first resolve wins; later ones are recorded only
    const belowFloor = floorChoice !== null && choiceIndex(rule.choose) < choiceIndex(floorChoice)
    resolved = {
      choice: belowFloor && floorChoice !== null ? floorChoice : rule.choose,
      ruleId: rule.id,
      clamped: belowFloor,
    }
  }
  const finishFloorClamp = (
    choice: string,
    source: DecisionOutcome["source"],
    extra: Partial<DecisionOutcome> = {},
  ): DecisionOutcome => {
    if (floorChoice !== null && choiceIndex(choice) < choiceIndex(floorChoice)) {
      return {
        choice: floorChoice,
        source: "rule-floor",
        reason: `choice "${choice}" raised to mandatory floor "${floorChoice}"`,
        clampedToFloor: true,
        matchedRules,
        escalations: escalationsRun(),
        escalationHistory,
        evidenceRefs: evidenceRefsOf(evidence),
        truncated,
        incompleteEvidence: incomplete,
        ...base,
        ...extra,
      }
    }
    return {
      choice,
      source,
      matchedRules,
      escalations: escalationsRun(),
      escalationHistory,
      evidenceRefs: evidenceRefsOf(evidence),
      truncated,
      incompleteEvidence: incomplete,
      ...base,
      ...extra,
    }
  }
  if (resolved) {
    if (resolved.clamped) {
      return finishFloorClamp(resolved.choice, "rule-floor", {
        reason: `rule "${resolved.ruleId}" chose below floor — raised`,
        clampedToFloor: true,
      })
    }
    return finishFloorClamp(resolved.choice, "rule", {
      reason: `rule "${resolved.ruleId}"`,
    })
  }
  if (floorChoice !== null && floorChoice === strongest) {
    return finishFloorClamp(floorChoice, "rule-floor", {
      reason: "mandatory floor pins the strongest choice — no model call",
    })
  }

  // ── 2. one bounded classifier call for the ambiguous remainder ─────────
  let classifierSuggestion: string | undefined
  let uncertainty = "no classifier configured"
  let classifierModel: string | undefined
  let sawClassifier = false

  if (policy.classifier.kind !== "none" && deps.classify) {
    sawClassifier = true
    const question: JevChoiceQuestion = {
      type: "choice",
      instructions:
        policy.classifier.instructions ??
        `Choose exactly one of: ${policy.choices.join(", ")}. When evidence is thin or ambiguous, choose "${policy.defaultChoice}".`,
      criteria: policy.criteria,
    }
    let outcome: ClassifierOutcome
    try {
      outcome = await deps.classify({ state, question })
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (!outcome.ok) {
      uncertainty = `classifier failed — ${outcome.error}`
      escalationHistory.push({ stage: "classifier", ok: false, error: outcome.error })
    } else if (!policy.choices.includes(outcome.choice)) {
      uncertainty = `classifier returned undeclared choice "${outcome.choice}"`
      escalationHistory.push({ stage: "classifier", ok: false, suggestion: outcome.choice, error: uncertainty })
    } else {
      classifierSuggestion = outcome.choice
      classifierModel = outcome.model
      const confidence = usableConfidence(outcome.choice, outcome.probabilities, outcome.confidence)
      const margin = marginOverAllowed(policy, outcome.probabilities)
      if (confidence === null) {
        uncertainty = "classifier gave no usable probability for the chosen option"
        escalationHistory.push({ stage: "classifier", ok: false, suggestion: outcome.choice, error: uncertainty })
      } else if (policy.evidence.requireCompleteForClassifier && incomplete) {
        uncertainty = truncated
          ? "evidence truncated — classifier score not trusted to downgrade coverage"
          : "evidence incomplete — classifier score not trusted to downgrade coverage"
        escalationHistory.push({ stage: "classifier", ok: false, suggestion: outcome.choice, error: uncertainty })
      } else if (confidence < policy.classifier.minProbability) {
        uncertainty = `classifier confidence ${confidence} < ${policy.classifier.minProbability}`
        escalationHistory.push({ stage: "classifier", ok: false, suggestion: outcome.choice, error: uncertainty })
      } else if (margin !== null && margin < policy.classifier.minMargin) {
        uncertainty = `classifier top-two margin ${margin.toFixed(2)} < ${policy.classifier.minMargin}`
        escalationHistory.push({ stage: "classifier", ok: false, suggestion: outcome.choice, error: uncertainty })
      } else {
        escalationHistory.push({ stage: "classifier", ok: true, suggestion: outcome.choice })
        const extra: Partial<DecisionOutcome> = {
          reason: confidence < 1 || (margin !== null && margin < 1) ? "classifier accepted within thresholds" : undefined,
          ...(Object.keys(outcome.probabilities).length > 0 ? { probabilities: outcome.probabilities } : {}),
          confidence,
          ...(margin !== null ? { margin } : {}),
          ...(classifierModel !== undefined ? { classifierModel } : {}),
        }
        return finishFloorClamp(outcome.choice, "classifier", extra)
      }
    }
  } else if (!sawClassifier) {
    uncertainty = policy.classifier.kind === "none" ? "classifier disabled by policy" : "no classifier backend available"
  }

  // ── 3. exactly one tool-less escalation on uncertainty ─────────────────
  if (policy.escalation.enabled && policy.escalation.limit >= 1 && deps.escalate) {
    const { packet } = buildEscalationPacket(policy, evidence, {
      uncertainty,
      ...(classifierSuggestion !== undefined ? { classifierSuggestion } : {}),
    })
    let esc: EscalationOutcome
    try {
      esc = await deps.escalate({ packet })
    } catch (e) {
      esc = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (!esc.ok) {
      uncertainty = `${uncertainty}; escalation failed — ${esc.error}`
      escalationHistory.push({ stage: "escalation", ok: false, error: esc.error })
    } else if (!policy.choices.includes(esc.choice)) {
      uncertainty = `${uncertainty}; escalation returned undeclared choice "${esc.choice}"`
      escalationHistory.push({ stage: "escalation", ok: false, suggestion: esc.choice, error: uncertainty })
    } else {
      // Self-reported confidence is not calibrated — never thresholded.
      escalationHistory.push({ stage: "escalation", ok: true, suggestion: esc.choice })
      const refs = [...evidenceRefsOf(evidence), ...(esc.evidenceRefs ?? [])]
      return finishFloorClamp(esc.choice, "escalation", {
        reason: `escalated once — ${uncertainty}`,
        evidenceRefs: [...new Set(refs)],
      })
    }
  } else if (!policy.escalation.enabled || policy.escalation.limit < 1) {
    uncertainty = `${uncertainty}; escalation disabled by policy`
  } else {
    uncertainty = `${uncertainty}; no escalation backend available`
  }

  // ── 4. conservative default (never below a matched floor) ──────────────
  return finishFloorClamp(policy.defaultChoice, "default", {
    reason: uncertainty,
  })
}

/**
 * Resolve ONE decision. Never throws for classifier/escalation trouble —
 * those fall through to the conservative default with the failure recorded
 * in `escalationHistory`. Only `classify`/`escalate` contract violations
 * (unknown choices, bad probabilities) count as uncertainty.
 */
export async function decide(
  policy: DecisionPolicy,
  evidence: unknown,
  deps: DecideDeps = {},
): Promise<DecisionOutcome> {
  const record: Record<string, unknown> =
    evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : { value: evidence }
  const policyHash = decisionPolicyHash(policy)
  const evidenceHash = hashStable(record)
  const depBits = `${deps.classify ? "c" : ""}${deps.escalate ? "e" : ""}`
  const key = `${policyHash}:${evidenceHash}:${policy.classifier.kind}:${policy.classifier.model ?? ""}:${policy.classifier.minProbability}:${policy.classifier.minMargin}:${policy.escalation.enabled ? policy.escalation.limit : 0}:${depBits}`

  const hit = decisionCache.get(key)
  if (hit) return { ...hit, cached: true }

  const pending = inFlight.get(key)
  if (pending) {
    const shared = await pending
    return { ...shared, shared: true }
  }

  const work = decideOnce(policy, record, deps)
    .then(outcome => {
      decisionCache.set(key, outcome)
      while (decisionCache.size > DECISION_CACHE_MAX) {
        const oldest = decisionCache.keys().next().value
        if (oldest === undefined) break
        decisionCache.delete(oldest)
      }
      return outcome
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, work)
  return work
}
