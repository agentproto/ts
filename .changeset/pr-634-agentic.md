---
"@agentproto/runtime": minor
---

Fix billing-auth re-resolution for lazy in-place session resume. Previously, lazy resume called `startSession` with no auth, causing sessions pinned to subscription billing to silently use the daemon's ambient `ANTHROPIC_API_KEY` instead of re-resolving credentials fresh from config. Extracts shared `resolveResumeAuth` function used by both restart and lazy resume paths to ensure consistent fail-loud behavior. Exports `resolveResumeAuth`, `ResumeAuthResolution`, and `ResolveResumeAuthOptions` for external use.
