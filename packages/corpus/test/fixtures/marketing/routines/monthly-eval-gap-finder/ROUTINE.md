---
schema: routine/v1
id: monthly-eval-gap-finder
description: |
  Monthly gap-finder run — reads the last 30 days of eval-case
  failures, clusters them, opens corpus-gap items for the scout.
  Closes loop #3 by turning observed weaknesses into next-harvest
  priorities.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 8 1 * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow: detect-corpus-gaps
  inputs:
    windowDays: 30
    minOccurrences: 3
retry:
  max_attempts: 2
  backoff: exponential
on_failure:
  create_work_item: true
  fire_event: corpus.gap-finder.failed
fires_events:
  - corpus.gap-finder.completed
  - corpus.gap.opened
enabled: true
tags: [corpus, gaps, monthly]
metadata:
  corpus:
    domain: marketing
---

# Monthly Eval Gap Finder

First day of each month, 08:00 UTC. Reads aggregated eval-case results, clusters failure modes, opens `corpus-gap/*/ITEM.md` items.
