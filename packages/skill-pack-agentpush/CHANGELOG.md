# @agentproto/skill-pack-agentpush

## 0.2.2

### Patch Changes

- f2d5f89: Sync the agentpush SKILL.md `transmit_message` return-shape docs with runtime behavior (success/failure shapes, `message_id`, `blocked_reason`/`suggestion` for HTTP-200 blocked/failed statuses).

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- 5ec07b1: New `@agentproto/skill-pack-agentpush` skill pack: agentpush transmitter skill (inbound/outbound message routing, session binding, contact wiring) and relocated auth skill (with updated credentialRef documentation for child-MCP mounting). Publishes to npm and as Claude Code plugin bundle.
