# @agentproto/adapter-claude-code-cloud

AIP-66 managed cloud agent adapter for **Anthropic Claude Code cloud sessions**.
Unlike every other Claude Code adapter, this one runs **no harness locally**:
Anthropic owns the machine and the harness, so the adapter *relays* rather than
runs — the vendor's own CLI and sessions API are surfaced behind an AIP-44 ACP
server.

- first ACP prompt → `claude --cloud "<prompt>"` (start; answers the first-run
  folder-trust prompt under a PTY),
- later prompts → `claude -p "<text>" --cloud <session id>` (send-only),
- then polls the vendor's events API until a NEW `result` event ends the turn —
  never a timer, never poll silence (AIP-66 §6).

Event payloads are Claude Code stream-json messages, so the stream-json → ACP
mapping reuses `@agentproto/adapter-claude-sdk`'s mappers (assistant text →
`agent_message_chunk`, `tool_use` → `tool_call`, `tool_result` →
`tool_call_update`); the `result` event's `total_cost_usd` + `usage` become an
ACP `usage_update`, and a result without usage emits none (unmeasured, never
zero — AIP-66 §7).

## Preconditions

- **A claude.ai login in the claude CLI.** The adapter reads the OAuth token
  from the `Claude Code-credentials` keychain entry (org uuid from
  `~/.claude.json`), or `CLAUDE_CLOUD_OAUTH_TOKEN` when injected. A CLI
  authenticated by API key, or not logged in, is refused with a pointer to
  `claude auth login`. When the token is expired (or within five minutes of
  expiry) or the API answers 401, the adapter runs `claude -p "Reply OK"
  --model haiku` once to let the CLI re-mint it, drops its cached credential,
  and retries — a still-failing call reports `run \`claude auth login\``. The
  token is only ever used as a request header — never logged or persisted
  (AIP-66 §8).
- **A repo source: a declared workspace remote, or a clean, pushed git
  checkout as the session cwd.** The cloud runs the repo from its git remote,
  never an uploaded working tree.
  - **Declared remote (no local clone needed):** declare the repo on the
    workspace, the same way a sandbox (e2b, …) spawn gets its checkout:

    ```bash
    agentproto workspace remote set <slug> --url https://github.com/acme/repo \
      [--branch main] [--token-stdin]   # token only for a private repo
    ```

    A `cloud` spawn on that workspace (`agent_start({ cloud: "anthropic",
    workspaceSlug: "<slug>" })`) hands the relay the remote; the relay
    shallow-clones `origin/<branch>` into the session's isolated config dir
    and runs `claude --cloud` from there. A resume re-uses that checkout
    (fetch + hard reset). The git token reaches the clone through a
    credential helper only — never argv, the clone URL, `.git/config`, or the
    vendor CLI's env.
  - **Local checkout (no remote declared):** `session/new` refuses
    (AIP-66 §3) a non-git cwd, a dirty working tree, a missing `origin`
    remote, and an unpushed HEAD. Commit and push first.

## Usage

```bash
# Spawned by the daemon as the `claude-code-cloud` arm, or standalone:
agentproto-claude-code-cloud-acp
```

`session/cancel` reports unsupported: the vendor exposes no interrupt verb
(AIP-66 §6). No model menu is exposed either — the vendor picks the model.

## Protocol details

See [CLAUDE-CODE-CLOUD.md](./CLAUDE-CODE-CLOUD.md) for the full AIP-44 ACP
wire profile: lifecycle, message mapping, usage telemetry, session identity,
repo-source refusals, refused spawn fields, and the vendor surfaces used.

## License

Apache-2.0
