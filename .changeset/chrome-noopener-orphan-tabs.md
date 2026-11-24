---
"@agentproto/adapter-browser-chrome": patch
---

chrome-live no longer leaves orphan `about:blank` tabs in the agent window. A new tab is opened from one of the agent's own tabs with `window.open("about:blank", "_blank", "noopener")`, and the adapter read a `null` answer as "blocked". With `noopener` the HTML spec makes `window.open` return `null` even when the tab opened, so every new tab left one blank tab per agent tab already open, then fell back to `Target.createTarget`. The value is no longer read: the new tab is found by its `openerId`, claimed as soon as it is seen (two tabs opened at once never take the same one), and when the script ran but no tab appeared the adapter falls back at once instead of trying again from every agent tab.
