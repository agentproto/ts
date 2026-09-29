# @agentproto/mcp-app-host

## 0.1.2

### Patch Changes

- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).

## 0.1.1

### Patch Changes

- 639892d: Test-only: the `mountMcpApp` ui/initialize test now polls for the reply instead of sleeping a fixed 20ms, which flaked on loaded CI runners.

## 0.1.0

### Minor Changes

- f12f006: New package: framework-free MCP Apps host over the official ext-apps AppBridge — transport-agnostic core (`createMcpAppHost`) with pre-ready send queueing and honest host capabilities, plus a browser DOM adapter (`mountMcpApp`) that mounts a `ui://` resource in a sandboxed srcdoc iframe with its CSP.
