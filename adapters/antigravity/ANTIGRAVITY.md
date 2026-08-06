---
name: antigravity
id: antigravity
description: Google Antigravity's headless CLI (`agy`) as an AIP-45 print/headless agent.
version: 0.1.0
bin: agy
install:
  - method: curl
    url: https://antigravity.google/cli/install.sh
version_check:
  cmd: agy --version
  parse: '(\d+\.\d+\.\d+)'
  range: ">=0.1.0"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
sandbox: ./SANDBOX.md
protocol: print
tags: ["antigravity", "agy", "google", "print", "agent-runtime", "coding"]
---

# Google Antigravity adapter

Wraps Google Antigravity's headless CLI, `agy`, as an AIP-45 agent CLI using
its documented headless command surface:

```sh
agy -p "Fix the bug" --output-format stream-json
```

Antigravity has **no ACP mode** (open feature request
`google-antigravity/antigravity-cli#31`), so this adapter is intentionally a
`protocol: print` (headless) arm rather than ACP — the same posture as the
`mastracode` adapter.

## The event schema is NOT Claude's

`agy`'s headless *flags* look just like Claude Code's (`-p`,
`--output-format stream-json`, `--continue`), which is a trap. Its *wire
events* are a different taxonomy — verified against the sample outputs at
[antigravity.google/docs/cli/headless](https://antigravity.google/docs/cli/headless):

```jsonc
{"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[…],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"…","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"…","usage":{…}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","usage":{…}}}
```

Each line is discriminated by an `event` field (not Claude's `type`), the
payload is nested under a matching key, the session id is a nested
`conversation_id`, and assistant text streams as incremental
`step_update.text_delta` fragments. Because none of that matches
`claude-stream-json`, the print arm carries a dedicated
`event_schema: "antigravity-stream-json"` mapper
(`packages/driver/agent-cli/src/protocol/print-arm.ts`).

## Auth

Keyring + Google Sign-In only — see [SECRETS.md](./SECRETS.md). You must run
`agy` interactively once to cache credentials before any headless run.

## Models

No fixed `models.allowed` is declared. `agy models` lists the current slugs
(Gemini 3.x, Claude, GPT-OSS); pass any of them through the adapter's `model`
option, which forwards to `agy --model <slug>`.
