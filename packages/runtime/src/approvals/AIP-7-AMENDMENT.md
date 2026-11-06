# AIP-7 and the runtime approval request

The runtime implements AIP-7's `approval-request`, accepted in
agentproto/agentproto#47. An `ApprovalRequest` pins an exact payload behind a
human decision: an approve writes an AIP-7 `signature` on the pinned payload
and appends a hash-chained audit event, while a deny appends an audit event
with no signature. Only declared human channels (`web_click`, `ui_card`,
`telegram`) can decide a request; no model-callable tool can flip it.

See AIP-7 at https://agentproto.dev/docs/aip-7 and the implementation under
`packages/runtime/src/approvals/`.

## Bureau recipe writes

An imported MCP that is a Bureau server (`subsession: "aip-59"`) can refuse a
gated recipe write with the error `browser:approval_required` and
`deviceDecision: true`. The daemon's `approvals/bureau-bridge.ts` turns that
error into an approval of kind `bureau.recipe-write`:

1. The agent's tool result keeps Bureau's error and gains `approvalId` plus
   `waitWith: "approval_wait"`, and the result carries
   `_meta.ui.resourceUri: "ui://agentproto/approval/<approvalId>"` so an MCP
   Apps host renders the standard Approve / Deny card on the tool call.
2. The agent blocks on `approval_wait`. Nothing it can call decides the
   approval; only a human channel does.
3. When a human decides, the daemon posts the decision to Bureau's
   `POST /pair/approvals/<requestId>` with its device credential (never a
   sub-session token). Bureau signs its own approval.
4. The agent retries the Bureau tool with `approvalId: <Bureau requestId>`.

The `web_click` channel (the fallback card in a composer dock, decided through
`POST /approvals/:id/decision`) is enabled only when the operator sets
`approvals.webOrigins` in the daemon config. The `ui_card` channel always
works and needs no origin configuration.
