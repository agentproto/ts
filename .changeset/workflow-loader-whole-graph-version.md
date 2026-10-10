---
"@agentproto/workflow-loader": patch
---

Fix the daemon serving stale workflow modules after an edit. The cache-busting version of a workflow entry was the newest mtime under the entry's own directory, so editing a relative import that lives in another directory (e.g. `../shared/two-step.mjs`, as the steward's classify/analyze/act workflows do) never changed the version and the old module kept running until a daemon restart. The version is now a content hash of the entry's whole relative-import graph (any depth, any directory) plus the entry directory's scripts: any edit to the graph reloads it on the next run, an unchanged graph is served from Node's module cache. Covered by child-process tests that run the real loader.
