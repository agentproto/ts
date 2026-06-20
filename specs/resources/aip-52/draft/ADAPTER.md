# AIP-52 — Harness · Implementer Guide

> **Status:** Draft  
> **Schema:** `HARNESS.schema.json`  
> **Canonical runtime:** `@mastra/core/harness` (Mastra's `Harness` class)

## What is a Harness?

A Harness is a **stateful, multi-mode conversational shell**. Where an AIP-42 Agent is
a single-purpose inference unit, a Harness composes multiple agents into an orchestrated
shell that can:

- Switch between **modes** (e.g. plan → execute → review) with distinct agents, tools,
  and permission rules per mode.
- Hold a **typed conversation state** (`stateSchema` + `initialState`) that persists
  across turns and is visible to all modes.
- Spawn **subagents** via the built-in `subagent` tool (forked or isolated thread).
- Gate tool calls via **tool-approval gates** (`permissions`, `submit_plan` builtin).
- Run **heartbeat handlers** in the background (OM reflector, progress reporter, etc.).

A Harness IS NOT a subtype of AIP-42. Agents are referenced _from_ harness manifests
via `$resolver` / `$ref`; the harness is the orchestrator, not the agent itself.

## Filesystem layout

```
.harness/
  <slug>.md      ← one manifest per harness (YAML frontmatter + prose body)
```

The markdown body (after the frontmatter block) is purely documentary — it is not
parsed by the runtime.

## Manifest shape

```yaml
---
spec: harness/v1
id: my-harness
name: My Harness
version: 1.0.0
description: One-sentence description.

storage:
  $resolver: mastra.storage.composite  # must resolve to MastraCompositeStore

modes:
  - id: plan
    default: true
    name: Plan
    agent: { $resolver: my-agent }
    model: { $resolver: model.plan }
    builtins:
      ask_user: true
      submit_plan: required  # blocks until approved
    transitionsTo: execute

  - id: execute
    name: Execute
    agent: { $resolver: my-agent }
    model: { $resolver: model.execute }
    builtins:
      ask_user: false
      subagent: true

models:
  resolver: { $resolver: model.resolver }  # (modelId) => LanguageModel

subagents:
  - id: researcher
    name: Researcher
    description: Searches and summarises.
    agent: { $resolver: researcher-agent }
    forked: false        # isolated thread (default)
    maxSteps: 20

memory:
  $resolver: mastra.memory.thread

observability:
  $resolver: my.telemetry.entrypoint
---
```

### Required fields

| Field | Type | Notes |
|---|---|---|
| `spec` | `"harness/v1"` | Version pin. |
| `id` | `string` (kebab-case) | Registry key; must be unique within a workspace. |
| `name` | `string` | Human label (≤ 80 chars). |
| `version` | `semver` | Bump on breaking mode / subagent changes. |
| `storage` | `refOrString` | Must resolve to `MastraCompositeStore`. |
| `modes` | `mode[]` | At least one mode required. |
| `models.resolver` | `refOrString` | `(modelId: string) => LanguageModel`. |

## Resolver syntax (`refOrString`)

Three forms are accepted for any field annotated `$ref: "#/$defs/refOrString"`:

```yaml
# 1. Inline literal string (if the field accepts a raw value)
storage: "fs://./data/state"

# 2. Named registry ref — resolved at harness boot from the resolver registry
storage:
  $ref: myApp.storage.main

# 3. Dynamic resolver call — arbitrary typed input passed to the resolver
storage:
  $resolver: myApp.storage.build
  input: { path: "./state", ttl: 3600 }
```

## Modes

Each mode entry defines **one operational context**:

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | Unique within this harness (kebab-case recommended). |
| `agent` | ✅ | Backing `Mastra Agent` instance (via resolver). |
| `model` | ✅ | Resolver returning `{ modelId, defaultModelId?, allowed? }`. |
| `default` | — | First mode with `default: true` activates on new sessions. |
| `transitionsTo` | — | Auto-switch to this mode id after `submit_plan` approval. |
| `tools` | — | Replaces the agent's built-in tools entirely (mutually exclusive with `additionalTools`). |
| `prompt.blocks` | — | Instruction blocks resolved and concatenated as `instructions`. |
| `builtins.*` | — | Enable / disable built-in tools: `ask_user`, `submit_plan`, `task_write`, `task_check`, `subagent`. |
| `permissions` | — | `PermissionRules` resolver — default tool-approval policy for this mode. |

### `submit_plan` values

| Value | Behaviour |
|---|---|
| `false` (default) | Tool not registered. |
| `true` | Registered; plan approval is optional. |
| `"required"` | Registered; the mode blocks on plan approval and then transitions to `transitionsTo`. |

## Subagents

```yaml
subagents:
  - id: drafter
    name: Drafter
    description: Writes first-draft content.
    agent: { $resolver: drafter-agent }
    forked: true           # inherits parent thread + prompt cache
    maxSteps: 30
    allowedHarnessTools: [ask_user, task_write]
    allowedWorkspaceTools: [read_file, write_file]
    prompt:
      blocks:
        - "You are a concise technical writer."
        - { $ref: brand.voice.guide }
```

- `forked: true` — subagent inherits the parent conversation thread and prompt cache
  (cheaper, shares context).
- `forked: false` (default) — fresh isolated thread; the subagent is context-blind to
  the parent.

## Heartbeats

Heartbeats are periodic background handlers registered on the Harness constructor's
`heartbeats` array. Each entry is a `refOrString` resolving to a `HeartbeatConfig`
(interval + handler function). Common uses: Observational Memory reflector, progress
reporter, stale-session reaper.

## Loading algorithm

1. Locate `.harness/<slug>.md` in the workspace (or agent pack).
2. Parse the YAML frontmatter block; validate against `HARNESS.schema.json`.
3. Resolve all `$ref` / `$resolver` entries against the resolver registry at boot time
   — fail loudly if any resolver is missing.
4. Instantiate the `Harness` object (Mastra constructor) with the resolved config.
5. Register in the harness registry keyed by `id`.

**Never execute a harness at load time** — only parse, validate, and register.

## Relationship to other AIPs

| AIP | Relationship |
|---|---|
| AIP-42 (Agent) | Harness agents are AIP-42 instances. A Harness orchestrates them; it is NOT an AIP-42 agent itself. |
| AIP-12 (Playbook) | Agent packs can auto-generate `.harness/` manifests from `modes/*.md` files during ingestion. |
| AIP-35 (Storage) | `storage` field resolves to a provider defined under AIP-35. |
| AIP-37 (Lifecycle Events) | Harness emits `harness-session-start`, `harness-mode-switch`, `harness-session-end` events. |
| AIP-47 (Role) | `permissions` per mode align with AIP-47 role-based access scopes. |

## See also

- `HARNESS.schema.json` — canonical validation schema
- `@mastra/core/harness` — canonical runtime implementation
