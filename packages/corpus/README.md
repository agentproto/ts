# @agentproto/corpus

Canonical composition of AIP-10 / AIP-12 / AIP-18 / AIP-9 / AIP-15 / AIP-41 into an autonomous knowledge-improvement system.

**Status:** alpha — M0 (frozen fixture conformance) only.

## What this is

A composition of existing AgentProto AIPs. It is **not** a new doctype or a parallel spec. It defines no new frontmatter shape of its own — every corpus-specific field rides under `metadata.corpus.*` on existing AIP frontmatters (until validated promotion to first-class via AIP amendments).

| AIP | Role in the corpus |
|---|---|
| AIP-10 KNOWLEDGE | Workspace manifest, raw sources, curated entries, faceted index, audit log |
| AIP-18 COLLECTION | Stateful operational records: candidates, gaps, reviews, eval-cases |
| AIP-12 PLAYBOOK | Executable, operator-bound procedural overlays (shadow/active/archived) |
| AIP-9 OPERATOR | Autonomous roles: scout, analyst, reviewer, curator, gap-finder |
| AIP-15 WORKFLOW | Source-to-corpus lifecycle workflows |
| AIP-41 ROUTINE | Scheduled autonomous loops |

## Architectural invariants

This package is **pure**: imports only `@agentproto/*`, `zod`, `gray-matter`. Zero `@agstudio/*`, zero `@mastra/*`, zero `node:fs`, zero HTTP. All runtime concerns enter via injected ports under `src/ports/`.

The agstudio side (`packages/integration/knowledge/providers/corpus/`) supplies the concrete port implementations and registers a `CorpusKnowledgeAdapter implements IKnowledgeProvider` in the `KnowledgeProviderRegistry`.

## M0 deliverable

A frozen reference fixture workspace under `test/fixtures/marketing/` that validates against the actual AgentProto JSON Schemas at `projects/agentproto/agentproto/specs/resources/aip-XX/draft/*.schema.json`. Engineers building later milestones copy from these fixtures instead of authoring fresh frontmatter.

Run `pnpm test` in this package to verify conformance.
