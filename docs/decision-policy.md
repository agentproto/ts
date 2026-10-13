# DECISION.md — typed decision routing

Status: shipped primitive (`@agentproto/runtime`); review/studio wiring is
tracked separately (see `docs/studio-decision-router-integration.md`).

`decide(policy, evidence)` is a reusable, closed-set decision primitive: one
validated choice out of a declared set, resolved rules-first with one
optional bounded classifier call, at most one tool-less LLM escalation, and
a conservative default. It exists so cost-sensitive workflows (review
routing, steward classify, …) can share ONE router without sharing
domain-specific rules: each consumer owns its evidence builder and its
choice → action mapping.

## Policy artifact: `DECISION.md`

Markdown + YAML frontmatter. The frontmatter is machine-read; the body holds
human criteria and examples.

```yaml
---
schema: 1
name: review-router
version: 1                       # optional; folded into the cache key
choices: [light, standard, deep] # closed set, ordered weakest → strongest
default: deep                    # conservative fallback; must be a choice
criteria:                        # choice → meaning (also Jev question criteria)
  light: "Docs/lockfiles only…"
  standard: "Ordinary code change…"
  deep: "Hard-risk or ambiguous…"
classifier:
  kind: jev                      # jev | none
  instructions: "…"              # optional
  minProbability: 0.85           # accept threshold (proposed, not calibrated)
  minMargin: 0.20                # top-two margin over allowed choices
escalation:
  enabled: true                  # exactly ONE tool-less LLM escalation, ever
  limit: 1
  maxInputChars: 6000            # tier-2 packet ceiling
evidence:
  tier1Fields: [changeCounts, riskCategories, signals, completeness]
  allowPaths: false              # defaults are closed: no paths/code/messages
  allowCode: false
  allowMessages: false
  maxTier1Chars: 2048            # classifier state ceiling
  requireCompleteForClassifier: true
rules:
  - id: hard-risk
    when: { anyOf: [ {field: riskCategories, contains: security}, … ] }
    choose: deep
    floor: true                  # mandatory minimum — never downgraded
  - id: docs-only
    when: { allOf: [ {field: changeTypes, eq: docs-only}, … ] }
    choose: light                # resolve: first match wins, zero model calls
---
```

Rule `when` conditions support `allOf` / `anyOf` / `not` and leaves
`{field, eq|neq|gte|lte|contains}` (dot paths; a missing field never matches
a positive comparison). Two rule kinds:

- **resolve** (default): first matching rule decides outright — zero model
  calls. `docs-only → light`.
- **floor**: sets a mandatory minimum. No classifier, escalation or default
  may settle below it; a floor already pinning the strongest choice also
  resolves with zero model calls. `hard-risk → deep`.

## Resolution sequence

1. Ordered rules. Floors collected; first resolve wins; a resolve below a
   matched floor is raised (source `rule-floor`).
2. One bounded typed-choice classifier call (the existing generic Jev
   client, `callJevSystemOne`) for the ambiguous remainder. A choice is
   accepted only inside the closed set, with finite probabilities in range,
   at/above `minProbability` with `minMargin` — and only when evidence is
   complete (not truncated, not flagged incomplete). Missing/invalid
   probabilities are uncertainty, not certainty.
3. On uncertainty or classifier failure: exactly ONE tool-less LLM
   escalation with a richer bounded packet (context first, evidence last;
   omissions marked). Its choice is closed-set validated; its self-reported
   confidence is NOT calibrated and is never threshold-checked.
4. The policy default (raised to any matched floor). Classifier or
   escalation failure is recorded in `escalationHistory` — it is never
   treated as approval.

The outcome carries: `choice`, `source` (`rule | rule-floor | classifier |
escalation | default`), `reason`, `matchedRules`, `probabilities` /
`confidence` / `margin` when available, `escalationHistory`,
`evidenceRefs`, `truncated`, `incompleteEvidence`, and the
`policyHash` / `evidenceHash` / `classifierConfigHash` provenance triple.
Only declared choices can appear.

## Evidence/export policy

Defaults export no code, paths or messages to the classifier: the tier-1
state is the `tier1Fields` allowlist (or a deny-filtered projection),
string-capped, then size-ceiled (`maxTier1Chars`) by dropping whole fields
with `__omitted__` markers. Truncation counts as incomplete evidence and
blocks classifier acceptance when `requireCompleteForClassifier` is on.
Tier-2 escalation packets honor the same allow/deny flags and
`escalation.maxInputChars`.

## Cache and concurrency

Decisions are cached under policy hash + evidence hash + classifier
configuration (and which backends were wired); changing criteria, thresholds
or evidence invalidates. Concurrent identical `decide()` calls share one
in-flight computation. The decision cache is separate from the review
verdict/ledger cache and never replaces it.

## Surfaces

- `decide` / `parseDecisionPolicy` / types — exported from
  `@agentproto/runtime` (see `packages/runtime/src/decision.ts`,
  `decision-policy.ts`).
- `decision_decide` MCP tool (root `/mcp`, like `model_roles`): pass the
  DECISION.md markdown plus the evidence object; the tool wires the Jev
  classifier through the existing `jev.apiKey` / `jev.baseUrl` config. No
  escalation backend is wired at the tool layer — embedding hosts inject
  their own no-tool escalation into `decide()` when configured.
- Canonical review-routing example:
  `packages/runtime/src/__tests__/fixtures/decision/review-router.md`.

## Caveats

- The 0.85 / 0.20 thresholds are proposed policy defaults, not validated
  calibration.
- LLM escalation confidence is not calibrated and is not used for
  acceptance.
- A real blocking finding is never a trigger to try another model.
