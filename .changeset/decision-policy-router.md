---
"@agentproto/runtime": minor
---

New typed decision router: `DECISION.md` policies (markdown + YAML
frontmatter) parse via `parseDecisionPolicy`, and `decide(policy, evidence)`
resolves one closed choice rules-first — ordered rules, mandatory `floor`
choices no classifier may downgrade (a floor pinning the strongest choice
makes zero model calls), then at most one bounded Jev typed-choice classifier
call through the existing generic client (`minProbability`/`minMargin`
thresholds; missing probabilities are uncertainty, not certainty), then
exactly one optional tool-less LLM escalation whose self-reported confidence
is never threshold-checked, then the conservative default. The default
evidence export policy sends no paths/code/messages; tier-1 state is
field-allowlisted, string-capped and size-ceiled with omission markers, and
truncated/incomplete evidence cannot be classifier-accepted. Outcomes carry
choice, source (`rule | rule-floor | classifier | escalation | default`),
matched rules, probability/margin data, escalation history, evidence refs
and policy/evidence/classifier-config hashes; decisions are cached and
concurrent identical calls share one computation. Surfaces: `decision_decide`
on the root `/mcp` server (Jev key/baseUrl from the existing `jev` config;
no escalation backend wired at the tool layer) plus package exports. Ships
the review-routing example policy, `docs/decision-policy.md`, and a labeled
studio integration design artifact (studio itself is not wired).
