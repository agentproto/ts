---
"@agentproto/runtime": minor
---

The daemon serves an approval's files to its page: `GET /approvals/:id/attachments` lists what `preview.attachments` names (name, size, viewer, url, plus a `problems` list with short reason codes) and `GET /approvals/:id/attachments/:name` serves one file. Only four content types are ever sent (HTML and SVG go out as `text/plain`), with `nosniff`, `no-store` and a sandboxing CSP; a file over 25 MB is a `too-large` problem and a 413. An approval link reaches both routes through a new `files` action, same refusals as `read`. The Telegram bridge and these routes share one folder resolver.
