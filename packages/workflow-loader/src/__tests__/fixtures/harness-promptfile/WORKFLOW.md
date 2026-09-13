---
name: Harness promptFile
id: harness-promptfile
description: An agent step whose prompt is read from harness.promptFile.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: s1
    kind: agent
    adapter: claude-code
    harness:
      promptFile: ./prompt.txt
---

# Harness promptFile

Body prose is ignored by the loader.
