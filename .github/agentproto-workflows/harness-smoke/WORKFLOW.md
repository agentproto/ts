---
name: Adapter harness bake-off smoke
id: adapter-harness-smoke
description: Adapter-agnostic one-step smoke turn — spawns the adapter named in $input.adapter and asks it to reply with exactly `HARNESS OK`. Drives the whole harness matrix from one file.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: reply-ok
    kind: agent
---

# Adapter harness bake-off smoke

The manifest mirrors the entry's step graph for governance (AIP-15
`reconcileEntry`); the entry (`entry.mjs`) is the source of truth for the
runtime `agent` step, which is only reachable via an entry module.

Unlike the lane smoke (`../smoke/`), this workflow reads the adapter slug from
the run INPUT (`$input.adapter`) instead of hard-coding one — so the harness
matrix (`.github/workflows/adapter-harness-test.yml`) drives every adapter ×
auth/model combo through this single file. Each run spawns one session and asks
it to reply with exactly `HARNESS OK` and nothing else, using no tools — the
minimal proof that a given adapter/auth/model combo produces assistant output
headless.
