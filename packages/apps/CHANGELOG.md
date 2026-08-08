# @agentproto/apps

## 0.3.0

### Minor Changes

- ea4313a: Add `mail-triage` app: a single-agent example that scans the inbox, categorizes unread mail, and applies triage actions (label, archive) via app-kit.

### Patch Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- Updated dependencies [47ca357]
- Updated dependencies [087f0ea]
- Updated dependencies [2b379e9]
  - @agentproto/app-kit@0.4.0
  - @agentproto/workflow@0.2.0

## 0.2.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/app-kit@0.3.2

## 0.2.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/workflow@0.1.1
  - @agentproto/app-kit@0.3.1

## 0.2.0

### Minor Changes

- b2debf0: Add illustrator agent and produce-cover workflow to the content-team app: a new team member that art-directs cover illustrations for articles with visual discipline (flat shapes, limited palettes, strong negative space, text-free prompts).

### Patch Changes

- 4252c81: Fix subpath export types pointing at nonexistent flat .d.ts files
- Updated dependencies [a0b94fd]
  - @agentproto/app-kit@0.3.0

## 0.1.1

### Patch Changes

- c850b1b: Infer anthropic for bare claude model ids; grant team agents their workspace tools
- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents
- Updated dependencies [e3bacf3]
  - @agentproto/app-kit@0.2.0
