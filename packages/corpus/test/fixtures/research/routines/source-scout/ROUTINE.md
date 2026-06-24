---
schema: routine/v1
id: source-scout
description: |
  On-demand (or scheduled) routine that runs the source-scout operator to
  discover new candidate sources across configured external feeds and channels.
  Discovered sources are archived under sources/ and rows appended to
  _candidates.yaml.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 8 * * 1"
  timezone: "UTC"
  catchup: skip
target:
  workflow: ingest-source
  inputs:
    feeds: [web-search, youtube, arxiv, news-api]
    maxItemsPerRun: 30
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
tags: [corpus, scout, weekly]
metadata:
  corpus:
    domain: research
---

# Source Scout Routine

Runs weekly (Monday 08:00 UTC) by default; can also be triggered on-demand. Scouts external feeds for new candidate sources, archives them, and appends to `_candidates.yaml`. The candidate event downstream triggers `analyze-candidate` workflow.

Adjust the `schedule` and `target.inputs.feeds` list to match your research domain's primary discovery channels.
