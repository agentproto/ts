# Studio decision-router integration — DESIGN ARTIFACT (not implemented here)

**Status: design only.** The studio repository is a separate clone and was
NOT present in the checkout that shipped the agentproto decision primitive
(`packages/runtime/src/decision*.ts`, `decision_decide` tool,
`docs/decision-policy.md`). Nothing in this file has been applied or tested
against studio; treat it as the concrete integration patch to run in a
studio checkout next. Do not read it as "studio wiring is done".

Goal (from the accepted plan, step 0 + 1): studio's review gate routes each
run through the shared `decide()` primitive with a `DECISION.md` policy
(choices `light | standard | deep`), replacing the review-specific selection
in `scripts/review/router.mjs`, while `REVIEW.md` bindings drop from four
default substantive reviews to exactly one per binding.

## Expected files (studio repo)

| File | Change |
| --- | --- |
| `scripts/review/DECISION.md` | NEW — the review routing policy (below). |
| `scripts/review/router.mjs` | Keep deterministic skip logic; delegate standard-vs-deep (and light) to `decision_decide` / `decide()` with evidence built from the existing router inputs. |
| `scripts/review/router.config.json` | Map choices → bindings; single reviewer + one fallback preset each; keep the free-model guard + subscription exception. |
| `scripts/gate.mjs` | `bindingsFor` returns exactly ONE default binding (light / local / deep); `GATE_DEEP=always\|never` preserved; optional sequential second-opinion mode off by default; never re-review after block/incomplete. |
| `scripts/gate.test.mjs`, router tests | Spawn-count assertions: ordinary → 1 substantive reviewer; docs-only → claims only; hard-risk → deep only (no preliminary standard); block → no second attempt. |
| `scripts/review/rubrics/*` | Combined correctness+claims rubric built from the existing two; deterministic checks stay in command lanes, run once. |
| `REVIEW.md` | `local` = deterministic checks + one combined free reviewer; `light` = gate tests + one claims reviewer; `deep` = deterministic checks + one combined subscription reviewer. |
| `scripts/review/router-jev.mjs` | Shadow-mode comparison only during rollout; enforcement switches to the shared primitive; retire the parallel path once fixtures agree. |

## Policy mapping

| Studio concept | DECISION.md |
| --- | --- |
| skip | rule (docs-only / no-op evidence) → `light` or a skip rule resolved before the router |
| standard reviewer (free, combined) | choice `standard` |
| deep reviewer (subscription) | choice `deep` |
| claims-only binding | choice `light` |
| hard-risk paths | `floor: true` rule → `deep` (never downgraded) |
| provably docs-only range | resolve rule → `light`, zero model calls |
| ambiguous ordinary change | classifier + thresholds; escalation once; default `deep` |

Evidence builder (studio-owned): change counts/types, risk categories from
the existing router criteria, signal flags, completeness — no paths, code or
commit text by default (matches the primitive's closed export policy; the
studio policy sets `tier1Fields` explicitly).

## Sketch: router.mjs delegation (unapplied)

```js
// pseudocode — validate against the real router.mjs shape in the studio tree
import { parseDecisionPolicy, decide } from "@agentproto/runtime" // or decision_decide tool step

const policy = parseDecisionPolicy(await readFile(new URL("./DECISION.md", import.meta.url), "utf8"))
if (!policy.ok) throw new Error(`DECISION.md invalid: ${policy.policy ?? policy.errors.join("; ")}`)

const evidence = {
  changeCounts: summary.counts,
  changeTypes: summary.types,          // e.g. "docs-only" | "code"
  riskCategories: summary.riskCategories,
  signals: summary.signals,            // e.g. ["hardRisk"]
  completeness: summary.complete ? 1 : 0,
  evidenceRefs: summary.refs,
}
const decision = await decide(policy.policy, evidence, { /* Jev classifier via existing router-jev adapter; escalate: small-model no-tool call when GATE_JEV escalation configured */ })
// decision.choice: "light" | "standard" | "deep" → pick the single binding; log decision.source + policyHash in the report
```

## Rollout order (per the accepted plan)

1. Land this primitive in agentproto (done in that repo's PR).
2. Studio: add `DECISION.md` + tests with fixtures replayed in SHADOW mode
   (`router-jev.mjs`-style comparison): assert the router's choice matches
   the previous deterministic router on ordinary, docs-only and hard-risk
   fixtures before enforcement.
3. Switch `bindingsFor` to one binding per run; keep `GATE_DEEP` semantics;
   add the opt-in sequential second opinion (off by default; not after
   block/incomplete).
4. Only then enforce decision-backed routing; retire the shadow path.

Budget note: whole-workflow attempt/deadline ceilings (plan step 3) are
runtime work and are NOT part of this artifact — do not claim token caps
active until that runtime support ships.
