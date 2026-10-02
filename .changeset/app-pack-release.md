---
"@agentproto/app-kit": minor
"@agentproto/cli": minor
---

`.agentapp` packing honors an APP.md `package` block (`include` / `exclude` globs, `stripBuild`) and stages only the selected files. New `agentproto app pack --release` builds the UI first, drops dev-only files (UI sources, docs, data, scripts, logs, source maps, env files), fails when the built `ui.path` is missing, and strips `ui.build` from the packed APP.md.
