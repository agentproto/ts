---
name: Harness knowledge deferred authored
id: harness-knowledge-deferred-authored
description: An agent step whose harness.knowledge selector authors the internal deferred field.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: s1
    kind: agent
    adapter: claude-code
    prompt: write the chapter
    harness:
      knowledge:
        - workspace: ./corpus
          deferred: true
          mode: files
---

# Harness knowledge deferred authored

Body prose is ignored by the loader.
