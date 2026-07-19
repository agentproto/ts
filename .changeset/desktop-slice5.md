---
"agentproto-desktop": minor
---

Desktop slice 5: three shell features. The browser pane is now a live `<iframe>` embed with an editable address bar, URL normalization, a back/forward/reload history stack, and a loading state (native webview remains a follow-up for sites that set X-Frame-Options). The Files tab renders a unified diff for modified files — driven by a new optional `diff` prop on `FilesPanel`, a +N/-N badge in the tree, and a Content/Diff toggle. A new autonomous shortcuts module adds a ⌘K command palette (fuzzy search over sessions + actions) plus ⌘F (focus rail filter) and ⌘1/⌘2/⌘3 tab switching.
