---
"@agentproto/runtime": minor
---

Add daemon-lane PR provenance stamping: relocate footer generation logic from `scripts/lib/provenance-footer.mjs` into a new pure `pr-provenance` submodule so daemon's `command_execute → gh pr create` path can stamp the same `@agentproto-bot` footer (byte-identical CI format, with daemon-specific auth-profile/supervisor/host/cwd fields) as the CI lane. Include `pr-provenance-stamp` orchestration module for best-effort stamping with idempotency and comprehensive error handling.
