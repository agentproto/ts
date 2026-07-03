---
"@agentproto/acp": patch
"@agentproto/adapter-claude-code": patch
---

Apply the claude-code model via ACP session config without failing the spawn.

`session/set_config_option(configId:"model")` used to reject `newSession`
whenever the claude-agent-acp wrapper couldn't resolve the requested model id —
surfacing as an opaque `agent_start: spawn failed — Internal error` and killing
the whole session (agentproto#186). The wrapper validates the value against the
concrete option ids it advertises per session (e.g. `default`, `opus[1m]`,
`sonnet`, `claude-sonnet-5`, `haiku`) and returns a JSON-RPC `-32603` whose real
reason lives in `error.data.details` (`Invalid value for config option model:
<id>`).

The model apply is now best-effort like effort: a value the wrapper can't
resolve is logged — loudly, with the requested id and the server's captured
reason — and the session continues on the agent's default model instead of
crashing. Valid ids and aliases still pin correctly. The claude-code manifest's
stale model list (`claude-sonnet-4-6` default, `claude-opus-4-7`,
`claude-opus-4-6`) was corrected to ids the current wrapper accepts.
