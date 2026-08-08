---
"agentproto-vscode": minor
---

Implement Design B — attention-first sessions webview redesign. The seven status tabs are replaced by five fixed-priority attention sections (Needs you → Running → Attention → Quiet → Earlier). Navigation collapses to two axes: a project rail (All + one chip per workspace with "awaiting" indicators) and an Agents/Auto segmented control for human- vs machine-origin session filtering. Auto lane groups into Gate reviews, Crons, and Commands, with consecutive cron runs collapsing into a single row with a count. Supports progressive loading via GET /sessions/summaries for bounded first paint.
