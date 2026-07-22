---
"@agentproto/runtime": minor
---

Add Task-to-Activity linking via read-time join. Introduces `ActivityTaskLister` interface and `linkTasks()` function that enriches activity records with `taskId` — turns link to the OPEN task their session owns; policies link to the task whose verify gate is that policy. Also adds `snapshot()` method to `TaskLedger` interface for unscoped task access needed by the Activity projector. Maintains clean separation: Task stays the source of truth for INTENT, Activity for EXECUTION.
