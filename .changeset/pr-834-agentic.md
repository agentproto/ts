---
"agentproto-vscode": patch
---

Add conversation book view — a redesigned reading surface that groups conversation turns into chapters (split on user prompts) with folding, duration tracking, and step aggregation. The book is the default view for structured sessions; users can toggle back to the raw transcript via a header button. All book logic is pure, testable, and injected into the webview alongside existing helper modules.
