---
name: drive-agents
description: "Route agent-driving tasks to agentproto primitives. Use when you need to spawn a session, send a follow-up prompt, read what an agent did, wait for one or many to finish, kill or clean up, gate completion, run a shell command, or drive an interactive TUI. Triggers: spawn agent, prompt session, read output, wait for agent, kill session."
---

# drive-agents

Route every step of spawn → prompt → read → wait → lifecycle here. Each row
names the primitive that owns the mechanics; open it for tool signatures and
recipes.

| I want to… | Open |
| ---------- | ---- |
| Spawn a session for an agent CLI | `ap-spawn-agent` |
| Send a follow-up prompt or queue work | `ap-prompt-agent` |
| See what an agent did so far | `ap-read-output` |
| Wait for it / them to finish, blocking my turn | `ap-wait-fanin` |
| Wait without blocking, notified later | `ap-wait-durable` |
| Kill, archive, restart, or GC sessions | `ap-lifecycle` |
| Gate its completion before calling it done | `ap-policies` |
| Run a one-shot shell command | `ap-run-command` |
| Drive an interactive TUI | `ap-terminal` |

End-to-end instead of piecemeal?

- One agent, briefed and verified start-to-finish → `pb-new-agent-session`.
- Several agents in parallel with fan-in → `pb-supervise-parallel-mission`.

Start here if you are unsure which primitive you need: pick the row matching
the verb in your goal — spawn, prompt, read, wait, kill, gate, run, terminal —
and open that skill.

Golden rule: never wait with a shell sleep-poll loop — use session_monitor or
`agentproto sessions wait` only; a killed poll loop corrupts sessions.
