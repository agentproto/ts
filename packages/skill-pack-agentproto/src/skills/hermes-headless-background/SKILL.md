---
name: hermes-headless-background
description:
  "Delegate a task (audit, research, grunt-work) to a hermes session on a CHEAP
  model (glm-5.2/deepseek/kimi via OpenRouter) via DIRECT CLI, headless, in the
  background — WITHOUT the agentproto daemon or the MCP tools. Trigger this
  skill when the `mcp__agentproto__*` tools are absent from the session, when
  the user says \"launch a hermes/glm/deepseek agent in the background\", \"have
  a cheap model audit this while we keep going\", or when you want a cheap
  independent second opinion without burning the subscription. Complements
  agent-session-orchestration-agentproto (which, in contrast, assumes the MCP
  daemon)."
---

# Hermes headless in the background (no MCP daemon)

Real pattern, proven in session: run a **hermes** session on a cheap model
(OpenRouter) **via direct CLI**, headless, in the background, when the
agentproto daemon / the `mcp__agentproto__*` tools are NOT loaded in the
session (starting the daemon mid-session does not re-inject its MCP tools). You
talk to the `hermes` binary directly.

For the MCP path (daemon present) see
`agent-session-orchestration-agentproto` and `light-coder-orchestration`. This
skill = the **CLI fallback**.

## When to use it

- `ToolSearch "agentproto agent_start"` returns no `mcp__agentproto__*`.
- Task delegable to a cheap model (READ-ONLY audit, research, classification,
  bulk) — not frontier-judgment. See
  `feedback_delegate_to_cheap_agentproto`.
- You want to keep working while it runs → background.

## Recipe (end-to-end)

### 0. Pre-flight

```bash
which hermes            # e.g.: ~/.local/bin/hermes  (otherwise: stop)
hermes status 2>&1 | grep -iE "openrouter|provider|model"   # provider authed ✓ ?
```

`hermes --help`: key flags = `-z PROMPT` (headless one-shot), `-m MODEL`,
`--provider PROVIDER`, `--yolo` (no confirmations), `--resume SESSION`.

### 1. VERIFY THE MODEL FIRST (if the user named a specific model)

Frequent instruction: "if you can't get the model, you STOP".
`hermes model` is just an interactive picker — it does not list. The only
reliable test = a minimal probe + reading the `model` column of `state.db`:

```bash
export PATH="$HOME/.local/bin:$PATH"
hermes -z "Reply with exactly: PONG" -m z-ai/glm-5.2 --provider openrouter --yolo 2>&1 | tail -5
sqlite3 ~/.hermes/state.db "select model, estimated_cost_usd from sessions order by rowid desc limit 1;"
# The output MUST show model = z-ai/glm-5.2 (not the default deepseek-v4-pro). Otherwise → STOP.
```

Common model aliases (OpenRouter, ~$0.01-0.5/run): **`z-ai/glm-5.2`**
("glm-z2" / "zlm g2") and **`deepseek/deepseek-v4-pro`**. hermes IGNORES the
ACP session model but the adapter sends a `/model <id>` → hence the state.db
verification.

### 2. Write the brief to a file (not inline)

Long prompts break shell escaping. Write the brief to the scratchpad, pass it
with `"$(cat …)"`. For an AUDIT, the brief MUST contain:

- Explicit **READ-ONLY** ("Do NOT edit, deploy, git-write, DB-write").
- The context + your conclusions to be **CHALLENGED with evidence**
  (file:line), not swallowed.
- The list of files to read + the deliverables (verdict per claim, what's
  missing, an ordered plan).

### 3. Launch in the background

```bash
export PATH="$HOME/.local/bin:$PATH"; cd <repo-root>
hermes -z "$(cat <scratchpad>/brief.md)" -m z-ai/glm-5.2 --provider openrouter --yolo \
  > <scratchpad>/audit-out.log 2>&1
```

→ Bash tool with `run_in_background: true`. You are **notified at the end**
(`<task-notification>`). **Do NOT poll in a loop** (it burns YOUR context) —
wait for the notification, then `Read` the `.log`.

### 4. Read the result + the cost

```bash
sqlite3 ~/.hermes/state.db \
  "select model, estimated_cost_usd, input_tokens, output_tokens from sessions order by rowid desc limit 1;"
```

Useful columns of `sessions`:
`model, estimated_cost_usd, actual_cost_usd, input_tokens, output_tokens, cache_read_tokens, end_reason, tool_call_count`.

### 5. VERIFICATION SAFETY NET (non-negotiable)

A light model **hallucinates file:line references** and gets calculations
wrong. Before relaying: re-verify every actionable claim yourself (grep/sed
the cited file:line, redo the arithmetic). Relay with each claim marked
CONFIRMED / corrected / refuted.

## Gotchas (all encountered for real)

- **No `mcp__agentproto__*`** → no point launching the daemon mid-session to
  get them; MCP servers load at boot. Stay on direct CLI.
- **macOS has no `timeout`** (`command not found` → the whole line
  short-circuits, hermes never runs). Do NOT wrap with `timeout`.
  `hermes -z` is one-shot and exits on its own; to bound it, use the Bash
  tool's `timeout` or `run_in_background`.
- **The auto-mode classifier blocks cleartext secrets** on the command line
  (inline API key = "Credential Leakage"). Source from an env file:
  `export X="$(grep -E '^X=' envs/…/.env | cut -d= -f2-)"`, never the
  hardcoded value, never an `echo`/`cat` that materializes it in the
  transcript.
- **`state.db` is written ~after turn-end** — if the `model`/cost column looks
  empty, re-read after a short wait.
- The hermes default model (`~/.hermes`) is `deepseek-v4-pro`; if you don't
  pass `-m`, that's what runs. Always spell out `-m … --provider …`.
- Resume a session: `hermes -r <sessionId>` (id = `sessions.id` in state.db).

## Why

OpenRouter pay-per-token (cents), separate from the Claude subscription — for
grunt/audit/research, delegate here rather than burning an Opus/Sonnet
subagent. Reserve the `Agent` tool / Claude for frontier-judgment and the
verification pass.
