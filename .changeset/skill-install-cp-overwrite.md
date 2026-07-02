---
"@agentproto/cli": patch
---

fix(cli): `install skill` (and `onboard`) no longer crash overwriting an existing skill whose dest is a file or symlink. `fs.cp` cannot overwrite a non-directory with a directory (ERR_FS_CP_DIR_TO_NON_DIR); the hermes and claude-desktop installers now remove the dest before copying, and skip symlinked skill dirs (deliberate dev links) with a clear message instead of clobbering them.
