---
name: Harness promptFile missing
id: harness-promptfile-missing
description: An agent step whose harness.promptFile does not exist on disk.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: s1
    kind: agent
    adapter: claude-code
    harness:
      promptFile: ./nope.txt
---

# Harness promptFile missing
