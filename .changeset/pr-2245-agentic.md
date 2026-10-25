---
"@agentproto/acp": patch
"@agentproto/action": patch
"@agentproto/agency": patch
"@agentproto/agent": patch
"@agentproto/assembly": patch
"@agentproto/auth": patch
"@agentproto/canvakit": patch
"@agentproto/cli": patch
"@agentproto/code": patch
"@agentproto/collection": patch
"@agentproto/company": patch
"@agentproto/design": patch
"@agentproto/driver": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/driver-browser": patch
"@agentproto/extension": patch
"@agentproto/governance": patch
"@agentproto/identity": patch
"@agentproto/intent": patch
"@agentproto/io": patch
"@agentproto/knowledge": patch
"@agentproto/lesson": patch
"@agentproto/manifest": patch
"@agentproto/mcp-server": patch
"@agentproto/office": patch
"@agentproto/operator": patch
"@agentproto/pack": patch
"@agentproto/persona": patch
"@agentproto/playbook": patch
"@agentproto/policy": patch
"@agentproto/review": patch
"@agentproto/role": patch
"@agentproto/routine": patch
"@agentproto/runner": patch
"@agentproto/runtime": patch
"@agentproto/sandbox": patch
"@agentproto/secrets": patch
"@agentproto/skill": patch
"@agentproto/storage": patch
"@agentproto/tool": patch
"@agentproto/wallet": patch
"@agentproto/work": patch
"@agentproto/workflow": patch
"@agentproto/workspace": patch
---

Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
