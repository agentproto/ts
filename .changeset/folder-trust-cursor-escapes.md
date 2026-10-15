---
"@agentproto/adapter-claude-code-cloud": patch
---

Detect the first-run folder-trust prompt through the cursor-column escapes the claude TUI draws it with — normalize PTY output (CSI/OSC/lone-ESC → spaces) before every TUI regex, so `claude --cloud` no longer stalls to its 120s timeout in a never-trusted folder. The PTY timeout error now carries a short ANSI-stripped tail of the stalled screen.
