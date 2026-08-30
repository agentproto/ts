---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Add test coverage for `auth profile refresh-models` CLI command and `auth_profile_refresh_models` MCP tool. Both test suites verify the happy path (successful refresh against the current model catalog) and error handling (unknown profile id).
