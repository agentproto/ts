---
"@agentproto/runtime": patch
---

Fix bundling of node:sqlite dynamic imports by using a computed specifier to prevent esbuild from stripping the node: prefix. Most builtins work without it, but node:sqlite has no unprefixed name.
