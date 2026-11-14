---
"@agentproto/sandbox-computer": minor
---

The computer boot skips `npm i -g` when the image already carries the requested toolchain. It reads the baked `agentproto` version and the version of each `installPackages` entry in the CLI's own global tree, and skips the install when `cliVersion` and every extra are satisfied (`latest` or no tag accepts the baked version, an exact version must equal it; ranges and other dist-tags install). Previously any `installPackages` entry, such as the `@agentproto/adapter-opencode@latest` the runtime injects, forced a full install on every boot even on a fresh image, which cost 20 s to minutes and failed outright on a bad egress path. Anything missing, different or unreadable still installs the CLI and all extras together. The decision is logged in the boot diagnostics, the 300 s boot deadline is unchanged, and the new `forceInstall` option (`COMPUTER_FORCE_INSTALL=1`) restores the install on every boot.
