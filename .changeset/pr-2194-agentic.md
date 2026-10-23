---
"@agentproto/runtime": patch
---

Eligibility gate for live model switches (`agent_set_model` / `registry.setModel`): a free session is refused when the target leaves the OpenCode free tier, and a target outside the session profile's allow-list (plus the wallet and adapter-capability verdicts, delegated to `createRotationTargetCheck`) is refused with a `not-eligible:`-prefixed reason. Harness-advertised live model values skip the catalog allow-list but still honor free-stays-free; the gate runs after the model↔route guard and the not-supported check. Mirrors the PR's own `.changeset/set-session-model-eligibility.md` (`@agentproto/runtime`: patch) — both are correct, they aggregate to a single patch bump.
