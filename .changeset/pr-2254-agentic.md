---
"@agentproto/runtime": minor
---

Add `WorkflowRunner.dispose()`: a new exported method that clears the runner's trailing-flush and lease-heartbeat timers, unsubscribes its session-event-bus listeners, removes its process-exit drain, and awaits queued persistence so a test or shutdown path can tear down a persist directory without racing an in-flight write.

> Reviewer note: the PR's existing `.changeset/workflow-runner-dispose.md` marks this `patch`, but a new exported method on the public `WorkflowRunner` interface is a new feature. If this file lands alongside it, changesets selects the highest bump (minor). Adjust/supersede the existing changeset accordingly.
