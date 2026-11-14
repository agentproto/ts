---
spec: harness/v1
id: research-assistant
name: Research Assistant
description:
  Two-mode harness for structured research tasks — plan first, then execute.
version: 0.1.0

storage:
  $resolver: "@guilde/harness/storage/postgres"
  input:
    connectionStringEnv: DATABASE_URL
    storeId: guilde-harness

models:
  resolver:
    $resolver: "@guilde/harness/model/resolver"

memory:
  $resolver: "@guilde/harness/memory/shared"

modes:
  - id: plan
    name: Plan
    description:
      Elaborate a research plan and wait for user approval before proceeding.
    default: true
    color: "#3b82f6"
    transitionsTo: execute
    defaultModelId: claude-sonnet-4-6
    agent:
      $resolver: "@guilde/harness/agent/operator"
      input:
        operatorId: research-assistant
    model:
      $resolver: "@guilde/harness/model/for-mode"
      input:
        default: claude-sonnet-4-6
    builtins:
      ask_user: true
      submit_plan: required
      task_write: true
      task_check: false
      subagent: false

  - id: execute
    name: Execute
    description: Carry out the approved research plan autonomously.
    default: false
    agent:
      $resolver: "@guilde/harness/agent/operator"
      input:
        operatorId: research-assistant
    model:
      $resolver: "@guilde/harness/model/for-mode"
      input:
        default: claude-sonnet-4-6
        allowed:
          - claude-sonnet-4-6
          - claude-haiku-4-5-20251001
    builtins:
      ask_user: true
      submit_plan: false
      task_write: true
      task_check: true
      subagent: true
---

# Research Assistant Harness

A two-mode harness for structured research tasks.

## Mode: plan

The agent elaborates a step-by-step research plan, presents it to the user, and
waits for approval via `submit_plan` before any execution begins.

## Mode: execute

Once the plan is approved, the agent autonomously executes each step.
