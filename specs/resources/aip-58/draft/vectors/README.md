# vectors/ — AIP-58 conformance cases

Seven JSON fixtures, one per case named in `specs/aip-58.mdx`'s "Resources
to add" list. Each file carries a trimmed manifest excerpt, the `run.create`
input, and the expected terminal state + event sequence a conforming host
MUST produce. These are fixtures for a conformance-test harness to load,
not executable tests themselves — this AIP does not mandate a test runner.

| File | Case |
|---|---|
| `v1-invalid-input.json` | Required input missing → rejected / `failed invalid-input`, no step ran. |
| `v2-suspended-input-required.json` | Agent step invokes `run.requestInput` (the explicit signal) → step + run `suspended input-required`. |
| `v3-missing-artifact.json` | Agent turn ends, required artifact absent → `failed missing-artifact`. |
| `v4-host-restart.json` | Host restart mid-step → `failed host-interrupted`; a durably suspended run survives (both `kind: "approval"` and `kind: "suspend"`, per AIP-15 rule 7 as amended). |
| `v5-disjoint-workspaces.json` | Two concurrent runs of the same workflow → disjoint workspaces; neither writes the shared `outputsFiles` path before an explicit `run.publish`. |
| `v6-orphaned.json` | Run whose owner died → `failed orphaned`. |
| `v7-replay.json` | Replay from step 3 → new run, steps 1–2 reused from journal. |
| `v8-heuristic-not-suspend.json` | Turn ends with a question in plain text, no explicit signal → `failed missing-output` with `hint: "possible-input-request"`, never `suspended`. |
