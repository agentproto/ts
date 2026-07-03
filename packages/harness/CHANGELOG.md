# @agentproto/harness

## 0.1.1

### Patch Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*_, terminal\__, command*\*, file*_, directory\__, browser*\*, policy*_, routine\__, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.

## 0.1.0

### Minor Changes

- 01040cf: Add @agentproto/harness — typed coder/researcher/supervisor session presets over MCP

### Patch Changes

- a076432: Fix ask() race window, wait_for_any 20-child cap, and isError check in #call
- 3af9021: fix(harness): send hermes model via /model turn instead of spawn args
- 5e908f8: add model/effort manifest options to hermes; fix researcher turn-end sequencing
