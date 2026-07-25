---
"@agentproto/model-catalog": patch
"@agentproto/runtime": patch
---

fix(runtime,model-catalog): strip the anthropic vendor prefix from the wire model for anthropic-native adapters. A route-qualified id like `anthropic/claude-sonnet-4-5` leaked its vendor prefix to the `claude` ACP wrapper / claude-sdk's `ANTHROPIC_MODEL`, which resolve only the bare Anthropic id. Add `stripAnthropicNativeVendor` (collapses only a direct-anthropic ref to its bare product) and gate it at the wire boundary on the resolved adapter's `provider === "anthropic"`, so gateway-routed and `derived-from-model` adapters keep their `vendor/product` id.
