# @agentproto/transcript-fixtures

## 0.3.2

### Patch Changes

- 1620b03: Messaging can now cross workspace boundaries: `defaults.messaging.peerGroups` links groups of workspace slugs so `message_send` / `message_reply` (and the HTTP typed-message route) may reach a session in a peer workspace without a tree edge, independent of `defaults.messaging.allowSameWorkspace`. The ACL decision is centralized in `resolveMessageAcl` and shared by both the MCP tools and `POST /sessions/:id/messages`; `transcript-fixtures` now accepts the `peer` relation in raw session-message envelopes.
- 1620b03: The raw `session-message` envelope type now allows `relation: "peer"` (a message between two sessions of the same workspace or peer group, written by the daemon's transcript writer).

## 0.3.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.3.0

### Minor Changes

- ea5e30d: Add typed SessionMessage envelope + session-message transcript record for inter-session reports

### Patch Changes

- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- ec4fda5: Add canonical RAW daemon-transcript fixtures package for anti-drift conformity testing.
- 8900417: Add support for `usage_update` and `usage_snapshot` transcript record kinds as known no-ops. These high-frequency cost/context bookkeeping records were previously falling through to the unknown-kind error path. Fixes spurious error chunks and console logging on every turn against a live daemon.
