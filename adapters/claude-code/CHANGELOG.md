# @agentproto/adapter-claude-code

## 1.1.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

### Patch Changes

- cae6a45: Pin @agentclientprotocol/claude-agent-acp spawn to 0.59.0 for reproducibility
- Updated dependencies [dd3386d]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0
  - @agentproto/provider-presets@0.4.0

## 1.0.1

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 1.0.0

### Major Changes

- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns

### Minor Changes

- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 76747fc: fix(claude-code): subscription auth injects CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_AUTH_TOKEN
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

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- abb49cf: add DeepSeek gateway preset to provider-presets and adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes

### Patch Changes

- 6a5c41c: Make model set_config_option non-fatal; fix claude-code stale model list
- 0ba77de: Add --pack fan-out install for skill CLI
- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
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

## 0.1.1

### Patch Changes

- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 1bf295b: Fix claude-code plan/accept-edits/bypass-permissions modes via CLAUDE_CONFIG_DIR override
- Updated dependencies [06132bc]
- Updated dependencies [2d1434a]
- Updated dependencies [1bf295b]
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [78d09e6]
- Updated dependencies [559cff3]
- Updated dependencies [06132bc]
- Updated dependencies [c2b6779]
- Updated dependencies [e27fc94]
- Updated dependencies [837967a]
  - @agentproto/driver-agent-cli@0.3.0

## 0.1.0

### Minor Changes

- 6587000: Honor model and add effort to start_agent_session for claude-code adapter

### Patch Changes

- Updated dependencies [04c9a5a]
- Updated dependencies [adf4583]
- Updated dependencies [c6a90e2]
- Updated dependencies [7542339]
- Updated dependencies [5c2063e]
- Updated dependencies [0022b2a]
- Updated dependencies [6587000]
- Updated dependencies [04c9a5a]
  - @agentproto/driver-agent-cli@0.2.0
