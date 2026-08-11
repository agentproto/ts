---
"@agentproto/runtime": minor
agentproto-vscode: patch
---

Enhance session resumption transparency by distinguishing "no context available" from "partial context recovered from daemon transcript". The new `ResumeContextDigestResult` interface provides explicit context-availability tracking, enabling callers to display honest restart banners about what was actually recovered.
