---
"@agentproto/knowledge": patch
"@agentproto/corpus": patch
---

fix(knowledge): make defineKnowledge accept valid AIP-10 entries/sources — cross-AIP `description`/id-length defaults and unquoted YAML timestamps were rejecting every valid `knowledge.entry/v1` and `knowledge.source/v1` definition. Un-skips the corpus conformance tests for the AIP-10 knowledge and AIP-12 playbook manifests.
