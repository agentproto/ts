/**
 * The decision router: DECISION.md parsing, rules-first resolution with
 * mandatory floors, one bounded classifier call, one tool-less escalation,
 * conservative default, evidence export policy, and the shared decision
 * cache. Fake classifier/escalation only — no network, no live models.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildEscalationPacket,
  clearDecisionCache,
  decide,
  evaluateWhen,
  projectTier1Evidence,
  type ClassifierOutcome,
  type EscalationOutcome,
} from "../decision.js"
import { decisionPolicyHash, parseDecisionPolicy } from "../decision-policy.js"
import { makeJevDecisionClassifier } from "../decision-tools.js"
import { setJevConfigLoader } from "../jev-client.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "decision", "review-router.md")

const reviewPolicy = () => {
  const parsed = parseDecisionPolicy(readFileSync(FIXTURE, "utf8"))
  if (!parsed.ok) throw new Error(`fixture policy invalid: ${parsed.errors.join("; ")}`)
  return parsed.policy
}

const ok = (choice: string, probabilities: Record<string, number>, extra: Partial<Extract<ClassifierOutcome, { ok: true }>> = {}): ClassifierOutcome => ({
  ok: true,
  choice,
  probabilities,
  ...extra,
})

const fail = (error: string): ClassifierOutcome => ({ ok: false, error })

afterEach(() => {
  clearDecisionCache()
  setJevConfigLoader(async () => ({}))
  setMcpCredentialDeps({})
})

describe("parseDecisionPolicy", () => {
  it("parses the review-router fixture: closed choices, floors, bounds", () => {
    const p = reviewPolicy()
    expect(p.choices).toEqual(["light", "standard", "deep"])
    expect(p.defaultChoice).toBe("deep")
    expect(p.classifier).toMatchObject({ kind: "jev", minProbability: 0.85, minMargin: 0.2 })
    expect(p.evidence).toMatchObject({
      allowPaths: false,
      allowCode: false,
      allowMessages: false,
      requireCompleteForClassifier: true,
    })
    expect(p.rules.find(r => r.id === "hard-risk")?.floor).toBe(true)
    expect(p.body).toContain("Review router policy")
  })

  it("rejects a rule choosing an undeclared choice, and a default outside choices", () => {
    const bad1 = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: b\ncriteria: {a: "A", b: "B"}\nrules:\n  - id: r\n    when: {field: x, eq: 1}\n    choose: c\n---\n`)
    expect(bad1.ok).toBe(false)
    if (bad1.ok) throw new Error("expected failure")
    expect(bad1.errors.join(" ")).toContain(`chooses "c"`)

    const bad2 = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: z\ncriteria: {a: "A", b: "B"}\n---\n`)
    expect(bad2.ok).toBe(false)
  })

  it("rejects missing criteria, duplicate rule ids, and a wrong schema version", () => {
    const noCriteria = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: b\ncriteria: {a: "only a"}\n---\n`)
    expect(noCriteria.ok).toBe(false)

    const dup = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: b\ncriteria: {a: "A", b: "B"}\nrules:\n  - {id: r, when: {field: x, eq: 1}, choose: a}\n  - {id: r, when: {field: x, eq: 2}, choose: b}\n---\n`)
    expect(dup.ok).toBe(false)
    if (dup.ok) throw new Error("expected failure")
    expect(dup.errors.join(" ")).toContain("duplicate rule id")

    const wrongSchema = parseDecisionPolicy(`---\nschema: 2\nchoices: [a, b]\ndefault: b\ncriteria: {a: "A", b: "B"}\n---\n`)
    expect(wrongSchema.ok).toBe(false)
  })
})

describe("evaluateWhen", () => {
  const ev = { n: 3, s: "abc", flag: true, list: ["x", "y"], nested: { k: 1 } }

  it("evaluates leaf comparisons; a missing field never matches", () => {
    expect(evaluateWhen({ field: "n", eq: 3 }, ev)).toBe(true)
    expect(evaluateWhen({ field: "n", gte: 3 }, ev)).toBe(true)
    expect(evaluateWhen({ field: "n", gte: 4 }, ev)).toBe(false)
    expect(evaluateWhen({ field: "s", contains: "bc" }, ev)).toBe(true)
    expect(evaluateWhen({ field: "list", contains: "y" }, ev)).toBe(true)
    expect(evaluateWhen({ field: "flag", eq: true }, ev)).toBe(true)
    expect(evaluateWhen({ field: "nested.k", eq: 1 }, ev)).toBe(true)
    expect(evaluateWhen({ field: "nope", eq: 1 }, ev)).toBe(false)
    expect(evaluateWhen({ field: "nope", neq: 1 }, ev)).toBe(false)
  })

  it("evaluates allOf / anyOf / not", () => {
    expect(evaluateWhen({ allOf: [{ field: "n", gte: 2 }, { field: "flag", eq: true }] }, ev)).toBe(true)
    expect(evaluateWhen({ allOf: [{ field: "n", gte: 5 }, { field: "flag", eq: true }] }, ev)).toBe(false)
    expect(evaluateWhen({ anyOf: [{ field: "n", eq: 9 }, { field: "s", eq: "abc" }] }, ev)).toBe(true)
    expect(evaluateWhen({ not: { field: "n", eq: 9 } }, ev)).toBe(true)
  })
})

describe("decide — rules first, floors, no model calls when rule-certain", () => {
  it("docs-only resolves light with ZERO classifier calls", async () => {
    const classify = vi.fn(async () => ok("deep", { light: 0.1, standard: 0.2, deep: 0.7 }))
    const out = await decide(reviewPolicy(), { changeTypes: "docs-only", riskCategories: [], signals: [] }, { classify })
    expect(out.choice).toBe("light")
    expect(out.source).toBe("rule")
    expect(out.matchedRules).toContain("docs-only")
    expect(classify).not.toHaveBeenCalled()
  })

  it("the hard-risk FLOOR pins deep with zero model calls, even without other evidence", async () => {
    const classify = vi.fn(async () => ok("light", { light: 0.95, standard: 0.04, deep: 0.01 }))
    const out = await decide(reviewPolicy(), { riskCategories: ["security"] }, { classify })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("rule-floor")
    expect(out.matchedRules).toContain("hard-risk")
    expect(classify).not.toHaveBeenCalled()
  })

  it("a resolve rule below a matched floor is raised to the floor", async () => {
    // A policy where a floor matches and a later resolve picks weaker.
    const parsed = parseDecisionPolicy(`---\nschema: 1\nchoices: [low, high]\ndefault: high\ncriteria: {low: "L", high: "H"}\nrules:\n  - id: floor\n    when: {field: risky, eq: true}\n    choose: high\n    floor: true\n  - id: weak\n    when: {field: anything, eq: true}\n    choose: low\n---\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const out = await decide(parsed.policy, { risky: true, anything: true }, {})
    expect(out.choice).toBe("high")
    expect(out.source).toBe("rule-floor")
    expect(out.clampedToFloor).toBe(true)
  })
})

describe("decide — one classifier call, thresholds, closed set", () => {
  it("accepts a confident in-set classifier choice with margin", async () => {
    const classify = vi.fn(async () => ok("standard", { light: 0.02, standard: 0.9, deep: 0.08 }, { model: "jev-test" }))
    const out = await decide(reviewPolicy(), { changeTypes: "code", riskCategories: [], signals: [], complete: true }, { classify })
    expect(out.choice).toBe("standard")
    expect(out.source).toBe("classifier")
    expect(out.probabilities).toEqual({ light: 0.02, standard: 0.9, deep: 0.08 })
    expect(out.confidence).toBeCloseTo(0.9)
    expect(out.margin).toBeCloseTo(0.82)
    expect(out.classifierModel).toBe("jev-test")
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it("rejects an undeclared classifier choice — falls through to the default", async () => {
    const escalate = vi.fn(async (): Promise<EscalationOutcome> => ({ ok: false, error: "off" }))
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true }, { classify: async () => ok("ultralight", { ultralight: 0.99 }), escalate })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.escalationHistory[0]).toMatchObject({ stage: "classifier", ok: false })
  })

  it("missing usable probability is uncertainty, not certainty", async () => {
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true }, {
      classify: async () => ({ ok: true, choice: "standard", probabilities: {} }),
    })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.reason).toContain("no usable probability")
  })

  it("a low margin goes to ONE escalation; a valid escalated choice wins", async () => {
    const escalate = vi.fn(async (input: { packet: string }): Promise<EscalationOutcome> => {
      expect(input.packet).toContain("standard") // classifier suggestion carried
      return { ok: true, choice: "standard", evidenceRefs: ["escalation-note"] }
    })
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true, evidenceRefs: ["base-ref"] }, {
      classify: async () => ok("standard", { light: 0.5, standard: 0.55, deep: 0.45 }), // margin 0.10 < 0.20
      escalate,
    })
    expect(out.choice).toBe("standard")
    expect(out.source).toBe("escalation")
    expect(out.escalations).toBe(1)
    expect(out.escalationHistory.map(e => e.stage)).toEqual(["classifier", "escalation"])
    expect(out.evidenceRefs).toEqual(["base-ref", "escalation-note"])
    expect(escalate).toHaveBeenCalledTimes(1)
  })

  it("classifier failure records the failure and reaches the default — never an approval", async () => {
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true }, {
      classify: async () => fail("401 unauthorized"),
    })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.reason).toContain("classifier failed")
    expect(out.escalationHistory[0]).toMatchObject({ stage: "classifier", ok: false, error: "401 unauthorized" })
  })

  it("a thrown classifier is caught and treated as failure", async () => {
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true }, {
      classify: async () => {
        throw new Error("boom")
      },
    })
    expect(out.source).toBe("default")
    expect(out.reason).toContain("boom")
  })

  it("incomplete evidence blocks classifier acceptance (requireCompleteForClassifier)", async () => {
    const escalate = vi.fn(async (): Promise<EscalationOutcome> => ({ ok: false, error: "no escalation backend" }))
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: false }, {
      classify: async () => ok("light", { light: 0.97, standard: 0.02, deep: 0.01 }),
      escalate,
    })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.incompleteEvidence).toBe(true)
    expect(out.reason).toContain("evidence incomplete")
  })

  it("the conservative default never settles below a matched floor", async () => {
    const parsed = parseDecisionPolicy(`---\nschema: 1\nchoices: [low, mid, high]\ndefault: mid\ncriteria: {low: "L", mid: "M", high: "H"}\nclassifier: {kind: none}\nrules:\n  - id: floor\n    when: {field: risky, eq: true}\n    choose: high\n    floor: true\n---\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const out = await decide(parsed.policy, { risky: true }, {})
    // floor pins strongest → resolved with no model call
    expect(out.choice).toBe("high")
    expect(out.source).toBe("rule-floor")
  })
})

describe("decide — evidence export policy", () => {
  it("default export strips paths/code/messages and marks omissions", () => {
    const p = reviewPolicy()
    const { state, omitted } = projectTier1Evidence(p, {
      changeCounts: { files: 3 },
      paths: ["src/a.ts"],
      code: "function x() {}",
      messages: ["hello"],
      transcript: "user: hi",
    })
    expect(state.changeCounts).toEqual({ files: 3 })
    expect(state.paths).toBeUndefined()
    expect(state.code).toBeUndefined()
    expect(state.messages).toBeUndefined()
    expect(state.transcript).toBeUndefined()
    expect(omitted).toEqual(expect.arrayContaining(["paths", "code", "messages", "transcript"]))
    expect(state.__omitted__).toEqual(omitted)
  })

  it("tier1Fields allowlist exports only named fields", () => {
    const p = reviewPolicy()
    const { state, omitted } = projectTier1Evidence(p, {
      changeCounts: 2,
      riskCategories: ["auth"],
      signals: ["hardRisk"],
      completeness: 1,
      sneaky: "not in allowlist",
    })
    expect(Object.keys(state).sort()).toEqual(["__omitted__", "changeCounts", "completeness", "riskCategories", "signals"])
    expect(omitted).toContain("sneaky")
  })

  it("size ceiling drops fields and marks truncated — which blocks classifier acceptance", async () => {
    const parsed = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: b\ncriteria: {a: "A", b: "B"}\nevidence: {maxTier1Chars: 220}\n---\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const big = "x".repeat(500)
    const { truncated } = projectTier1Evidence(parsed.policy, { big, other: "y" })
    expect(truncated).toBe(true)
    const out = await decide(parsed.policy, { big, other: "y", complete: true }, {
      classify: async () => ok("a", { a: 0.99, b: 0.01 }),
    })
    expect(out.truncated).toBe(true)
    expect(out.choice).toBe("b")
    expect(out.source).toBe("default")
    expect(out.reason).toContain("truncated")
  })

  it("allowFlags export would be honored (policy-gated, not global)", () => {
    const parsed = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: b\ncriteria: {a: "A", b: "B"}\nevidence: {allowPaths: true}\n---\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const { state, omitted } = projectTier1Evidence(parsed.policy, { paths: ["src/a.ts"], code: "x" })
    expect(state.paths).toEqual(["src/a.ts"])
    expect(omitted).toContain("code")
    expect(omitted).not.toContain("paths")
  })

  it("escalation packets are capped at maxInputChars with an omission marker", () => {
    const p = reviewPolicy()
    const { packet, truncated } = buildEscalationPacket(p, { notes: "y".repeat(10_000) }, { uncertainty: "low margin" })
    expect(truncated).toBe(true)
    expect(packet.length).toBeLessThanOrEqual(p.escalation.maxInputChars + 60)
    expect(packet).toContain("[omitted: escalation packet truncated]")
    expect(packet).toContain("low margin")
  })
})

describe("decide — escalation bounds", () => {
  it("an escalation returning an undeclared choice falls to the default", async () => {
    const escalate = vi.fn(async (): Promise<EscalationOutcome> => ({ ok: true, choice: "nope" }))
    const out = await decide(reviewPolicy(), { changeTypes: "code", complete: true }, {
      classify: async () => fail("down"),
      escalate,
    })
    expect(out.choice).toBe("deep")
    expect(out.source).toBe("default")
    expect(out.escalationHistory.at(-1)).toMatchObject({ stage: "escalation", ok: false })
  })

  it("escalation disabled by policy means exactly zero escalation calls", async () => {
    const parsed = parseDecisionPolicy(`---\nschema: 1\nchoices: [a, b]\ndefault: a\ncriteria: {a: "A", b: "B"}\nclassifier: {kind: none}\nescalation: {enabled: false}\n---\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const escalate = vi.fn(async (): Promise<EscalationOutcome> => ({ ok: true, choice: "b" }))
    const out = await decide(parsed.policy, {}, { escalate })
    expect(out.choice).toBe("a")
    expect(out.source).toBe("default")
    expect(escalate).not.toHaveBeenCalled()
  })
})

describe("decide — cache and concurrent sharing", () => {
  it("identical policy+evidence+config decisions are computed once and served cached", async () => {
    const classify = vi.fn(async () => ok("standard", { light: 0.05, standard: 0.9, deep: 0.05 }))
    const ev = { changeTypes: "code", complete: true }
    const a = await decide(reviewPolicy(), ev, { classify })
    const b = await decide(reviewPolicy(), ev, { classify })
    expect(classify).toHaveBeenCalledTimes(1)
    expect(a.cached).toBeUndefined()
    expect(b.cached).toBe(true)
    expect(b.choice).toBe(a.choice)
  })

  it("concurrent identical decisions share one computation", async () => {
    let release!: (v: ClassifierOutcome) => void
    const classify = vi.fn(
      () => new Promise<ClassifierOutcome>(r => {
        release = r
      }),
    )
    const ev = { changeTypes: "code", complete: true }
    const p1 = decide(reviewPolicy(), ev, { classify })
    const p2 = decide(reviewPolicy(), ev, { classify })
    await new Promise(r => setTimeout(r, 10))
    release(ok("standard", { light: 0.05, standard: 0.9, deep: 0.05 }))
    const [a, b] = await Promise.all([p1, p2])
    expect(classify).toHaveBeenCalledTimes(1)
    expect(a.shared || b.shared).toBe(true)
    expect(a.choice).toBe("standard")
    expect(b.choice).toBe("standard")
  })

  it("changed criteria change the policy hash; changed evidence changes the evidence hash", () => {
    const p1 = reviewPolicy()
    const parsed2 = parseDecisionPolicy(
      readFileSync(FIXTURE, "utf8").replace("minProbability: 0.85", "minProbability: 0.9"),
    )
    expect(parsed2.ok).toBe(true)
    if (!parsed2.ok) return
    expect(decisionPolicyHash(p1)).not.toBe(decisionPolicyHash(parsed2.policy))
    // Same policy text → same hash
    expect(decisionPolicyHash(p1)).toBe(decisionPolicyHash(reviewPolicy()))
  })
})

describe("makeJevDecisionClassifier", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  it("adapts a Jev choice answer (out-of-range probabilities dropped, confidence fallback)", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ model: "jev-latest", answers: { decision: { type: "choice", choice: "standard", probabilities: { standard: 0.9, light: -1 } } } }),
    )
    const classify = makeJevDecisionClassifier({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })
    const out = await classify({ state: { x: 1 }, question: { instructions: "pick", criteria: { standard: "s" } } })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.choice).toBe("standard")
    expect(out.probabilities).toEqual({ standard: 0.9 }) // out-of-range dropped
    expect(out.confidence).toBe(0.9)
    expect(out.model).toBe("jev-latest")
  })

  it("no key → ok:false without a network call; missing answer → ok:false", async () => {
    const fetchImpl = vi.fn(async () => json({ answers: {} }))
    const noKey = makeJevDecisionClassifier({ apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch })
    const out = await noKey({ state: {}, question: { instructions: "i", criteria: { a: "a" } } })
    expect(out).toEqual({ ok: false, error: "JEV_API_KEY not configured" })
    expect(fetchImpl).not.toHaveBeenCalled()

    const withKey = makeJevDecisionClassifier({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })
    const out2 = await withKey({ state: {}, question: { instructions: "i", criteria: { a: "a" } } })
    expect(out2.ok).toBe(false)
  })

  it("end-to-end: decide() through the Jev adapter answers from an injected fetch", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ answers: { decision: { type: "choice", choice: "standard", confidence: 0.92, probabilities: { standard: 0.92, light: 0.05, deep: 0.03 } } } }),
    )
    const out = await decide(reviewPolicy(), { changeTypes: "code", riskCategories: [], signals: [], complete: true }, {
      classify: makeJevDecisionClassifier({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }),
    })
    expect(out.choice).toBe("standard")
    expect(out.source).toBe("classifier")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
