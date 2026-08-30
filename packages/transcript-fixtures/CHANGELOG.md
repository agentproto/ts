# @agentproto/transcript-fixtures

## 0.2.0

### Minor Changes

- ec4fda5: Add canonical RAW daemon-transcript fixtures package for anti-drift conformity testing.
- 8900417: Add support for `usage_update` and `usage_snapshot` transcript record kinds as known no-ops. These high-frequency cost/context bookkeeping records were previously falling through to the unknown-kind error path. Fixes spurious error chunks and console logging on every turn against a live daemon.
