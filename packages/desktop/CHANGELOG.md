# agentproto-desktop

## 0.3.0

### Minor Changes

- f6593d4: Add structured-question support. Sessions awaiting a structured question (e.g., context-continuity's continue-fresh/keep-going prompt) now display question text and clickable option buttons in a dedicated banner. Answer dispatch is wired into all prompt-turn seams (sendPrompt, enqueuePrompt, dispatchQueuedPrompt), intercepting exact option matches (case-insensitive) and routing them to their registered handlers. Unmatched prompts fall through to normal turn execution, preserving fallback behavior for unsupported or conversational replies. Context-continuity ask mode now tracks the acknowledgment percentage to suppress re-asking until context grows further. Desktop shell renders the QuestionBanner above the composer and displays question hints in the session rail with full text in tooltip.

## 0.2.5

### Patch Changes

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.2.4

### Patch Changes

- 3740171: Fix transcript debounce-split bug where mid-word fragments split by interleaved tool-call records would create artificial paragraph breaks. Adds `partial` flag to track explicitly unterminated flushes and updates reducers to rejoin text-delta records that haven't reached newline termination, keeping sentences coherent across tool interactions.

## 0.2.3

### Patch Changes

- 41e36f4: Settle orphaned tool calls at turn-end. Adapters like Hermes can end a turn while omitting tool-result events for nested/parallel calls, leaving them stuck in "pending" state in UI consumers. This change synthesizes tool-result events with null values before the turn-end is recorded, ensuring transcript replay sees completed tool cards.

## 0.2.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.2.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.

## 0.2.0

### Minor Changes

- 7aeec64: Scaffold agentproto-desktop — a native desktop shell (Tauri v2 + React) over the agentproto daemon, with a Rust core exposing daemon_health / daemon_sessions and a first live session-list screen.
- 066c06f: Desktop shell slice 2: token-driven KitProvider (ported design-kit), AppShell with workspace-grouped session rail, live transcript via the ported conversation reducer, tabbed browser pane, git changes/diff panel, single native titlebar, and a composer that drives sessions (daemon_prompt).
- 8591390: Add Files tree tab and drag-to-resize left rail to desktop shell
- 1c329c2: Add file viewer (read_file) and PR status tab (pr_status) to desktop shell
- 1a53ecc: Add live browser iframe embed, Files diff view, and ⌘K command palette to desktop shell
