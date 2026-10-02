---
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Bound the session-steward's apply by session origin: a pure origin policy (`origin-policy.mjs`) classifies each candidate as user-origin (chat-starter, vscode, or a root with no origin and no parent — flag-only, never closed) or closable (cron:*, gate, executors), configured by new `userOrigins` / `closableOrigins` workflow inputs. `SessionWrapupEntry` carries `origin` / `parentSessionId` through, and the steward report gains an `origin` column with the retained action.
