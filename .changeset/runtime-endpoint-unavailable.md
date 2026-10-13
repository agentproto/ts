---
"@agentproto/runtime": patch
---

Fix: classify `endpoint is unavailable` as `upstream-5xx` transient error

- Add `endpoint (is currently )?unavailable` pattern to `UPSTREAM_5XX_RE` regex in
  `packages/runtime/src/turn-retry.ts` so that messages like
  `AI_APICallError: Upstream request failed: Endpoint is unavailable` are classified
  as `upstream-5xx` and retried instead of being skipped as `other`.
- Update doc comment in `packages/runtime/src/turn-retry-policy.ts` to mention
  "endpoint unavailable" as part of upstream-5xx.
- Add test cases in `packages/runtime/src/__tests__/turn-retry.test.ts`:
  - "Endpoint is unavailable", "Endpoint is currently unavailable", and
    "Endpoint unavailable" now classify as `upstream-5xx`.
  - `missing_required_parameter` message stays as `other` (not retried).