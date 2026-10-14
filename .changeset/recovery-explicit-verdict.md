---
"@agentproto/runtime": patch
---

Review verdict recovery now fails closed. A complete, schema-valid verdict the reviewer itself stated as JSON in its own final message is extracted deterministically from its typed transcript (`events.jsonl` assistant records only, never tool output) before any recovery model is spawned; conflicting, templated, contradictory or errored-turn approvals are not extracted. The recovery model can no longer approve or be satisfied by a 12-character quote: it may only lift blocking findings whose title, detail, full file path, line and severity are grounded verbatim in the reviewer's prose, and it asks for one follow-up to the original reviewer otherwise. A follow-up turn that errors never earns an approval, and a failed turn's provider error text is kept in `recovery.reason`. Recovery stays inert unless `review.recoveryPresets` is configured.
