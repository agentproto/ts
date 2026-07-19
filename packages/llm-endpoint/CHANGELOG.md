# @agentproto/llm-endpoint

## 0.4.0

### Minor Changes

- a7599f4: Add inbound + edge/WAF access gates and fix /v1 pack-path normalization

### Patch Changes

- @agentproto/providers-store@0.3.1

## 0.3.0

### Minor Changes

- d4187ca: Route requesty through the llm-endpoint proxy with a committed transparent pack
- e4a5527: Replay a turn once when a stripped-thinking provider returns an empty turn

### Patch Changes

- Updated dependencies [719771e]
  - @agentproto/providers-store@0.3.0

## 0.2.1

### Patch Changes

- @agentproto/providers-store@0.2.1

## 0.2.0

### Minor Changes

- e72a250: Add pack-based model registry, tool-control headers, and local config support
- 4fce66e: Add pack registry, tool-header wildcard filtering, and vscode VSIX packaging script
- f869759: Add Responses API facade, transparent chat/completions surface, and direct OpenAI provider

### Patch Changes

- dc24713: Export trimTools and ToolTrimOptions from index for testability
- Updated dependencies [8e7353a]
  - @agentproto/providers-store@0.2.0

## 0.1.0

### Minor Changes

- 363c944: Add @agentproto/llm-endpoint as a proper workspace package with exportable start()/server
