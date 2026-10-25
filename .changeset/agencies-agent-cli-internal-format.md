---
"@agentproto/agencies": patch
"@agentproto/driver-agent-cli": patch
---

Add an internal data-format id (`AGENCIES_FORMAT`, `AGENT_CLI_FORMAT`), so the packages no longer present their format ids as AIP registry spec names. The legacy `SPEC_NAME` export is retained for compatibility and is now deprecated; it remains a legitimate pending registry-name deviation until it is removed.
