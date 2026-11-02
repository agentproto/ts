---
"@agentproto/worktree": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/apps": patch
---

`branch gc --include-reviewed`: a second deterministic pass, `dep-bump`, reclaims a guard-refused tip with an agreeing `obsolete` or `superseded` verdict when every line it adds is in `pnpm-lock.yaml` or a `.changeset/*.md`, or is a `package.json` dependency spec (or `version`) that base already declares at an equal or higher semver lower bound. It is computed from git objects only. Any other line keeps the tip in the human queue, and `depBumpRefusal` names the first unexplained line. The pass is recorded as `guard: "dep-bump"` + `depBump` on the apply outcome and the restore log, and listed under "Auto-passed by dep-bump" in the maintain report. It is on by default, and `requireOperatorBelowGuard` turns it off together with verified-pr.
