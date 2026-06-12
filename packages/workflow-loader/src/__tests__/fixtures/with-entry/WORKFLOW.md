---
name: Double then add
id: double-add
description: Double the input, then add ten. Backed by a TS entry module.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: d
    kind: tool
    tool: demo.double
    inputs:
      n: $input.n
  - id: a
    kind: tool
    tool: demo.add-ten
    inputs:
      n: $steps.d.n
---

# Double then add

The manifest mirrors the entry's graph for governance; the entry is the source
of truth for runtime step logic.
