---
name: With bad ref
id: with-bad-ref
description: A subworkflow with-block referencing a step id that does not exist.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: sub
    kind: subworkflow
    workflow: child
    with:
      topic: $steps.ghost.x
---

# With bad ref

Load must reject this, naming the step and the key.
