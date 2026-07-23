---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add "Save as Favorite" functionality to capture and reuse preferred spawn configurations. New HTTP routes (POST/DELETE /user-presets) enable favorites authoring from VS Code, storing user presets with pinned spawn axes (adapter, model, route, effort, context) and location (cwd, skills) in ~/.agentproto/presets.json. Favorites are displayed in the spawn picker with star icon, enabling zero-input re-spawn with their pinned values.
