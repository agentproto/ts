# @agentproto/storage-github

GitHub `WorkspaceSync` provider for `@agentproto/storage` (AIP-35). Clones a
repo on `pull`, commits with AIP-23 `identity` as git author on `push`, and
opens PRs per `sync.push.pr_policy`. PR creation is host-side via
`@octokit/rest` — no in-box `gh` CLI dependency, so the package works
identically whether the workspace runs locally or inside a sandbox.

## Usage

```ts
import { defineGithubStorage } from "@agentproto/storage-github"
import { hasWorkspaceSync } from "@agentproto/storage"

const handle = defineGithubStorage({
  repoUrl: "https://github.com/owner/repo",
  branchPolicy: "per-conversation",
  prPolicy: "auto",
})

// The factory slot is what the workspace/corpus layer calls with a runtime
// context (workspaceDir, token, identity).
const fs = handle.factory({
  workspaceDir: "/tmp/work",
  token: process.env.GITHUB_TOKEN!,
  identity: { name: "Ops Bot", email: "ops@example.com" },
})

if (hasWorkspaceSync(fs)) {
  await fs.pull(fs) // seed the tree
  // … agent writes to fs …
  await fs.push(fs, { label: "session-42", summary: "Apply operator edits" })
}
```

The `GITHUB_TOKEN` is resolved through the existing `@agentproto/secrets`
broker (`SecretResolver` from `@agentproto/secrets/exposure`) by the caller
and passed in the factory context — never inlined in config, never logged.

## Executor choice: octokit (host-side) vs gh CLI (in-box)

This package uses `@octokit/rest` host-side for PR creation. Rationale:

- No coupling to the e2b sandbox template (which would need `gh` baked in).
- The token already reaches the host via the secrets broker; reusing it for
  the octokit REST call is one fewer hop.
- Works the same whether the workspace is local or sandboxed.

If `gh` is later baked into the sandbox template, a `gh`-based `PrCreator`
can be slotted in via the factory context without touching this package's
public API.

## License

MIT — see [LICENSE](./LICENSE).
