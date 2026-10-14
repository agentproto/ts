# Studio review client ↔ decision-route workflow

**Status: contract verified, not activated.** Checked read-only against the
merged studio change (agentik-studio #684, "one reviewer per range and an
explicit free-only profile"): `scripts/gate.mjs`, `REVIEW.md`,
`scripts/review/router-jev.mjs`. Nothing here edits studio, changes operator
config, restarts a daemon or turns semantic routing on. The studio gate keeps
its deterministic router as the only enforcing path.

## The contract (what #684 established)

| Studio (merged) | decision-route |
| --- | --- |
| Exactly ONE review binding per range: `light`, `local`, `deep`, `deep-free` | choice → binding map (`bindings` input); a binding names checks, a check names a preset — never a model id |
| Router decisions `skip` / `standard` / `deep` | `bindings` default `{skip: light, light: light, standard: local, deep: deep}` accepts both vocabularies |
| `GATE_EXEC_PROFILE=subscription` (default) | `profile: remote-sonnet` — free OpenCode ids + the configured Claude Code Sonnet |
| `GATE_EXEC_PROFILE=free-only`; `deep` → `deep-free`; gate refuses if any selectable lane, fallback or `review.recovery` preset is not a free OpenCode preset | `profile: local-free`; `freeBindings: {deep: deep-free}`; the workflow checks the same set (primaries, fallbacks, recovery preset + role override, rotate targets, OpenRouter) **before spawn** and refuses — no Sonnet substitute |
| `GATE_DEEP=auto\|always\|never` | stays in the studio client (a policy override); not read by the workflow |
| `GATE_JEV=on`: Jev is **shadow only**, metadata only, logged to `.logs/gate/router/shadow.jsonl`, never affects the verdict | `mode: shadow` (default): the whole decision runs, no review lane starts, report state `shadow` |

One binding, one profile variable: the studio client maps its single
`GATE_EXEC_PROFILE` to the workflow `profile` and nothing else
(`profileFor()` in the example client below). The workflow never reads
studio config; the profile can only narrow, never widen, what the daemon's
presets allow.

Two intentional differences to know about:

- The workflow's *default* profile is `local-free` (fail-safe); studio's
  default is `subscription`. The client always passes the profile explicitly.
- Under `local-free` the operator must name the escalation target
  (`profileOptions.escalation.preset` → an OpenCode `-free` preset). With no
  target the escalation is recorded `refused` and the conservative default
  applies; nothing paid is substituted.

## Exact invocation

```sh
agentproto workflow run-file \
  packages/runtime/workflows/decision-route/WORKFLOW.md \
  --cwd /path/to/repo \
  --input-json '{"cwd":"/path/to/repo","policyPath":"DECISION.md","profile":"local-free","mode":"shadow","profileOptions":{"escalation":{"preset":"my-opencode-free"}}}'
agentproto workflow status <runId>
```

(`<pkg>/workflows/decision-route/WORKFLOW.md` in an installed
`@agentproto/runtime`; MCP equivalent: `workflow_run_file`.) The `validate`
step output is the report: `state`, `approved`, `choice`, `decisionSource`,
`decisionStatus`, `binding`, `fallbackCount`, `recoveryCount`, `escalation`
(attempt, adapter, model, wait reason, configured-vs-enforced tool controls),
and `trace` with workflow / run id / step / parent session / profile.

Executable shadow client: `workflows/decision-route/examples/shadow-client.mjs`
(runs the CLI above, waits bounded, appends one line to a shadow log;
failures are non-fatal and never exit non-zero).

## Studio follow-up seam (separate PR in the studio repo — NOT done here)

Smallest change, shadow by default, beside the existing `shadowRange()`
(`scripts/gate.mjs`, the Jev shadow):

1. Add `scripts/review/DECISION.md` — start from `examples/DECISION.md`.
   Align its `riskCategories` / `signals` names with what `router.mjs`
   emits (`categories`, `signals`) so the hard-risk floor fires on the same
   evidence. Choices `skip|standard|deep` or `light|standard|deep` both map.
2. Add a gated sibling of `shadowRange`, e.g. `GATE_DECISION_ROUTE=shadow`
   (default off), that calls `shadow-client.mjs` with
   `GATE_EXEC_PROFILE`, appending to
   `.logs/gate/router/decision-route-shadow.jsonl`. Pass the router's
   metadata via `buildEvidence(files, ruleResult)`; the router's own
   *decision* is deliberately not part of the evidence.
3. Compare `report.choice` with the deterministic router per range for a
   while. Only after agreement is established — and only by an operator —
   switch `bindingsFor()` to take the workflow's `binding` for an
   `approved`-capable state. Until then the verdict path is untouched.
4. Keep the studio free-only guard (`checkProfilePresets`): it is the
   client-side early exit; the workflow's preflight is the daemon-side check.

## Remaining activation steps (operator-owned, none performed)

1. Ship/upgrade `@agentproto/runtime` to a daemon that registers the
   `decision_*` tools (the daemon restart is the operator's call).
2. Define presets: an OpenCode `-free` escalation preset; reviewer presets
   referenced by REVIEW.md (`opencode-free-review`, `claude-sonnet-review` in
   the example).
3. Enable Jev only where intended (`remote-sonnet` + `jev.apiKey`); metadata
   only leaves the machine.
4. Land the studio seam above in shadow, review the log, then decide.
