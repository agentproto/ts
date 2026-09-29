---
schema: knowledge.workspace/v1
name: finance-team-view
title: Finance team view
description:
  Finance team's lens. Adds Deal as a first-class entity type and switches
  conflict resolution to recency.
version: 1.0.0

extends: ../../research-wiki/KNOWLEDGE.md

entityTypes:
  - name: Deal
    icon: 📊
    fields: [counterparty, stage, value, owner, closed_at]
    description: A finance transaction tracked by the team.

curation:
  conflictResolution: recency # overrides parent 'defer'

queryHints:
  scopeTo: [Concept, Deal]
---

# Finance team view
