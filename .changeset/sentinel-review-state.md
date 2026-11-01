---
"@agentproto/sentinel": minor
---

Sentinel triage treats `changes_requested` reviews and `action_required` check conclusions as wake-class (failure) verdicts, compares verdicts case-insensitively, and the `local-gh` provider now emits review `data.state` in lowercase so it matches the webhook provider (`CHANGES_REQUESTED` becomes `changes_requested`). Triage stays observation-only.
