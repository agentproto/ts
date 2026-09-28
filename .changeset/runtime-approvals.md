---
"@agentproto/runtime": minor
---

New approvals engine: the daemon's human-approval primitive, built on AIP-7 signatures (`@agentproto/governance` / `@agentproto/governance-engine`). An `ApprovalRequest` pins an exact payload (sha256 of its canonical JSON) behind a human decision; only a declared human channel may decide it, never a model-callable tool.

- Two channels: `web_click` (`POST /approvals/:id/decision`, gated by both the daemon's bearer token and an `Origin` in the new `approvals.webOrigins` config, default off) and `ui_card` (an MCP Apps `ui://agentproto/approval/<id>` card whose HTML mints a fresh one-time ticket on every read; its Approve/Deny buttons call the app-only `approval_card_decide` tool, registered with `_meta.ui.visibility: ["app"]`). The card tool and card resources are only mounted on the opt-in `/mcp?surface=approval-cards` endpoint, which refuses daemon-spawned sessions; the root and per-session `/mcp` never expose them, so an agent cannot approve its own request.
- New model-visible MCP tools: `approval_request`, `approval_get`, `approval_wait` (bounded long-poll, 45s max), `approval_consume` (one-shot, re-hashes and rejects a payload mismatch).
- New HTTP twins: `POST /approvals`, `GET /approvals?status=`, `GET /approvals/:id`, `GET /approvals/:id/wait`, `POST /approvals/:id/consume`, `POST /approvals/:id/decision`.
- New session-bus events: `approval:requested`, `approval:decided`, `approval:consumed`, `approval:expired`.
- An approve writes an AIP-7 `signature` on the pinned payload and a hash-chained audit event under `~/.agentproto/approvals/audit/`; a deny writes an audit event with no signature. Persistence is atomic and reloads at boot, so a pending request survives a restart.

Task board: a task can be linked to an approval (`awaiting_approval` status, `approvalIds` and `artifacts` links); the ledger follows `approval:decided` and never releases a task while it waits. No migration of `policy_ack` / held permissions / workflow approval steps onto this primitive yet (see `packages/runtime/src/approvals/AIP-7-AMENDMENT.md`).
