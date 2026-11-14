---
"@agentproto/runtime": patch
---

Installed app panels: cache the public-base html per (file, base) so every MCP server built for the same base shares one string, instead of each server holding its own copy of every panel (about 110 MB of duplicated html on a daemon with 17 live servers). Variants per file are capped (least recently used out) and a concurrent miss shares one read.
