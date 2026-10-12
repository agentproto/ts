---
"@agentproto/workflow-loader": patch
---

Install the entry-graph hot-reload resolve hook through `module.registerHooks()` (synchronous, in-thread) when the runtime has it (Node >= 22.15), so module resolution never touches the off-thread async loader channel that `module.register()` requires — the channel failed dynamic imports have been observed to leak MessagePorts on under Node 22. Keep the `module.register()` data-URL hook as a compatible fallback for older supported Nodes (engines floor 20.9), sharing one pure URL-rewrite helper between both paths so entry-graph versioning behavior is unchanged; the fallback limitation (channel + leak exposure remains on pre-22.15 runtimes) is documented. Add real-process regressions: hook behavior under both registration paths, versioned-import propagation through the fallback when `registerHooks` is absent, and stable async-handle counts across 500 repeated missing dynamic imports with the hook installed.
