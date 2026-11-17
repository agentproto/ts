---
"@agentproto/apps": minor
---

repo-maintenance `maintain`: a run whose reviewer cannot run now ends `failed`, not `done`. A pre-flight probe (`probeReviewer`, default true) runs one trivial turn per review model role on the same model, adapter and billing profile as the real turns and aborts before reviewing anything if it fails. After the fan-out, when more than `maxEmptyTurnShare` (default 0.5) of the reviewer turns ended with an empty turn, the run fails too. The report starts with `RUN FAILED` and names the model role, model, adapter and profile; the operator notification still goes out as a failure alert, never as a success report. The reviewer prompt also tells a superseded verdict how to find the PR to cite in `landedIn`. The 2026-11-16 nightly run failed 28 of 28 turns and still posted a normal report.
