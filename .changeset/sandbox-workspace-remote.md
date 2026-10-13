---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/sandbox-e2b": minor
"@agentproto/sandbox": minor
---

Sandbox spawns can now work from a workspace's git remote. `agentproto workspace remote` (with `--token-stdin`) registers an https clone URL and a keychain credential for a workspace; `agent_start({ workspaceSlug, sandbox, worktree })` then clones it into the box, cuts `wt/<slug>` from `worktree.base`, and starts the session there with the token injected only as the `AGENTPROTO_GIT_TOKEN` env var behind a credential helper. `sandbox.credentialRefs` forwards other keychain-held secrets the same way. When the box is torn down, the work branch is pushed to `origin` if it is ahead of its base, with a `git bundle` fallback saved to `~/.agentproto/sessions/<id>/delivery.bundle`, and the outcome is recorded on the session descriptor (`sandboxDelivery`). `BootedSandbox` gains an optional `readFile`, implemented for E2B.
