---
name: Mismatched
id: mismatched
description: The manifest declares a graph the entry does not match.
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
