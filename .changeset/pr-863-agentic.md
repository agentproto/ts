---
"agentproto-vscode": minor
---

Add chip-pickers support for session effort switching and restart-with-overrides. Introduces three new daemon client methods: `setSessionEffort()` for live effort changes, `setSessionPosture()` for live posture/mode changes, and `restartSessionWithOverride()` for restart-bound axis switches (wallet, harness, route). Includes pure-logic module (`chipPickers.logic.ts`) for testable decision-making on which axes switch in-place vs require restart. Adds effort chip to composer bar with proper conditional display and comprehensive test coverage.
