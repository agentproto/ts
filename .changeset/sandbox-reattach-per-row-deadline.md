---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

fix(sandbox,cli): bound the boot re-attach pass with a per-row deadline

Every individual re-attach step was already bounded (the e2b SDK caps a request at 60s × 3
retries, the MCP client caps a request at 60s, the box probe at 10s), but they stacked to
4–6+ minutes **per row** with no overall deadline — so a single wedged box left
`pending > 0` in `/health` and made `agentproto daemon restart` hang silently for minutes
before printing a bare "still pending".

Runtime (`runSandboxReattachPass`): a per-row `timeoutMs` (default 30s, overridable via
`AGENTPROTO_REATTACH_TIMEOUT_MS`) races each row's attempt. On timeout the provider's
`probe` is consulted (bounded at 5s) — `{ alive: false }` ends the row `sandbox_gone` and
stamps the ledger `gone`, anything else ends it `failed` with the detail
`reattach timed out after Ns`. Cleanup only detaches (MCP + timers); it never stops,
pauses or kills a box that may still be running. A late settle from a timed-out row just
releases the half-open handle, so the pass always drains `pending` to 0.

CLI (`daemon restart`): prints a `re-attaching N sandbox session(s)…` progress line up
front and caps the wait at 60s (runtime deadline + margin) instead of 120×500ms polls.
If the pass hasn't settled by then it notes that the pass continues in the daemon and
points at `agentproto daemon status`, which now also renders the re-attach tally next to
the `/health` sandbox line.
