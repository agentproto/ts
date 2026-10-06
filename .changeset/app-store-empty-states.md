---
"@agentproto/cli": minor
"@agentproto/apps": patch
"agentproto-vscode": patch
---

App Store empty states and catalog verbs. `agentproto app install @scope/name` installs the daemon catalog entry's pinned source (an existing path still wins). New `agentproto app catalog`, `app uninstall`, `app update` and `app store` verbs, and `app list` points at the store when nothing is installed. The VS Code apps view offers "Browse the App Store" instead of a dead end, the session-chat launcher shows a working install command plus an absolute App Store deep link, and onboarding proposes featured catalog apps (opt-in, skipped offline).
