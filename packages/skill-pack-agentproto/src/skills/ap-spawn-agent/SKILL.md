---
name: ap-spawn-agent
description: Spawn a new agentproto agent session (claude-code, hermes, ...) with a model, cwd, prompt, and optional MCP tool access. Use when the user says "spawn an agent", "start a session", "launch claude-code on this task", "run hermes in the background", or "kick off a worker". Also covers listing already-running sessions before spawning a duplicate.
---

# Spawn an Agent

## When to use

The user wants a new, independent agent session doing bounded work in a
directory — a worker to delegate to, a background task runner, or a fresh
session for a subtask. Check `agent_sessions_list` first if there's any
chance a matching session is already running; spawning a second one on the
same cwd/task wastes a process.

## MCP tool: agent_start

```json
{
  "tool": "agent_start",
  "args": {
    "adapter": "claude-code",
    "model": "claude-sonnet-5",
    "cwd": "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio",
    "prompt": "Add input validation to the signup form in apps/agentik/web/src/app/signup — reject empty email and password < 8 chars, add a unit test.",
    "label": "signup-validation",
    "mcpServers": [
      { "name": "agentproto", "transport": "http", "ref": "http://127.0.0.1:18790/mcp" }
    ],
    "access": { "profileRef": "default" },
    "orchestrator": false,
    "mode": "background",
    "effort": "medium",
    "permissionHold": false,
    "worktree": false,
    "wait": false,
    "idempotencyKey": "signup-validation-2026-09-01",
    "dedupe": true
  }
}
```

Only `adapter`, `cwd`, and `prompt` are typically required; the rest are
tuning knobs. Use `agent_sessions_list` to see what's already running before
you spawn:

```json
{ "tool": "agent_sessions_list", "args": {} }
```

## CLI

```bash
agentproto sessions start claude-code \
  --cwd /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio \
  --model claude-sonnet-5 \
  --prompt "Add input validation to the signup form..." \
  --label signup-validation \
  --attach false \
  --orchestrator false \
  --mcp-servers-json '[{"name":"agentproto","transport":"http","ref":"http://127.0.0.1:18790/mcp"}]' \
  --options-json '{"effort":"medium"}' \
  --access-profile default
```

## HTTP

None. Spawning a session is MCP-tool/CLI-only — there is no daemon HTTP
route for `agent_start`.

## Gotchas

- **hermes has no built-in file/shell tools.** Unlike `claude-code` or
  `claude-sdk`, hermes ships with nothing but chat. If the task needs to
  read/write files or run commands, you MUST pass
  `mcpServers:[{name:'agentproto',transport:'http',ref:'http://127.0.0.1:18790/mcp'}]`
  at spawn time, or the agent can only talk, not act.
- `cwd` must be an **absolute host path** — a relative path fails the spawn
  outright.
- Give children **authentic, bounded tasks**. Sentinel prompts like "just
  repeat this token back to me" get refused by capable models as prompt
  injection — write a real task with a real goal and scope.
- Always set a distinct `label` so the session is identifiable later in
  `agent_sessions_list` / `session_list` — unlabeled sessions are hard to
  tell apart once several are running.
- `dedupe` + `idempotencyKey`: calling `agent_start` again with the same
  key + adapter + cwd within ~10 minutes returns the **same session**
  (`deduped:true`) instead of forking a second process — safe to retry a
  spawn call without fear of duplicates.

## Pointers

- agentproto — general daemon driving reference
- pb-new-agent-session — session-creation playbook
- ap-prompt-agent — sending follow-ups to the session you just spawned
- ap-read-output — reading what the spawned agent did
- ap-wait-fanin — waiting on multiple spawned sessions to finish
- drive-agents — routing agent-driving tasks to the right primitive
