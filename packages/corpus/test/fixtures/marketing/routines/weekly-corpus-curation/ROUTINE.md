---
schema: routine/v1
id: weekly-corpus-curation
description: |
  Weekly curator pass — review the human-review queue, promote
  what's ready, deprecate what's stale, archive playbooks whose
  shadow eval has converged.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 10 * * 1"
  timezone: "UTC"
  catchup: skip
target:
  workflow: review-candidate
  inputs:
    mode: batch
    maxItems: 50
retry:
  max_attempts: 2
  backoff: exponential
on_failure:
  create_work_item: true
  fire_event: corpus.curation.weekly-failed
fires_events:
  - corpus.curation.weekly-completed
enabled: true
tags: [corpus, curation, weekly]
metadata:
  corpus:
    domain: marketing
---

# Weekly Corpus Curation

Monday 10:00 UTC. The curator runs through the corpus-review queue, promotes approved candidates, deprecates stale entries. Pairs with `daily-source-scout` (which fills the pipeline).
