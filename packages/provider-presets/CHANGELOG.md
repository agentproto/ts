# @agentproto/provider-presets

## 0.4.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

## 0.3.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)

### Patch Changes

- 1b282ab: Loosen preset tests for xai openai-flavored proxy preset
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- c430b9f: Harden SSE reconnect sleep cancellation, poll-loop disposal guards, and webview hydration
- 94a7e90: Fix xAI preset: replace private codenames with real upstream model ids

## 0.2.0

### Minor Changes

- abb49cf: add DeepSeek gateway preset to provider-presets and adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes

### Patch Changes

- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
