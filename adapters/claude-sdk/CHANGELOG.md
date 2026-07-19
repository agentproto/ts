# @agentproto/adapter-claude-sdk

## 0.4.1

### Patch Changes

- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0

## 0.4.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0
  - @agentproto/provider-presets@0.4.0

## 0.3.1

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.3.0

### Minor Changes

- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [1b282ab]
- Updated dependencies [1bdc055]
- Updated dependencies [7b53b8c]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [76747fc]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
- Updated dependencies [c430b9f]
- Updated dependencies [94a7e90]
  - @agentproto/provider-presets@0.3.0
  - @agentproto/driver-agent-cli@1.0.0

## 0.2.0

### Minor Changes

- 81e0292: Add first-party claude-sdk adapter (headless query() over ACP, model + base_url)
- e31c322: Add auth_token option, gateway model-tier pinning, and thinking flag to claude-sdk adapter
- 556b97e: Add Moonshot and OpenRouter gateway presets as AIP-45 modes on claude-sdk
- abb49cf: add DeepSeek gateway preset to provider-presets and adapters

### Patch Changes

- 2532d33: Scrub ambient Anthropic key under gateway base_url; provider-driven bearer auth
- 167b61f: Fix stalled gateway turn hanging forever with idle watchdog in #drive
- 10d1386: Tighten SDK-child stall watchdog default to 90s; correct root-cause docs
- a925b0b: Scrub leaked CLAUDE_CODE_USE_BEDROCK/\_VERTEX (etc.) toggles in gateway mode
- fad8300: Fix claude-sdk idle watchdog false-abort and frozen ring on long thinking turns
- 25358ad: Cast moonshot SDK test fakes at the boundary to fix BetaUsage drift
- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes
- Updated dependencies [6b8b023]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [b65ca15]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
- Updated dependencies [abb49cf]
- Updated dependencies [34cfcb5]
- Updated dependencies [2adc163]
  - @agentproto/driver-agent-cli@0.4.0
  - @agentproto/provider-presets@0.2.0
