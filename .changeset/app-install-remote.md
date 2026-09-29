---
"@agentproto/app-kit": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Install apps from a git URL or a `.agentapp` and keep them in sync. `@agentproto/app-kit` now exports the AIP-53 bundle core (`packApp`, `unpackApp`, `aggregateSha256`, `collectFiles`, `isManifest`, `AgentAppPackError`), lifted out of the CLI with no behaviour change (unpack additionally refuses a manifest listing paths outside the bundle root). The runtime's `app_install` accepts exactly one of `{dir}`, `{url, ref?, subdir?}` (shallow git clone) or `{url}`/`{file}` for a `.agentapp`, installs remote sources under `<state dir>/apps/<slug>` with an atomic swap that keeps the data dir and survives a failed install, and records `InstalledApp.source` (`local` / `git` sha / `agentapp` sha256+version), surfaced by `app_list` and `app_status`. New `app_resync {appId}` compares the source (`git ls-remote` / re-downloaded bundle digest) and reinstalls when it changed. The CLI gains `agentproto app install <dir|url|file.agentapp> [--ref] [--subdir]` (URL/bundle installs are executed by the daemon) and `agentproto app resync <appId>`; `app pack`/`unpack` are now thin wrappers over app-kit.
