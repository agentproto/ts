---
"@agentproto/runtime": patch
---

Carry `::agentproto-artifact::` ledger markers through the session ring buffer. The tool-result summarizer collapses multi-line tool output to one lossy line ("N lines, XB"), which destroyed the artifact-ledger marker the CI delivery helper prints — `driver: artifacts=[]` on every agentflow run, so the review provenance stamp always degraded to sha discovery (and PR #1054's review lost its footer entirely when a network blip killed the job before the fallback could run). Marker lines are now re-emitted verbatim under a `[tool-artifact]` prefix: raw `agent_output` keeps them harvestable (and JSON-parseable — no ANSI wrapping), while clean mode still strips them from human-facing output.
