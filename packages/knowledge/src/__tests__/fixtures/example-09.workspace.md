---
schema: knowledge.workspace/v1
name: research-analyst-view
title: Research analyst view
description:
  The research-analyst operator's lens on the shared research wiki.
  Concept-focused, academic tone, stricter confidence floor, more lenient on
  historical sources.
version: 1.0.0

extends: ../../research-wiki/KNOWLEDGE.md

appliesTo:
  - ws://operators/research-analyst

curator: ws://operators/research-analyst

lints:
  - id: max-age-90
    kind: max-age
    appliesTo: "*"
    severity: info # softened from 'warn'
    params:
      days: 90
  - id: min-confidence-concept
    kind: min-confidence
    appliesTo: Concept
    severity: warn # added by this view
    params:
      min: 0.6

curation:
  tone: academic # overrides parent 'neutral'
  depth: deep # overrides parent 'medium'

queryHints:
  preferRecent: false # overrides parent 'true'
  preferAuthoritative: true # overrides parent 'false'
  scopeTo: [Concept] # narrow query default
---

# Research-analyst view

The research analyst doesn't care about Person stubs and reads historical
material liberally. Concepts are the unit of value; recency is less important
than authority.
