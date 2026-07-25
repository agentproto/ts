---
"@agentproto/runtime": major
"@agentproto/provider-presets": minor
---

Add operator-configurable custom routes via `~/.agentproto/routes.json` and a new `xai-anthropic` gateway preset.

**Breaking change (`@agentproto/runtime`):** `registerBuiltinRoutes()` is now `async` (`() => Promise<void>`, previously `() => void`), because it now also loads and validates operator routes from `~/.agentproto/routes.json` before returning. Any external caller must add `await`:

```diff
-registerBuiltinRoutes()
+await registerBuiltinRoutes()
```

Callers that do not await the returned promise will silently skip operator-route loading (built-in routes still register synchronously before the first `await` point, but overrides from `routes.json` will not be applied and no rejection will surface). All internal call sites in this repo have been updated.

`@agentproto/provider-presets` gains the `xai-anthropic` preset: an Anthropic-schema-compatible gateway pointed directly at xAI, for hosts that want to address Grok through the Anthropic wire format.
