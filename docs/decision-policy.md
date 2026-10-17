# DECISION.md — typed decision routing

Status: shipped primitive (`@agentproto/runtime`); review/studio wiring is
tracked separately (see `docs/studio-decision-router-integration.md`).

`decide(policy, evidence)` is a reusable, closed-set decision primitive: one
validated choice out of a declared set, resolved rules-first with one
optional bounded classifier call, at most one bounded escalation, and
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
  enabled: true                  # exactly ONE bounded escalation, ever
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
3. On uncertainty or classifier failure: exactly ONE bounded
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

## Decision vs action authorization

A classifier answers a semantic question; it does not authorize a mutation.
Consumers must apply a deterministic authorization policy after the typed
choice and before acting. For session maintenance, Jev may classify an idle
session as `done`, but closing it is allowed only when immutable provenance
identifies a machine-owned root (`origin`) or an executor
(`parentSessionId`). A label, cwd, model name, or workspace slug is display or
context evidence, never ownership authority.

Provenance must therefore be stamped by the producer at spawn time. Missing
`origin` on a root means incomplete authorization evidence, not “human” and
not “machine”: the safe action is to flag/keep it and surface the provenance
gap. The session steward follows this contract. Pygmalion roots use
`pygmalion` / `pygmalion:*`; installed app service owners use
`app-service:*`; workflow, review, routine, cron and bench producers keep their
existing explicit origins. Legacy origin-less roots are not retroactively
inferred from labels.

This separation also explains why a confident classifier result may produce
no close: confidence gates the verdict, while provenance independently gates
the side effect. Both must pass.

## Evidence/export policy

Defaults export no code, paths or messages to the classifier: the tier-1
state is the `tier1Fields` allowlist (or a deny-filtered projection),
string-capped, then size-ceiled (`maxTier1Chars`) by dropping whole fields
with `__omitted__` markers. Truncation counts as incomplete evidence and
blocks classifier acceptance when `requireCompleteForClassifier` is on.
Tier-2 escalation packets honor the same allow/deny flags and
`escalation.maxInputChars`.

## Cache and concurrency

Only `status: decided` outcomes are cached (24h TTL, 500-entry cap). A
`fallback` (the conservative default applied after a classifier/escalation
failure, incomplete evidence or no backend) is a safe answer, not a trusted
one, and is recomputed on the next call. A `classify`/`escalate` backend
without an identity is uncacheable. Entries key on policy hash + evidence
hash + classifier configuration + backend identity (kind/host/model), so a
config or backend change never replays another backend's answer. Concurrent identical `decide()` calls share one
in-flight computation. The decision cache is separate from the review
verdict/ledger cache and never replaces it.

## Surfaces

- `decide` / `parseDecisionPolicy` / types — exported from
  `@agentproto/runtime` (see `packages/runtime/src/decision.ts`,
  `decision-policy.ts`).
- `decision_decide` MCP tool (root `/mcp`, like `model_roles`): pass the
  DECISION.md markdown plus the evidence object; the tool wires the Jev
  classifier through the existing `jev.apiKey` / `jev.baseUrl` config. No
  escalation backend is wired here — use the staged workflow below.
- `decision-route` workflow (`packages/runtime/workflows/decision-route`) and
  its seven `decision_*` stage tools: the operational harness (below).
- Canonical review-routing example:
  `packages/runtime/src/__tests__/fixtures/decision/review-router.md`.

## Staged workflow: `decision-route`

`workflows/decision-route/WORKFLOW.md` (shipped in `@agentproto/runtime`)
runs the primitive as seven `tool` steps owned by one workflow run:
`collect → rules → classify → escalate → select → review → validate`. Run it
with the existing run-file seam; shadow is the default (nothing is reviewed):

```jsonc
// MCP workflow_run_file on the daemon
{ "path": "<pkg>/workflows/decision-route/WORKFLOW.md",
  "cwd": "/path/to/repo",
  "input": { "cwd": "/path/to/repo", "policyPath": "DECISION.md",
             "profile": "local-free", "mode": "shadow",
             "profileOptions": { "escalation": { "preset": "my-opencode-free" } } } }
```

Poll `workflow_status`; the `validate` step output is the report. Design:

- **Policy vs profile.** DECISION.md owns criteria / closed choices /
  uncertainty. The execution *profile* owns permitted models/harnesses, the
  escalation target, attempts and deadlines — it never changes the policy.
  `local-free` (alias `free-only`): OpenCode ids ending `-free` (or
  `big-pickle`) only; Jev off; the operator names the escalation preset.
  `remote-sonnet` (alias `subscription`): free ids plus the configured Claude
  Code Sonnet; Jev on; escalation defaults to the `review.small` role.
- **Gated before spawn.** The escalation target and every reviewer preset,
  fallback preset, `turnRetry.rotate` target and the review-recovery preset /
  role override are resolved through the existing preset stores and checked
  against the profile *before* anything spawns. Unknown/dynamic identity (no
  explicit model, `@route`, unreadable auth profile, OpenRouter) fails
  closed; sandbox placement (E2B) grants nothing. A conservative `deep` route
  cannot bypass the profile: a refused target refuses the whole binding
  (nothing is substituted) and is reported as `refused`, never approved.
- **Bounded.** Jev: one call, no retries, profile deadline. Escalation: at
  most one session, own deadline, always killed/archived/cleaned. Review:
  deadline then `review_cancel`. No hidden retries, no fan-out; normal
  classifier uncertainty goes to the single escalation and is never a human
  request. Spawned sessions carry `workflowOwner` metadata (run id /
  workflow id / step id) and the parent session id.
- **Honest tool limits.** The escalation session is `read-only` posture with
  no MCP servers; the harness's built-in tools stay available, so the report
  lists `toolControls` as *configured* vs *enforced* and the prompt's "do not
  use tools" line is advisory. Nothing is called a no-tools guarantee.
- **Report states.** `completed` (approval only for a `pass` verdict from
  lanes inside the profile), `provider-unavailable`, `human-input-required`
  (only when the escalation session itself asked), `incomplete`, `timeout`,
  `cancelled`, `refused`, `failed`, `shadow`. Automatic continuation is not
  scheduled by this workflow, so that state is never emitted.
- **Evidence.** Metadata only (counts, change types, risk categories,
  completeness) from a frozen range; paths only with `allowPaths`; the
  collector never reads hunks or file contents (consumer-supplied evidence
  goes through the same deny filter); secrets scrubbed; any collection failure is `complete:
  false` so the classifier is not trusted.

## Caveats

- The 0.85 / 0.20 thresholds are proposed policy defaults, not validated
  calibration.
- LLM escalation confidence is not calibrated and is not used for
  acceptance.
- A real blocking finding is never a trigger to try another model.
