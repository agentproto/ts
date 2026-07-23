---
"@agentproto/corpus": minor
"@agentproto/corpus-cli": minor
---

Adds `pr-review` corpus importer to transform GitHub pull requests into AIP-10 sources. Includes PrReviewImporter (pure, forge-agnostic), GhPrSourceAdapter (GitHub CLI backend), and import-prs CLI command. Sources marked as secondary authority (derived commentary). Supports --dry-run hermetic mode, per-PR error resilience, content-hash deduplication, and diff summaries.
