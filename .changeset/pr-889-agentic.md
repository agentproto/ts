---
agentproto-vscode: minor
---

Implement functional model restart modal and refactor sessions webview UI for compactness. The model switch now performs an actual session restart with the new model instead of just showing an informational message. Workspace color has been moved to the dot indicator via CSS variable for cleaner layout. Status indicators are condensed to icons and numbers to improve space efficiency while preserving full context via tooltips.
