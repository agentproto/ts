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

## Approval links

A Telegram-opened app page can read and decide ONE approval with an AIP-53
link-session token whose `approvalId` claim names it (see
`docs/cli/guides/app-agent-tools.md`). The token reaches exactly
`GET /approvals/:id`, `POST /approvals/:id/decision/telegram` and the two files
routes `GET /approvals/:id/attachments` and
`GET /approvals/:id/attachments/:name` (action `files`, read only) for that id
and no other, and decides through the `telegram` channel in place of the bot
secret. It is
honoured only when the token's verified `telegramUserId` is listed in
`approvals.humanTelegramIds`, an owner-only config key (`writable: false`,
digits only, applied on restart). The list is empty by default, which keeps
approval links off. The decision record (`decision.telegramUserId`) and the
`approval:decided` event name the Telegram user who decided.
