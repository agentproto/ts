---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/sandbox-e2b": minor
"@agentproto/sandbox": minor
---

Sandbox spawns can now work from a workspace's git remote. `agentproto workspace remote` (with `--token-stdin`) registers an https clone URL and a keychain credential for a workspace; `agent_start({ workspaceSlug, sandbox, worktree })` then clones it into the box, cuts `wt/<slug>` from `worktree.base`, and starts the session there with the token injected only as the `AGENTPROTO_GIT_TOKEN` env var behind a credential helper. When the box is torn down, the work branch is pushed to `origin` if it is ahead of its base, with a `git bundle` fallback saved to `~/.agentproto/sessions/<id>/delivery.bundle`, and the outcome is recorded on the session descriptor (`sandboxDelivery`). `BootedSandbox` gains an optional `readFile`, implemented for E2B.

Behaviour changes to be aware of:

- With `env.autoPassthrough` on a sandbox spawn that uses a Claude subscription profile (claude-code), the profile's long-lived `CLAUDE_CODE_OAUTH_TOKEN` is now resolved from the OS keychain and sent into the box. Previously it was only forwarded when it was already present in the daemon's environment, so the credential now reaches a third-party box where it did not before. Sub-account pins are unaffected.
- `AGENTPROTO_GIT_TOKEN` is an ordinary environment variable inside the box, so the agent running there can read it (and `sandbox_exec` can print it). Register a token scoped to the one repository and revoke it when the work is done. A box booted with a workspace's token can only be reused by that same workspace.
