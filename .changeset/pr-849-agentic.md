---
"agentproto-vscode": minor
---

Add a color picker UI for workspace colors in the Sessions webview. Users can now click the swatch on a workspace chip to override its color via a popover with arrow-key navigation, Enter/Escape keyboard support, and click-outside dismiss. Colors persist via VS Code globalState and hydrate on extension startup. Includes comprehensive type-safe validation, accessibility features (ARIA labels, roving tabindex), and end-to-end tests.
