# @agentproto/mcp-app-host

## 0.1.1

### Patch Changes

- 639892d: Test-only: the `mountMcpApp` ui/initialize test now polls for the reply instead of sleeping a fixed 20ms, which flaked on loaded CI runners.

## 0.1.0

### Minor Changes

- f12f006: New package: framework-free MCP Apps host over the official ext-apps AppBridge — transport-agnostic core (`createMcpAppHost`) with pre-ready send queueing and honest host capabilities, plus a browser DOM adapter (`mountMcpApp`) that mounts a `ui://` resource in a sandboxed srcdoc iframe with its CSP.
