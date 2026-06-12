---
name: Double then add
id: double-add
description: Double the input, then add ten. Purely declarative — no entry.
version: 0.1.0
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

Body prose is ignored by the loader.
