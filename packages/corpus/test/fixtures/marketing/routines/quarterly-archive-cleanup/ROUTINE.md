---
schema: routine/v1
id: quarterly-archive-cleanup
description: |
  Quarterly storage hygiene — migrate sources older than 6 months
  to sources/cold/, hard-delete archived entries past their
  retention window, prune orphaned _candidates.yaml rows.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 6 1 1,4,7,10 *"
  timezone: "UTC"
  catchup: skip
target:
  workflow: corpus-archive-cleanup
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: corpus.archive-cleanup.failed
fires_events:
  - corpus.archive-cleanup.completed
enabled: true
tags: [corpus, archive, quarterly, maintenance]
metadata:
  corpus:
    domain: marketing
---

# Quarterly Archive Cleanup

First day of every quarter at 06:00 UTC. Migrates aging sources to cold storage (still under `sources/cold/` for AIP-10 path resolvability), and prunes terminal-status candidates beyond retention.
