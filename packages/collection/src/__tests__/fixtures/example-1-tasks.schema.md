---
schema: collection.schema/v1
name: tasks
title: Tasks
description:
  A minimal task collection — title, status, owner. No deadline, no priority.
  Use for lightweight ad-hoc tracking when a fuller spec would be premature.
version: 1.0.0

fields:
  - name: notes
    type: text
    required: false
    description: Free-form prose attached to the task.

statuses:
  - id: todo
    label: To do
    transitionsTo: [in-progress, done]
  - id: in-progress
    label: In progress
    transitionsTo: [todo, done]
  - id: done
    label: Done
    terminal: true
initialStatus: todo

ownership:
  cardinality: single
  role: owner
  required: false

deadline:
  kind: none

lints:
  - id: orphan
    kind: orphan
    appliesTo: "*"
    severity: info

identity:
  slugSource: title
  filingPath: items/{collection}/{slug}.md
---

# Tasks

## Purpose

Lightweight task tracking. Items have a title, an optional owner, and a status.
No deadlines, no priority — by design.

## When to use this vs a richer collection

Use `tasks` for ad-hoc work that doesn't need a deadline or a priority signal.
For deadline-driven work, see `okrs`. For defect tracking, see `bugs`.
