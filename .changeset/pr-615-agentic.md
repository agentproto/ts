---
"agentproto-vscode": minor
---

Add "Stopped" and "Failed" status filter options to the sessions tree view, refactored to use the activity classification system (`activityFor`) for clearer semantics and correct handling of edge cases like sessions killed mid-turn vs. idle after completion.
