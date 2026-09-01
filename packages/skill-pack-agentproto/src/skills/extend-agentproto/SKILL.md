---
name: extend-agentproto
description: "Extend the agentproto daemon with new capabilities — bundle agents and workflows as APPs, build multi-stage session pipelines, import external MCP servers, install adapters, add auth profiles and presets, or author agent packs. Triggers: build an app, workflow pipeline, import MCP, install adapter, agent pack, extend daemon."
---

# extend-agentproto

Make the platform do new things. Each row names the primitive or playbook that
owns the mechanics; open it for tool signatures and recipes.

| I want to… | Open |
| ---------- | ---- |
| Bundle agents+workflows+UI as an APP | `ap-apps`, then `pb-build-app` |
| Build multi-stage session pipelines | `ap-workflows` |
| Register and call external MCP servers | `ap-import-mcp` |
| Install agent CLI adapters | `ap-adapters` |
| Add auth profiles / harness presets | `ap-models-auth` |
| Author and import agent PACKS (company/agency/knowledge) | `pb-build-pack` |

Surface choice in one line: MCP tools for interactive ops, the `agentproto`
CLI for long-lived processes, plain HTTP GETs for cheap checks.

Start here if the capability should be reusable and self-contained: it is an
APP (`ap-apps` → `pb-build-app`). If it is a one-off multi-session run, it is
a workflow (`ap-workflows`).
