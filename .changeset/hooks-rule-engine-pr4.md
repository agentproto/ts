---
"@agentproto/runtime": minor
---

Add the semantic hook engine core (Plane 1): `.agentproto/hooks.json` schema + loader (`hooks-config.ts`, mirroring the `allowed-commands.json` cache pattern) and a rule-driven `decide(rules, {tool, command, args}, fallback)` evaluated at the pre-exec permission seam, generalizing the old `permissionHold` boolean into `allow | hold | deny`.

- Every rule carries a required `plane: "semantic" | "blast-radius"` tag; `decide()` only consults `"semantic"` rules (the ACP permission seam), leaving `"blast-radius"` rules as declared-but-unwired substrate for the OS-sandbox plane.
- RISK-0 GUARD: the loader refuses to load a rule that declares `intent:"security"` with `plane:"semantic"` and `action:"hold"` or `"deny"` — a Plane-1 hold/deny is bypassable (bypass posture, in-process tools, non-ACP harnesses) and would be a false sense of safety for a security rule.
- LOG-ONLY DEFAULT: no `.agentproto/hooks.json`, or one containing only `action:"log"` rules, reproduces today's `permissionHold`-boolean behavior exactly — this PR ships the engine + config substrate, not any enforcing rule. `deny` decisions currently degrade to the same hold-for-human path as `hold` (no auto-deny wiring yet).
