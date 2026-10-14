---
schema: 1
name: review-router
version: 1
choices: [light, standard, deep]
default: deep
criteria:
  light: >-
    Docs, images, lockfiles and other non-code artifacts only — no hard-risk
    path and no substantive code to verify. A claims/consistency pass is
    enough.
  standard: >-
    Ordinary code change without hard-risk paths. One combined
    correctness-plus-claims reviewer: verify changed code, relevant callers,
    commit claims and changed documentation.
  deep: >-
    Hard-risk paths (auth, security, migrations, SQL, workflows, env) or
    ambiguous risk signals. One stronger subscription reviewer, correctness
    plus claims, prioritizing the risk signals.
classifier:
  kind: jev
  instructions: >-
    Route ONE code-review change to the cheapest adequate review binding.
    Hard-risk evidence forces deep; docs-only evidence selects light. When
    the evidence is thin or ambiguous, choose deep — broader review is
    cheaper than missing a hard-risk regression.
  minProbability: 0.85
  minMargin: 0.20
escalation:
  enabled: true
  limit: 1
  maxInputChars: 6000
evidence:
  tier1Fields:
    - changeCounts
    - changeTypes
    - riskCategories
    - signals
    - completeness
  allowPaths: false
  allowCode: false
  allowMessages: false
  maxTier1Chars: 2048
  requireCompleteForClassifier: true
rules:
  - id: hard-risk
    when:
      anyOf:
        - field: riskCategories
          contains: security
        - field: riskCategories
          contains: auth
        - field: riskCategories
          contains: migration
        - field: riskCategories
          contains: workflow
        - field: signals
          contains: hardRisk
    choose: deep
    floor: true
    note: Mandatory floor — no classifier may downgrade hard-risk coverage.
  - id: docs-only
    when:
      allOf:
        - field: changeTypes
          eq: docs-only
        - not:
            field: riskCategories
            contains: security
    choose: light
    note: Provably docs-only ranges select light with zero model calls.
---

# Review router policy

Cost-efficient default review routing (plan: "Cost-efficient review
workflow"). Closed choices map to review bindings:

| choice | binding |
| --- | --- |
| `light` | claims / free model |
| `standard` | combined correctness+claims / free model |
| `deep` | combined correctness+claims / stronger subscription model |

Rules run first and are deterministic. `hard-risk` is a floor: it pins
`deep` and no classifier or default may settle below it. Ambiguous ranges
get at most one Jev typed-choice call; low confidence, a small margin,
incomplete/truncated evidence or a classifier failure allow one bounded
harness escalation (read-only posture); anything still unresolved takes the conservative default
(`deep`). A blocking finding stops the flow — it never triggers another
model to obtain approval.

## Examples

- Lockfile + README edit, no risk categories → rule `docs-only` → `light`,
  zero model calls.
- Touch on `packages/auth/**` → rule `hard-risk` (floor) → `deep`, zero
  model calls.
- Ordinary refactor with complete metadata → classifier, accepted at
  ≥0.85 probability and ≥0.20 margin → `standard`.
- Same refactor, classifier says `light` at 0.61 → uncertainty → one
  escalation; still unresolved → default `deep`.
