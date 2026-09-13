---
id: __APP_SLUG__-flow
name: __APP_NAME__ flow
description: >-
  Default single-step workflow for __APP_NAME__ — replace with the app's
  real pipeline.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: run
    kind: agent
    agent:
      ref: '__APP_SLUG__-assistant'
    prompt: >-
      Replace this prompt with the step's real task.
cost_class: cheap
tags:
  - scaffold
---
