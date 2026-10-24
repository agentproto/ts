# AIP-7 and the runtime approval request

The runtime implements AIP-7's `approval-request`, accepted in
agentproto/agentproto#47. An `ApprovalRequest` pins an exact payload behind a
human decision: an approve writes an AIP-7 `signature` on the pinned payload
and appends a hash-chained audit event, while a deny appends an audit event
with no signature. Only declared human channels (`web_click`, `ui_card`,
`telegram`) can decide a request; no model-callable tool can flip it.

See AIP-7 at https://agentproto.dev/docs/aip-7 and the implementation under
`packages/runtime/src/approvals/`.
