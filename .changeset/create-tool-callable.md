---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

A tool authored by `create_tool` can now be run by an agent, in the same session that created it: the new daemon verb `created_tool_call` is in every session's tool list from the start. Every call needs a human-approved, single-use `created_tool_call` approval bound to the tool id, the exact arguments and a hash of the tool's TOOL.md and DRIVER.md, requested by the calling session; the TOOL.md `approval` class does not lift it. Only tools carrying the `create_tool` authoring marker run this way. `agentproto agent create --grant <action>` (repeatable) and `create_agent`'s `grants` write `actions.granted`; nothing is granted by default, and `create_agent` only lets a calling agent grant actions its own manifest holds.
