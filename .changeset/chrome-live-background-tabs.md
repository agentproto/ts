---
"@agentproto/adapter-browser-chrome": patch
---

`chrome-live` opens agent tabs in the background: every `Target.createTarget` carries `background: true`, and the fallback no longer calls `Target.activateTarget` on one of the agent's tabs first. A new tab never takes the focus from another window; the existing window check still closes a tab that lands in the wrong window.
