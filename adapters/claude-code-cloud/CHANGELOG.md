# @agentproto/adapter-claude-code-cloud

## 0.3.2

### Patch Changes

- c53688d: Remove the `defineAgentCli` export from `@agentproto/harness` (it aliased `defineHarness`; use `defineHarness`) and the `defineAgencyV2` export from `@agentproto/agency` (it aliased `defineAgency`; use `defineAgency`). The nine deprecated re-export shim packages are deleted from the repo; use their replacements (`provider-kit`, `agency`, `app`, `doctype`, `harness`, `inference-endpoint`, `bridge`, `pairing`, `processor`). The in-repo adapters and the CLI now call `defineHarness`; no behaviour change.
- e7bda96: Fix the Claude Cloud CI lane losing its first `turn-end`. `sessions wait` now accepts `--since <seq>` so a spawn-then-wait caller can replay a turn that finished before the wait process started. The adapter also pre-trusts its cwd without risking the user's config (atomic write, skipped when already trusted, never overwritten on a parse failure) and re-answers a trust dialog that re-renders until it is accepted, so `claude --cloud` cannot stall on the folder-trust prompt.
- Updated dependencies [68c476e]
- Updated dependencies [da71f8c]
- Updated dependencies [0e0fd10]
- Updated dependencies [c350f3a]
- Updated dependencies [c53688d]
- Updated dependencies [f1dab61]
- Updated dependencies [dd134f4]
- Updated dependencies [c350f3a]
- Updated dependencies [30961a9]
- Updated dependencies [dd134f4]
- Updated dependencies [30961a9]
  - @agentproto/harness@3.0.0
  - @agentproto/adapter-claude-sdk@0.7.32

## 0.3.1

### Patch Changes

- 7a90c4b: AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

  Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

  The switched dependents only rename their dependency and import specifiers, hence the patch bumps.

- Updated dependencies [7a90c4b]
- Updated dependencies [8d8c10c]
- Updated dependencies [84ac51b]
  - @agentproto/harness@2.16.0
  - @agentproto/adapter-claude-sdk@0.7.31
  - @agentproto/provider-presets@0.7.2

## 0.3.0

### Minor Changes

- 8954bba: Claude Code cloud sessions can now run on a workspace's declared remote (`workspaces.json` → `remote`, set with `agentproto workspace remote set`), the same way a sandbox spawn gets its checkout. You no longer need a local clean, pushed clone.

  `@agentproto/runtime`: a `cloud` spawn (and its restart) on a workspace with a declared `remote` passes the url, branch and a checkout dir inside the session's isolated config dir to the relay. A `credentialRef` is resolved from the keychain into `AGENTPROTO_GIT_TOKEN`; a ref that resolves to nothing refuses the spawn (`cloud_spawn_refused`, field `workspace.remote.credentialRef`). New `cloudRepoSpawnEnv` / `cloudRepoCheckoutDir` helpers.

  `@agentproto/adapter-claude-code-cloud`: new `materializeRepoCheckout`. With `AGENTPROTO_CLOUD_REPO_URL` + `AGENTPROTO_CLOUD_REPO_DIR` set, `session/new` and `session/load` shallow-clone `origin/<branch>`, or fetch and hard-reset an existing checkout. That checkout must pass the usual AIP-66 §3 validation, and `claude --cloud` then runs from it. The git token is only ever read by a per-command credential helper and is removed from the vendor CLI's env.

- 8954bba: Cloud sessions can run on a workspace's declared remote instead of requiring a local clean clone. The runtime passes the remote URL, branch and an isolated checkout dir (plus a keychain-resolved git token when a `credentialRef` is set) to the relay; the adapter materializes a clean `origin/<branch>` checkout and validates it under AIP-66 §3 before running the vendor CLI.

### Patch Changes

- Updated dependencies [c14b061]
  - @agentproto/driver-agent-cli@2.15.0
  - @agentproto/adapter-claude-sdk@0.7.30

## 0.2.5

### Patch Changes

- Updated dependencies [b2593c3]
  - @agentproto/driver-agent-cli@2.14.0
  - @agentproto/adapter-claude-sdk@0.7.29

## 0.2.4

### Patch Changes

- 305199d: AIP-66 cloud spawn model + error detail.

  The `claude-code-cloud` manifest now declares a free-form string `model` option (applied via `ANTHROPIC_MODEL` env on the relay's claude children — the same channel the local `claude-code` adapter uses), so `agent_start { cloud: "anthropic", adapter: "claude-code-cloud", model: "claude-opus-5-5" }` no longer fails with `[unknown_option at config.options.model] Option 'model' is not declared by manifest 'claude-code-cloud'. Known options: (none)`. Omitting `model` still leaves the vendor's own default in place; no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

  The ACP client no longer swallows the cause of a refused spawn/turn behind a bare "Internal error": the SDK maps a server-side handler throw to a JSON-RPC `-32603` whose message is just "Internal error" and keeps the real reason only in `error.data.details` (a missing claude.ai credential, an unpushed checkout, a vendor API error, …). `newSession` / `loadSession` / prompt turn errors now surface that detail in the message (carrying the `-32603` code through), so the host shows the actual refusal.

- 305199d: AIP-66 cloud spawn `model` option + richer ACP error detail.

  `claude-code-cloud` now declares a free-form string `model` option, applied via the `ANTHROPIC_MODEL` env var on the relay's claude children (the same channel the local `claude-code` adapter uses), so `agent_start` naming a model no longer fails with `unknown_option`. Omitting it leaves the vendor's own default in place and no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

  The ACP client now surfaces the cause of a refused spawn/turn hidden behind a bare JSON-RPC `-32603` "Internal error": `newSession` / `loadSession` / prompt-turn errors include the human-readable `error.data.details` in the message while carrying the `-32603` code through, so a host that reads only `error.message` shows the real refusal (missing credential, unpushed checkout, vendor API error) instead of a bare "Internal error".
  - @agentproto/adapter-claude-sdk@0.7.28
  - @agentproto/driver-agent-cli@2.13.3

## 0.2.3

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/adapter-claude-sdk@0.7.27
  - @agentproto/driver-agent-cli@2.13.2
  - @agentproto/provider-presets@0.7.1

## 0.2.2

### Patch Changes

- @agentproto/adapter-claude-sdk@0.7.26

## 0.2.1

### Patch Changes

- 14018fe: Document that Claude Code Cloud supports `session/load` to re-attach persisted vendor sessions.
- 691ff00: Refresh an expired claude.ai OAuth login (via `claude -p`) and drop the stale keychain credential cache before retrying, so a re-attach after the token expired no longer 401s
- f316183: Detect the first-run folder-trust prompt through the cursor-column escapes the claude TUI draws it with — normalize PTY output (CSI/OSC/lone-ESC → spaces) before every TUI regex, so `claude --cloud` no longer stalls to its 120s timeout in a never-trusted folder. The PTY timeout error now carries a short ANSI-stripped tail of the stalled screen.
- Updated dependencies [a21b38b]
- Updated dependencies [6796022]
- Updated dependencies [c6ac536]
  - @agentproto/driver-agent-cli@2.13.1
  - @agentproto/adapter-claude-sdk@0.7.25

## 0.2.0

### Minor Changes

- 5982c03: AIP-66 re-attach + adapter discoverability: the claude-code-cloud relay now advertises ACP `session/load` and implements it — the host hands back the vendor session id persisted on `meta.cloud.sessionId`, `session/load` ADOPTS it (repo-source validated first, an id that isn't `session_`/`cse_` fails closed), pre-marks the vendor's existing events so only the next turn's own `result` can end it, and the subsequent prompt goes through `sendPrompt` (`claude -p --cloud <id>`), never `startCloudSession` — a resumed relay can no longer start a replacement vendor session (AIP-66 §5). The learned identity is reported to the host through the `AGENTPROTO_CLOUD_SESSION_META_FILE` side file as exactly `{ vendor, sessionId, url }` (atomic temp+rename, best-effort), preserving an existing URL across a re-attach; the vendor's OAuth credential never enters it, logs or events (AIP-66 §8). The CLI lists `claude-code-cloud` in the bundled adapter catalog (`agentproto install` picker) and carries `@agentproto/adapter-claude-code-cloud` as a devDependency so the slug resolves like every other first-party adapter.
- e446d17: feat(adapter-claude-code-cloud): new AIP-66 managed cloud agent adapter for Anthropic Claude Code cloud sessions — the first vendor binding of the `cloud:<vendor>` execution target. The vendor owns the machine and the harness (no agentproto daemon runs inside), so the adapter relays rather than runs: first ACP prompt → `claude --cloud "<prompt>"` under a PTY (`node-pty`, answering the first-run folder-trust prompt, 120s cap), later prompts → `claude -p "<text>" --cloud <session id>` (send-only), then polls the undocumented sessions API (`GET /v1/code/sessions/{id}/events`, 2s backing off to 10s) until a NEW vendor `result` event — a turn ends ONLY on the vendor's end-of-turn event (AIP-66 §6), never a timer. Event payloads ARE Claude Code stream-json SDK messages, so the stream-json → ACP mapping reuses `@agentproto/adapter-claude-sdk`'s mappers (assistant text → `agent_message_chunk`, tool_use → `tool_call`, tool_result → `tool_call_update`) — not forked. The `result` event's `total_cost_usd` + `usage` become an ACP `usage_update`; a result without usage emits none (unmeasured, never zero — AIP-66 §7). `session/new` refuses per AIP-66 §3 before any vendor side effect: non-git cwd, dirty tree, missing `origin` remote, unpushed HEAD; and refuses `mcpServers` (§4 backstop; the manifest documents the full refused-field set: sandbox, worktree, commandSandbox, mcpServers, daemonMount, bundles, browser, appServe, inference). `session/cancel` reports unsupported (no vendor interrupt verb). Sessions API client (`src/sessions-api.ts`) takes an injectable fetch + `CredentialSource` (macOS keychain `Claude Code-credentials` → `.claudeAiOauth.accessToken` + org from `~/.claude.json`, or `CLAUDE_CLOUD_OAUTH_TOKEN`/`CLAUDE_CLOUD_ORG_UUID` env), normalizes `session_`/`cse_` ids, round-trips `resume_cursor`, re-reads the credential exactly once on 401 then fails with a `claude auth login` hint — the token is never logged or persisted (§8). Every claude child gets `ANTHROPIC_API_KEY` + the Bedrock/Vertex/Foundry/… redirect toggles scrubbed from its env, and a preflight (`claude auth status`) refuses api_key auth or a logged-out CLI before any side effect. Manifest: slug `claude-code-cloud`, protocol acp, harness label `claude-code`, no model menu (the vendor picks the model); spawned as `node bin/claude-code-cloud-acp.mjs` over stdio JSON-RPC.
- e446d17: New AIP-66 managed cloud agent adapter for Claude Code cloud sessions.

### Patch Changes

- c7a240b: AIP-66 cloud review follow-ups. Runtime: `watchCloudSessionMeta` now only learns a meta file whose `vendor` matches the watch (a file written for another vendor is ignored and the watch keeps polling). Adapter: `session/load` validates the session id before the repo source, so a malformed id reports its own error first; `#seedSeenEvents` pages through the whole vendor history via `resume_cursor` (bounded at 50 pages) so every pre-existing event — including an older `result` — is pre-marked, leaving `pollCursor` at the newest position the normal poll loop resumes from.
- 1576bbb: AIP-66 cloud observe fixes. Adapter: the events cursor pages BACKWARD in time (no cursor = newest page; `resume_cursor` = the oldest `sequence_num` on the page, passed back returns the next OLDER page), so `#observeTurn` no longer uses a forward `cursor`/seen-id set — it tracks a per-session `lastSeq`, polls the newest page each tick, walks `cursor` backward only as far as needed (capped at 20 pages/tick), projects new events in ascending `sequence_num` order, and ends a turn only on a vendor `result` whose seq is above the high-water recorded before the prompt. `session/load` seeds `lastSeq` from one newest-page GET (the forward-paging loop and `SEED_EVENT_PAGES_LIMIT` are gone), and the `CloudSessionEvent`/page types now carry `sequence_num`, `source` and `next_cursor`. Runtime: the cloud-spawn refusal message is no longer double-prefixed with `agent_start:`, and `resolveCloudSpawn` records the vendor's harness (`claude-code`) on the descriptor instead of the local relay adapter slug (`claude-code-cloud`) — the adapter stays `claude-code-cloud` (AIP-66 §2).
