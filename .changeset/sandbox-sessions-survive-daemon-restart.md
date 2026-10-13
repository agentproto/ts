---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-e2b": minor
"@agentproto/cli": minor
---

Sandbox sessions now survive a host daemon restart. Shutdown detaches provider-box sessions instead of killing them: the host closes its connection only, leaves the box and its agent session running, persists a re-attach record (`sandboxReattach`, row stays `running` with `hostDetached`), and asks the provider to extend the box lifetime to 60 minutes (`BootedSandbox.extendTimeout`, implemented for e2b via `setTimeout`; providers cap it, a rejected request leaves the existing lifetime). At boot, before eager resume, the daemon reconnects through `SandboxProvider.connect`, replays the events the box produced meanwhile from the saved transcript seq, and re-binds the same session id without re-prompting the agent. A box that no longer exists ends the row with the new `sandbox_gone` end reason and a `gone` ledger entry. `/health` and `daemon_health` gain `sandboxSessions`, and `agentproto daemon restart`/`stop` report how many sandbox sessions were detached and re-attached. Explicit kill, idle reap and cost kill still tear the box down; device-paired sandboxes and local sessions are unchanged.
