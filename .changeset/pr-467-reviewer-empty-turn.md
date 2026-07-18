---
"@agentproto/runtime": patch
---

Fail a workflow agent step on an empty turn (no assistant output, no tool call) instead of reporting `status: "done"`. An empty turn — e.g. the claude-code adapter's CLI hitting "Authentication required" in CI and returning nothing — previously read as a successful step, letting a PR gate pass a review that never ran.
