---
name: cheap-coders
description: "Route code work to cheap capable models through agentproto instead of expensive Claude. Use when you want hermes sessions on OpenRouter models (glm, deepseek, kimi, qwen) or need to pick the right adapter and auth profile for a low-cost coding worker. Triggers: cheap model, glm, deepseek, kimi, openrouter, hermes adapter, cheap coder."
---

# cheap-coders

Route code work to cheap capable models instead of expensive Claude. Each row
names the primitive that owns the mechanics; open it for tool signatures and
recipes.

| Decision | Open |
| -------- | ---- |
| How to spawn and route models | `ap-spawn-agent` |
| Auth profiles, presets, model catalog, usage | `ap-models-auth` |
| Which adapter CLIs exist / how to install | `ap-adapters` |

Adapter choice:

- **hermes** — for cheap OpenRouter models: glm, deepseek, kimi, qwen.
- **claude-code / claude-sdk** — when the model needs built-in tools without
  MCP wiring.

Model identities via OpenRouter:

- `z-ai/glm-5.3-flash` — fast, cheap.
- `deepseek/deepseek-v4-pro` — stronger.
- `moonshotai/kimi-k2.7-code` — code.

Route and bill through `access:{profileRef:'openrouter-env'}`; other profiles
exist (moonshot-api direct, etc.).

CRITICAL gotcha: hermes has NO built-in file/shell tools — always mount
`mcpServers:[{name:'agentproto',transport:'http',ref:'http://127.0.0.1:18790/mcp'}]`
at spawn or the agent can only chat.

Start here if you just need a cheap refactor or grunt-work run: hermes +
`z-ai/glm-5.3-flash` + the openrouter-env profile; mechanics via
`ap-spawn-agent`.
