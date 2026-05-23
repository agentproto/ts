---
schema: routine/v1
id: daily-source-scout
description: |
  Daily routine that runs the source-scout operator to discover new
  candidate sources across configured external feeds. Discovered sources
  are archived under sources/ and rows appended to _candidates.yaml.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 9 * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow: ingest-source
  inputs:
    feeds: [tiktok-curated, hubspot-blog, reddit-marketing]
    maxItemsPerRun: 50
retry:
  max_attempts: 3
  backoff: exponential
on_failure:
  create_work_item: true
  fire_event: corpus.scout.failed
fires_events:
  - corpus.scout.completed
  - corpus.candidate.discovered
enabled: true
tags: [corpus, scout, daily]
metadata:
  corpus:
    domain: marketing
---

# Daily Source Scout

Runs every morning at 09:00 UTC. Scouts external feeds for new candidate sources, archives them, and appends to `_candidates.yaml`. The candidate event downstream triggers `analyze-candidate` workflow.
