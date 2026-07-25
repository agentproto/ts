---
"@agentproto/runtime": minor
---

Add Fix D: best-effort resume-context digest for blank-fallback resume scenarios. When a resume degrades to a fresh spawn (adapter doesn't support resume or its conversation store is missing), the daemon reconstructs a bounded summary from `events.jsonl` and injects it as initial context so the session isn't completely blind. Digest is strictly gated on blank-fallback flags—a successful native or ACP resume never gets double-fed its own context.
