---
"@agentproto/adapter-knowledge-corpus": minor
---

Lift the studio corpus-backed knowledge provider into a standalone adapter package. CorpusAdapterCore wraps any backing IKnowledgeProvider over an AIP-10 @agentproto/corpus workspace, hydrates every hit with canonical provenance + temporal decay score, enforces access policy, and rejects public ingest/delete (writes route through the privileged CorpusInternalWriter). Ships LocalFs node:fs FsPort + standalone factory + provider-kit family registration.
