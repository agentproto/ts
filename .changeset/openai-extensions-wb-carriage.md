---
"@agentproto/apps": minor
"@agentproto/mcp-server": minor
"@agentproto/runtime": minor
---

OpenAI MCP-extensions carriage (W-B): `AgnoMcpApp` gains an optional namespaced
`openai` descriptor (§3.2 tool/resource metadata + icons); `performInstall`
carries the app-kit-normalized `ui.extensions.openai` through `InstalledApp.ui`
structurally; `registerMcpApps` serializes the declared entrypoints and icons
under the generated UI tool's `_meta["openai/ui"]` and the display
available/preferred modes under the `ui://` resource's `_meta["openai/ui"]`;
`registerUiResource` accepts extra namespaced `meta` refused for the canonical
`ui` key. Apps without `ui.extensions.openai` install and serve byte-identically.
