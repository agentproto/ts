# Sandbox — GitHub Copilot CLI

Copilot CLI can modify files and run shell commands on the machine it runs on.
Its own trust boundary is the "trusted directory" it is launched from: it asks
for confirmation before touching files outside the directory it was started in.

`@agentproto/adapter-copilot-cli` is a standard ACP adapter, so the daemon's
OS-level confinement (`AgentCliStartOptions.commandSandbox`, Seatbelt on macOS /
bwrap on Linux) wraps the spawned `copilot` process tree exactly like any other
agent CLI. When that is enabled, out-of-workspace reads/writes are denied by the
kernel, not merely by Copilot's own heuristics.

Tool permissions inside a session are negotiated over ACP
(`session/request_permission`); the agentproto client auto-answers by default,
so enable `commandSandbox` (and/or Copilot's own local sandbox via
`/sandbox enable`) when the agent should be constrained.
