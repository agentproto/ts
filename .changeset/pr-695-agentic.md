---
"agentproto-vscode": patch
---

Add Local Router UI and daemon client methods for endpoint lifecycle control. The Local Router appears as a top-level tree node in the auth profiles view, showing the daemon-supervised `@agentproto/llm-endpoint` proxy sidecar's lifecycle status (running, starting, stopped, error). Users can start/stop the proxy via context menu, and when running & healthy, the tree expands to show discovered models with catalog pricing cross-referenced. Three new daemon MCP verbs enable this: `llm_endpoint_status`, `llm_endpoint_start`, and `llm_endpoint_stop`.
