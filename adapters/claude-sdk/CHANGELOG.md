# @agentproto/adapter-claude-sdk

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
