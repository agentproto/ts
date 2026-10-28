---
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Show AIP-45 mode changes and typed agent prompts in the desktop and VS Code conversation views. A `mode-changed` event renders as a quiet "Mode: plan -> execute" row (with "by agent" and the reason when present). A `question` prompt shows its choices as buttons and takes a free-text answer, and a `plan-approval` prompt shows the plan with Approve and Reject (optional reason). Answers go through the existing permission response path, with the text carried as `feedback`. Prompts and events from older servers render as before.
