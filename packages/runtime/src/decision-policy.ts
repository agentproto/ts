/**
 * DECISION.md — the policy half of the cost-efficient decision router.
 *
 * A DECISION.md is markdown with YAML frontmatter: a closed choice set, an
 * ordered rule list (deterministic, first-wins), classifier/escalation
 * knobs, an evidence export policy, and a conservative default. The body
 * holds human-readable criteria and examples; only the frontmatter is
 * machine-read.
 *
 * The parser is deliberately strict and total: every rule's `choose` must
 * name a declared choice, every choice must carry criteria text (a Jev
 * question is built from them), and the default must be a choice. Nothing
 * here calls a model — this file is pure parse/validate/hash so a policy
 * can be reviewed, diffed and cache-keyed on its own.
 *
 * Lives next to `jev-client.ts` (its only runtime consumer): DECISION.md is
 * specified by AIP-65 (Draft) — the typed question / judge-ladder /
 * escalation primitive this file parses and validates. It is not an
 * AIP-scaffolded doctype (`@agentproto/define-doctype` is the factory for
 * AIP `defineX` constructors with a generated schema.ts); AIP-65 has no
 * vendored JSON Schema under `specs/resources/`, so this file's shape is
 * hand-written against the spec prose instead of generated from a draft.
 */

import { createHash } from "node:crypto"
import matter from "gray-matter"
import { z } from "zod"

// ── condition language (evaluated against a flat-ish evidence object) ─────

export type DecisionWhen =
  | { readonly allOf: readonly DecisionWhen[] }
  | { readonly anyOf: readonly DecisionWhen[] }
  | { readonly not: DecisionWhen }
  | { readonly field: string; readonly eq: string | number | boolean }
  | { readonly field: string; readonly neq: string | number | boolean }
  | { readonly field: string; readonly gte: number }
  | { readonly field: string; readonly lte: number }
  | { readonly field: string; readonly contains: string | number | boolean }

const scalarSchema = z.union([z.string(), z.number(), z.boolean()])

const whenSchema: z.ZodType<DecisionWhen> = z.lazy(() =>
  z.union([
    z.object({ allOf: z.array(whenSchema).min(1) }),
    z.object({ anyOf: z.array(whenSchema).min(1) }),
    z.object({ not: whenSchema }),
    z.object({ field: z.string().min(1), eq: scalarSchema }),
    z.object({ field: z.string().min(1), neq: scalarSchema }),
    z.object({ field: z.string().min(1), gte: z.number() }),
    z.object({ field: z.string().min(1), lte: z.number() }),
    z.object({ field: z.string().min(1), contains: scalarSchema }),
  ]),
)

// ── frontmatter schema ────────────────────────────────────────────────────

export const DECISION_POLICY_SCHEMA_VERSION = 1

const ruleSchema = z.object({
  id: z.string().min(1),
  when: whenSchema,
  /** The choice this rule selects (resolve) or floors (floor). */
  choose: z.string().min(1),
  /**
   * `false` (default): first matching rule resolves the decision outright.
   * `true`: the rule sets a mandatory MINIMUM — no classifier, escalation or
   * default may settle below it. Floors never make model calls by themselves
   * unless they already pin the strongest choice.
   */
  floor: z.boolean().default(false),
  note: z.string().optional(),
})

const classifierSchema = z.object({
  /** `jev` = one bounded typed-choice call; `none` = rules/default only. */
  kind: z.enum(["jev", "none"]).default("jev"),
  model: z.string().min(1).optional(),
  instructions: z.string().optional(),
  /** Accept a classifier choice only at/above this probability. Default 0.85. */
  minProbability: z.number().min(0).max(1).default(0.85),
  /** …and with this top-two margin over the other allowed choices. Default 0.20. */
  minMargin: z.number().min(0).max(1).default(0.20),
})

const escalationSchema = z.object({
  /** At most one bounded harness escalation on uncertainty, ever (read-only posture, no MCP servers; harness built-ins are not claimed disabled). Never a loop. */
  enabled: z.boolean().default(true),
  limit: z.number().int().min(0).max(1).default(1),
  /** Character ceiling for the tier-2 escalation packet. Default 6000. */
  maxInputChars: z.number().int().min(200).max(50_000).default(6_000),
})

const evidenceSchema = z.object({
  /**
   * Explicit allowlist of evidence fields (dot paths) exported to the
   * classifier as tier 1. When omitted, every field is exported EXCEPT the
   * denied classes below — still subject to the size ceiling.
   */
  tier1Fields: z.array(z.string().min(1)).optional(),
  /** Defaults are closed: no paths, code, or messages leave the process. */
  allowPaths: z.boolean().default(false),
  allowCode: z.boolean().default(false),
  allowMessages: z.boolean().default(false),
  /** Tier-1 serialized ceiling. Default 2048 (aim ≤2 KB metadata packet). */
  maxTier1Chars: z.number().int().min(200).max(20_000).default(2_048),
  /** Refuse to accept a classifier choice when evidence is incomplete/truncated. Default true. */
  requireCompleteForClassifier: z.boolean().default(true),
})

export const decisionPolicyFrontmatterSchema = z
  .object({
    schema: z.literal(DECISION_POLICY_SCHEMA_VERSION),
    name: z.string().min(1).optional(),
    /** Policy revision, folded into the cache key. */
    version: z.union([z.string().min(1), z.number()]).transform(v => String(v)).optional(),
    /** Closed choice set, ordered weakest → strongest. */
    choices: z.array(z.string().min(1)).min(2),
    /** Conservative fallback when nothing resolves. */
    default: z.string().min(1),
    /** Choice → what selecting it means (also Jev criteria). */
    criteria: z.record(z.string(), z.string()),
    classifier: classifierSchema.prefault({}),
    escalation: escalationSchema.prefault({}),
    evidence: evidenceSchema.prefault({}),
    rules: z.array(ruleSchema).default([]),
  })
  .superRefine((fm, ctx) => {
    if (!fm.choices.includes(fm.default)) {
      ctx.addIssue({ code: "custom", message: `\`default\` ("${fm.default}") is not one of \`choices\`` })
    }
    for (const choice of fm.choices) {
      if (!fm.criteria[choice]?.trim()) {
        ctx.addIssue({ code: "custom", message: `choice "${choice}" has no \`criteria\` description` })
      }
    }
    const unknownCriteria = Object.keys(fm.criteria).filter(c => !fm.choices.includes(c))
    if (unknownCriteria.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `\`criteria\` describes undeclared choice(s): ${unknownCriteria.join(", ")}`,
      })
    }
    const seen = new Set<string>()
    fm.rules.forEach((rule, i) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate rule id "${rule.id}"` })
      }
      seen.add(rule.id)
      if (!fm.choices.includes(rule.choose)) {
        ctx.addIssue({
          code: "custom",
          message: `rules[${i}] ("${rule.id}") chooses "${rule.choose}" — not one of \`choices\``,
        })
      }
    })
  })

export type DecisionPolicyFrontmatter = z.infer<typeof decisionPolicyFrontmatterSchema>

export interface DecisionPolicy {
  readonly name?: string
  readonly version?: string
  readonly choices: readonly string[]
  readonly defaultChoice: string
  readonly criteria: Readonly<Record<string, string>>
  readonly classifier: {
    readonly kind: "jev" | "none"
    readonly model?: string
    readonly instructions?: string
    readonly minProbability: number
    readonly minMargin: number
  }
  readonly escalation: {
    readonly enabled: boolean
    readonly limit: 0 | 1
    readonly maxInputChars: number
  }
  readonly evidence: {
    readonly tier1Fields?: readonly string[]
    readonly allowPaths: boolean
    readonly allowCode: boolean
    readonly allowMessages: boolean
    readonly maxTier1Chars: number
    readonly requireCompleteForClassifier: boolean
  }
  readonly rules: readonly {
    readonly id: string
    readonly when: DecisionWhen
    readonly choose: string
    readonly floor: boolean
    readonly note?: string
  }[]
  /** Human criteria/examples from the markdown body — never machine-read. */
  readonly body: string
}

export type DecisionPolicyParse =
  | { readonly ok: true; readonly policy: DecisionPolicy }
  | { readonly ok: false; readonly errors: readonly string[] }

function describeZodIssues(error: z.ZodError): string[] {
  return error.issues.map(issue =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  )
}

/** Parse and fully validate a DECISION.md. Never throws — malformed policies
 *  come back as `{ ok:false, errors }` so a workflow can report them. */
export function parseDecisionPolicy(markdown: string): DecisionPolicyParse {
  let frontmatter: unknown
  let body: string
  try {
    const parsed = matter(markdown)
    frontmatter = parsed.data
    body = parsed.content.trim()
  } catch (e) {
    return { ok: false, errors: [`frontmatter: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const fm = decisionPolicyFrontmatterSchema.safeParse(frontmatter)
  if (!fm.success) return { ok: false, errors: describeZodIssues(fm.error) }
  const v = fm.data
  const policy: DecisionPolicy = {
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.version !== undefined ? { version: v.version } : {}),
    choices: v.choices,
    defaultChoice: v.default,
    criteria: v.criteria,
    classifier: {
      kind: v.classifier.kind,
      ...(v.classifier.model !== undefined ? { model: v.classifier.model } : {}),
      ...(v.classifier.instructions !== undefined ? { instructions: v.classifier.instructions } : {}),
      minProbability: v.classifier.minProbability,
      minMargin: v.classifier.minMargin,
    },
    escalation: {
      enabled: v.escalation.enabled,
      limit: v.escalation.limit as 0 | 1,
      maxInputChars: v.escalation.maxInputChars,
    },
    evidence: {
      ...(v.evidence.tier1Fields !== undefined ? { tier1Fields: v.evidence.tier1Fields } : {}),
      allowPaths: v.evidence.allowPaths,
      allowCode: v.evidence.allowCode,
      allowMessages: v.evidence.allowMessages,
      maxTier1Chars: v.evidence.maxTier1Chars,
      requireCompleteForClassifier: v.evidence.requireCompleteForClassifier,
    },
    rules: v.rules,
    body,
  }
  return { ok: true, policy }
}

// ── stable hashing (cache keys, provenance) ───────────────────────────────

/** Deterministic JSON: object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

export function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

/** Cache/provenance hash of the machine-read policy (frontmatter fields,
 *  not the body prose — body edits don't change routing; criteria text is
 *  in `criteria` and DOES hash). */
export function decisionPolicyHash(policy: DecisionPolicy): string {
  return hashStable({
    schema: DECISION_POLICY_SCHEMA_VERSION,
    name: policy.name,
    version: policy.version,
    choices: policy.choices,
    default: policy.defaultChoice,
    criteria: policy.criteria,
    classifier: policy.classifier,
    escalation: policy.escalation,
    evidence: policy.evidence,
    rules: policy.rules,
  })
}
