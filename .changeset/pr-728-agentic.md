---
"@agentproto/provider-presets": minor
"@agentproto/runtime": major
---

Add operator-configurable custom routes via `~/.agentproto/routes.json` and new xAI Anthropic-compatible gateway preset.

**@agentproto/provider-presets:**
- New `xai-anthropic` preset for xAI's live Anthropic-compatible Messages endpoint

**@agentproto/runtime (BREAKING):**
- `registerBuiltinRoutes()` is now async (`Promise<void>` instead of `void`). All callers must await this function. This is a breaking change for any external code using this exported API.
- Operator routes from `~/.agentproto/routes.json` are loaded at daemon boot, after built-in routes, allowing operators to override defaults
- Routes config includes security features: literal secret key detection prevents credentials from being stored on disk
