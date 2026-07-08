# @agentproto/workflow-runtime

## 0.3.0

### Minor Changes

- 7aaf24a: Add AgentStep.cwd selector and new worktree provision/gate/cleanup tools

### Patch Changes

- f8ebe41: Pass agent steps through the compiler unchanged
- 2154ed5: Pass agent steps through the compiler unchanged

## 0.2.0

### Minor Changes

- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 987db7b: Add PipelineStep: no-barrier staged concurrency over N items through K stages
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation

### Patch Changes

- a5c4701: Add package README and CLI concepts/workflows docs page

## 0.1.2

### Patch Changes

- Updated dependencies [78ac79e]
- Updated dependencies [dc870cf]
- Updated dependencies [2186e9e]
  - @agentproto/tool@0.2.0
  - @agentproto/driver@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/driver@0.1.1
  - @agentproto/tool@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/driver@0.1.0
  - @agentproto/tool@0.1.0
