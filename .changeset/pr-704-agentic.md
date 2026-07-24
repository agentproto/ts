---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add opt-in supervisor crash-notification (crash-detect PR-4): parent sessions can now receive direct in-band `[child-crashed]` notices when their children crash by setting `notifyParentOnCrash: true` at spawn time. Notices are enqueued immediately for idle parents and queued for delivery at the next turn for busy parents, ensuring no interruption of in-flight work. Complements the existing external webhook notification path.
