---
name: Harness knowledge deferred
id: harness-knowledge-deferred
description: An agent step whose harness.knowledge selector carries run-time refs.
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
        - workspace: $input.bookDir/knowledge
          anyOf: [$input.topicTag]
          mode: files
---

# Harness knowledge deferred

Body prose is ignored by the loader.
