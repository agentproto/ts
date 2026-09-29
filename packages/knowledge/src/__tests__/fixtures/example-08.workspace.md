---
schema: knowledge.workspace/v1
name: research-wiki
title: Research wiki
description:
  Shared research knowledge base. Concepts and people that recur across
  projects, with provenance and recency tracking. Source authority defaults to
  'secondary' because most ingests are reading-list digests, not first-party
  recordings.
version: 1.0.0

curator: ws://operators/wiki-curator

entityTypes:
  - name: Concept
    icon: 🧠
    fields: [definition, sources, related]
    description:
      An abstract idea recurring across reading. Curators distill 3+ source
      mentions into one Concept entry.
  - name: Person
    icon: 👤
    fields: [name, role, contact, affiliations]
    description:
      A real-world person referenced by sources. Stub on first mention; expand
      when facts accumulate.

lints:
  - id: require-source
    kind: require-source
    appliesTo: Concept
    severity: error
  - id: max-age-90
    kind: max-age
    appliesTo: "*"
    severity: warn
    params:
      days: 90
  - id: broken-ref
    kind: broken-ref
    appliesTo: "*"
    severity: error

sources:
  retention: forever
  signing: optional
  hashAlgo: sha256
  authorityDefault: secondary

curation:
  tone: neutral
  depth: medium
  autoLink: byName
  conflictResolution: defer

queryHints:
  preferRecent: true
  preferAuthoritative: false

display:
  defaultGrouping: kind
---

# Research wiki — base manifest

## Purpose

Shared research notes. Anyone on the team should be able to land on this wiki
and find a one-page distillation of any concept that has shown up in three or
more reading-list items.

## Conventions

- Concepts MUST cite sources. Stub Person entries are allowed unsourced.
- Body prose stays neutral; per-team views (research, sales) override
  `curation.tone` for their lens.

## When to extend vs replace

Extend (in a per-consumer view) when you want a different lens on the same wiki.
Fork the wiki (separate root) only when the entity model itself diverges enough
that merge no longer makes sense.
