---
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": patch
"@agentproto/adapter-hermes": patch
---

Fix model selection for hermes + `wait_for_any` missing a finished fast turn.

- **Model selection (`AgentCliModels.apply`)**: hermes ignores the model passed
  via the ACP session config, so `start_agent_session({ model })` silently ran
  the agent's own default. Adds a declarative per-adapter strategy: `"config"`
  (default — ACP `set_config_option`, e.g. claude-code) vs `"command"` (sends a
  drained `/model <id>` control turn after `newSession`, best-effort). hermes is
  marked `apply: "command"` and now honors the requested model (verified via
  `~/.hermes/state.db`). hermes default models switched to cheap OpenRouter
  coders (`z-ai/glm-5.2`, `deepseek/deepseek-v4-pro`).

- **`wait_for_any` fast-turn race**: a session that completed its turn before the
  wait subscribed left no persisted signal (`status:running`, `busy:false`,
  `awaitingInput:false`), so the wait blocked until timeout. Adds a
  `turnsCompleted` counter + mirrors `busy` onto the public `SessionDescriptor`,
  and a sync-check branch (`turnsCompleted>0 && !busy && running` → fast-return
  `turn-end`). A never-run session has `turnsCompleted:0`, so it is not mistaken
  for done.
