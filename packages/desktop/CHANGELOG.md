# agentproto-desktop

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
