---
"@agentproto/cli": patch
---

Declare opencode / codex / openclaw adapters as workspace devDependencies of
the CLI. They were catalog entries resolved at runtime but never declared, so
`agentproto install openclaw` could not resolve, and opencode/codex only worked
via hand-made `node_modules` symlinks that a fresh `pnpm install` would not
recreate. Declaring them (matching claude-code/hermes) makes the adapter set
fully reproducible from a clean checkout — no manual symlinks.
