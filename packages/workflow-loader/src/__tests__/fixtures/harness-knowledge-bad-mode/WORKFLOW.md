---
name: Harness knowledge bad mode
id: harness-knowledge-bad-mode
description: An agent step whose harness.knowledge selector uses a reserved mode.
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
          mode: tool
---

# Harness knowledge bad mode
