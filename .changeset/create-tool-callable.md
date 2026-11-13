---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/app": minor
---

A tool authored by `create_tool` can now be run by an agent, in the same session that created it: the new daemon verb `created_tool_call` is in every session's tool list from the start. Every call needs a human-approved, single-use `created_tool_call` approval bound to the tool id, the exact arguments and a hash of the tool's TOOL.md, DRIVER.md and every file in its bundle directory (`.agentproto/tools/<id>/`, where the driver's script must live: an argv or `cwd` pointing elsewhere is refused), requested by the calling session; the TOOL.md `approval` class does not lift it. Only tools carrying the `create_tool` authoring marker run this way. `agentproto agent create --grant <action>` (repeatable) and `create_agent`'s `grants` write `actions.granted`; nothing is granted by default, and `create_agent` only lets a calling agent grant actions its own manifest holds.

The bundle is read once, hashed, and run from a private snapshot, so a script edited after the approval is refused and cannot swap in during the run. `approval_request` for this kind ignores the caller's `title` and `preview`: the daemon builds them from the real tool id, driver command, args, files and hash, and refuses a payload whose hash is not the tool's current one.
