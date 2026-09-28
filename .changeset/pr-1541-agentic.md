---
"@agentproto/runtime": patch
"@agentproto/review": patch
---

Pack rubric paths are now confined to the pack's own root in the runtime loader: `PackSource.readRubric` realpaths both the resolved path and the pack root and refuses to read anything that resolves outside it — covering `../../` escapes, absolute paths, and same-directory symlinks pointing elsewhere — regardless of whether the pack is trusted. `resolvePacks` now eagerly reads every selected agent check's rubric at resolve time and wraps any loader failure in a `ReviewManifestError` naming the pack and check, so a violating pack fails the review up front instead of mid-session.
