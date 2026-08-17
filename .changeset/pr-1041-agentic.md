---
"@agentproto/cli": minor
---

Add `--host` option and `ui.tools` allowlist enforcement to `agentproto app serve`. The `--host` option allows binding to addresses beyond loopback (default `127.0.0.1`), with a stderr warning when used. The `ui.tools` allowlist is read from APP.md frontmatter, providing a second layer of defense: when absent, all tools are allowed (backward compatible); when explicitly empty, all tools are blocked; otherwise, only listed tools are forwarded. The distinction between absent and empty allows apps to opt into explicit allowlisting while maintaining backward compatibility with apps predating this feature.
