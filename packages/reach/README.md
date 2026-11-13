# @agentproto/reach

The REACH contract (`reach/v1`): one way for a host to reach its human, with receipts and a floor.
Zero runtime dependency.

- `ReachMessage`: content `{ summary, sections?, links?, attachments? }` plus the envelope
  `{ intent: "tell" | "ask", to, urgency: "now" | "normal" | "digest", dedupeKey, expiresAt?, source, ask? }`.
- `ReachReceipt`: `delivered | deferred(until) | deduped | undelivered(reason) | failed(reason)`, with
  `adapterId` and `at`. `delivered`, `deferred` and `deduped` acknowledge (`isAcknowledged`).
- `ReachAdapter` (`id`, `kind`, `capabilities`, `send`, `close?`) and `ReachCapabilities`
  (`maxChars`, `actions`, `files`, `link`, `defers`, `retracts`, `identity`), declared per instance.
- `ReachRouteEntry`: one adapter instance of a route, a union discriminated by `kind`
  (`telegram`, `webhook`, `chat-sdk`).
- `ReachAnswer`: the shape of a human's answer to an `ask` (type only for now).
- `reachContentFromPreview(preview, title)`: the one parser from an approval `preview` to REACH
  content (summary falling back to the title, https links only, bare file names only, legacy keys
  dropped).
- `parseReachReceipt(body)`: strict on what it reads (a known `status`, `until` on `deferred`, a
  `reason` on `undelivered` and `failed`); anything that is not a valid receipt is refused. Unknown
  keys are ignored and dropped from the result, so a receiver may add its own fields.
- `runReachConformance(handler, { secret })`: for a webhook receiver's own tests. Given
  `(req: Request) => Promise<Response>`, it checks that a signed message gets a valid receipt and
  that the same `dedupeKey` twice gets `deduped` or the same receipt. A bare 200 with no receipt
  fails.

## The webhook wire

The host `POST`s `{ "type": "message", "message": <ReachMessage> }` and later
`{ "type": "close", "dedupeKey", "outcome" }`, signed the Standard Webhooks way (`webhook-id`,
`webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`, keyed by the
base64 payload of a `whsec_` secret). The receiver answers a 2xx whose JSON body is a receipt body,
for example `{ "status": "deferred", "until": "2026-11-13T08:00:00Z" }`. Extra fields are
ignored. Anything that is not a receipt is read as `failed`.
