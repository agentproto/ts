---
"@agentproto/cli": minor
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-claude-code": patch
---

Add `--pack <dir|name>` to `agentproto install skill/<slug>` for installing from any skill pack, and a fan-out install path (no `--target` given) that installs into every installed CLI adapter declaring a `metadata.skills` block, alongside whatever skills that driver ships natively. `hermes` and `claude-code` now declare `metadata.skills` to opt in. Explicit `--target` still works as a legacy escape hatch.
