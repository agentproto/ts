---
name: Harness knowledge missing
id: harness-knowledge-missing
description: An agent step whose harness.knowledge workspace does not exist.
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
        - workspace: ./no-such-corpus
          mode: files
---

# Harness knowledge missing
