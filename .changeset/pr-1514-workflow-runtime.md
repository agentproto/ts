---
"@agentproto/workflow-runtime": minor
---

Fix workflow_cancel: every step (agent, gate, map/pipeline fan-out) now refuses to dispatch once a run is cancelled, including a sibling in the same stage — not just a later one. A gate step's subprocess is killed via the abort signal instead of running to completion unsupervised.
