---
"@agentproto/runtime": patch
---

The approval card now fits its content and follows the chat theme. It reports `ui/notifications/size-changed` after the `ui/initialize` handshake and on every resize (also for the "nothing to decide" pages), applies `hostContext.theme` and `styles.variables` with `prefers-color-scheme` fallbacks on a transparent body, and uses a quieter layout: compact key/value lines clipped to 3 lines, a relative expiry line, small right-aligned Approve (primary) and Refuse (ghost) buttons with no green or red fills, and a one-line "Approved" / "Refused" result.
