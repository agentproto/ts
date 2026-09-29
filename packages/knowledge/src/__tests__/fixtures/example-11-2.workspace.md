---
schema: knowledge.workspace/v1
name: cfo-assistant-view
title: CFO assistant view
description:
  CFO assistant operator's lens. Sales-tone, deep depth, scoped to Deals only.
version: 0.3.0

extends: ../../KNOWLEDGE.md # the team view, NOT the workspace root

appliesTo:
  - ws://operators/cfo-assistant

curator: ws://operators/cfo-assistant

curation:
  tone: sales # overrides team's inherited 'neutral'
  depth: deep # overrides parent 'medium'

queryHints:
  scopeTo: [Deal] # narrows team's [Concept, Deal]
---

# CFO assistant view
