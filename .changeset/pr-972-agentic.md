---
"@agentproto/cli": patch
"agentproto-vscode": patch
---

Wire grok-cli adapter into the CLI package's static CATALOG and VS Code extension's icon mappings. The adapter was previously installable via `agentproto install` but invisible to adapter discovery UI (MCP adapter_list, VS Code Harnesses panel) because it was only found via workspace scan, not the bundled catalog. Adds catalog entry with xAI branding metadata, SVG icon, and adapter icon → file mapping for VS Code.
