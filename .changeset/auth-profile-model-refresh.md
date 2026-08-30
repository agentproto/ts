---
"@agentproto/auth": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Fix curation drift on `mode: "allow"` auth profiles: an allowlist generated once at create/import time was a frozen snapshot of the catalog that day — new models the catalog picked up later never became usable through the profile, and retired ones lingered forever, with nothing surfacing the mismatch. Adds an explicit, opt-in re-sync: `refreshAuthProfileModels` (`@agentproto/auth`) recomputes a profile's `ids` against a caller-supplied current-catalog snapshot, exposed as the `auth_profile_refresh_models` MCP tool and the `agentproto auth profile refresh-models <id>` CLI verb. Nothing calls this automatically — a profile is only touched when refreshed by name — and it rejects a `mode: "all"` profile outright, since that mode already tracks the live catalog on every read.
