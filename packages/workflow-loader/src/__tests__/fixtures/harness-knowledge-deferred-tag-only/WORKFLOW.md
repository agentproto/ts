---
name: Harness knowledge deferred tag only
id: harness-knowledge-deferred-tag-only
description: An agent step whose harness.knowledge selector has a ref-free workspace but a ref-bearing tag.
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
          anyOf: [$input.topicTag]
          mode: files
---

# Harness knowledge deferred tag only

Body prose is ignored by the loader.
