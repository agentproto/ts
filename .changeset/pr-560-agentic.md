---
"agentproto-vscode": minor
---

Extract pure rendering logic from transcript panel chrome into testable functions (`harnessGlyph`, `accessIdentity`, `contextGauge`), enabling reuse and unit testing of UI helpers. Add new header glyph icon for harness identity, replace segmented view toggle with single terminal button, display context-window gauge as visual ring with color levels (FIX 2/5), and move auth identity to cost popover for better header space efficiency (FIX 3/4).
