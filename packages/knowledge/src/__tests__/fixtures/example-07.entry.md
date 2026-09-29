---
schema: knowledge.entry/v1
slug: compounding-knowledge-pattern
kind: concept
title: The compounding-knowledge pattern
sources:
  - 2026-04-15-karpathy-llm-wiki-gist
  - 2026-04-16-anthropic-skills-blog
  - 2026-04-18-agents-md-spec
  - 2026-04-22-ingest-prototype-notes
  - 2026-04-25-internal-design-doc
  - 2026-04-26-team-discussion-thread
confidence: 0.95
updated_at: 2026-04-27T18:00:00Z
supersedes:
  - rag-vs-wiki-comparison
  - knowledge-base-options-2026
links:
  - llm-as-compiler
  - immutable-sources-rule
  - schema-as-trade-unit
tags: [knowledge, pattern, distilled]
---

# The compounding-knowledge pattern

A curated wiki rewritten by an LLM on every ingest, on top of immutable raw
sources, produces a knowledge artefact that compounds across ingests instead of
being recomputed per query.

## The three layers

1. **Immutable sources.** Raw bytes — papers, transcripts, dumps — pinned by
   hash and never edited (see [[immutable-sources-rule]]).
2. **Curated entries.** The LLM rewrites these on every ingest, citing sources
   by id, linking sibling entries.
3. **Schema (`AGENTS.md`).** The unit of trade — a domain expert ships a schema,
   runtimes execute it ([[schema-as-trade-unit]]).

## Why this beats RAG

The compiled artefact is auditable and forkable; RAG's per-query retrieval is
neither (see [2026-04-15-karpathy-llm-wiki-gist],
[2026-04-25-internal-design-doc]).

## Why this beats vendor "memory"

The wiki survives runtime migration. The bytes on disk are the contract; any
conforming host can open them ([2026-04-18-agents-md-spec]).

## Supersedes

This entry replaces the older [[rag-vs-wiki-comparison]] (which treated the two
as equivalent options) and [[knowledge-base-options-2026]] (which surveyed the
field without picking). Both old entries remain on disk for audit; new readers
land here.
