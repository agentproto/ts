---
name: With threading
id: with-threading
description: A subworkflow step whose with-block must compile into the step's inputs projection.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: d
    kind: tool
    tool: demo.double
    inputs:
      n: $input.n
  - id: sub
    kind: subworkflow
    workflow: child
    with:
      topic: $input.bookDir
      audience: $input.audience
      n: $steps.d.n
      limit: 3
  - id: bare
    kind: subworkflow
    workflow: child-bare
---

# With threading

`sub.with` exercises every reference form: parent input fields
(`$input.bookDir`, `$input.audience`), a prior step's output (`$steps.d.n`),
and a literal (`3`). `bare` has no `with:` and must be left untouched.
