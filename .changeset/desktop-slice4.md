---
"agentproto-desktop": minor
---

Desktop slice 4 — a read-only file viewer (click a file in the Files tab to open it, backed by a size-guarded Rust `read_file` command) and a live PR surface in the Changes panel's PR tab (branch → GitHub PR number/title/state/checks via a Rust `pr_status` command shelling `gh pr view`). The session cwd now flows to `ChangesPanel` so the PR tab resolves the real repository.
