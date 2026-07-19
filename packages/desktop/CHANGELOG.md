# agentproto-desktop

## 0.2.0

### Minor Changes

- 7aeec64: Scaffold agentproto-desktop — a native desktop shell (Tauri v2 + React) over the agentproto daemon, with a Rust core exposing daemon_health / daemon_sessions and a first live session-list screen.
- 066c06f: Desktop shell slice 2: token-driven KitProvider (ported design-kit), AppShell with workspace-grouped session rail, live transcript via the ported conversation reducer, tabbed browser pane, git changes/diff panel, single native titlebar, and a composer that drives sessions (daemon_prompt).
- 8591390: Add Files tree tab and drag-to-resize left rail to desktop shell
- 1c329c2: Add file viewer (read_file) and PR status tab (pr_status) to desktop shell
- 1a53ecc: Add live browser iframe embed, Files diff view, and ⌘K command palette to desktop shell
