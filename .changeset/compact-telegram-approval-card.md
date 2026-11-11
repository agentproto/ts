---
"@agentproto/runtime": patch
---

The daemon's Telegram approval card is now a compact notification for a preview that uses the `summary` / `sections` / `links` convention: at most 1800 visible characters, at most 5 sections of 280 characters each, and the other keys on one line (long strings are left off and counted, numbers and booleans are always kept). Files named in `preview.attachments` are no longer sent to Telegram by default; the card prints one `Files:` line with their names. Set `approvals.telegramAttachments: true` to send them as documents and photos as before.
