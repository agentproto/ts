---
name: Harness knowledge
id: harness-knowledge
description: An agent step whose harness.knowledge workspaces resolve at load time.
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
          anyOf: [book-factory]
          maxEntries: 10
          mode: files
        - workspace: /tmp
          mode: files
---

# Harness knowledge

Body prose is ignored by the loader.
