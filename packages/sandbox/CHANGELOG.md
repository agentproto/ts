# @agentproto/sandbox

## 0.12.2

### Patch Changes

- Updated dependencies [ed1462e]
- Updated dependencies [8b228b0]
- Updated dependencies [ed1462e]
- Updated dependencies [8b228b0]
  - @agentproto/worktree@0.18.0
  - @agentproto/workflow-runtime@0.20.0

## 0.12.1

### Patch Changes

- 9ebf51d: `computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A stop whose detach is not answered leaves the computer in place and reports it. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count. `@agentproto/computer-api` gains `maxSessions` on the create request and `sessionsResponseSchema` for attach and detach.

  A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

- Updated dependencies [4c5f6e4]
- Updated dependencies [57ae214]
- Updated dependencies [4c5f6e4]
  - @agentproto/worktree@0.17.0

## 0.12.0

### Minor Changes

- 629e42c: Add the InstaBox sandbox provider (`@agentproto/sandbox-instabox`, AIP-36).

  - New `SandboxQuotaError` in `@agentproto/sandbox` and a `truncated` flag on `SandboxExecResult`.
  - `instaboxSandboxProvider` boots an InstaBox VM (always `vault:false`, `onTimeout:"kill"`), installs the agentproto daemon as a systemd unit with a 0600 EnvironmentFile, publishes the daemon port through the public edge, never suspends boxes, deletes the machine on boot failure, and maps account-quota failures to `SandboxQuotaError`.
  - Registered in the runtime provider catalog and the CLI (credential env key `INSTABOX_API_KEY`).

### Patch Changes

- 629e42c: Present a gated sandbox daemon's auth on the runtime's own MCP connection.

  - `ConnectHarnessOptions`/`HarnessClient.connect` accept `headers`, passed to
    the Streamable HTTP transport's `requestInit`.
  - `connectDaemonAgentSessionHost` forwards them through.
  - `createSandboxAgentSessionHost` sends `BootedSandbox.authHeaders` (or
    `Authorization: Bearer <token>`) so providers whose daemon is gated at the
    box itself — InstaBox's per-box `--auth-token` behind a public, otherwise
    unauthenticated edge — authenticate instead of 401-ing and getting reaped.

- 629e42c: Fix reattach and event streaming against a gated sandbox daemon, and a silent readFile failure.

  - `SandboxAgentSessionHost` exposes `authHeaders`; the runtime sandbox proxy
    sends them on its raw HTTP reads (`GET /sessions/:id`, the backlog read and
    the SSE event stream). Without them a bearer-gated daemon (InstaBox) answered
    401, so a session could never be re-attached after a host restart and the
    event stream always fell back to polling.
  - InstaBox `readFile` guards its `dd | base64` pipeline with `test -r`, so a
    missing or unreadable file rejects instead of resolving to empty bytes.

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [1d09ab0]
- Updated dependencies [629e42c]
- Updated dependencies [f2205fd]
- Updated dependencies [74f982c]
- Updated dependencies [1d09ab0]
- Updated dependencies [3a50c3d]
- Updated dependencies [74f982c]
- Updated dependencies [f2205fd]
  - @agentproto/worktree@0.16.0
  - @agentproto/define-doctype@0.1.4
  - @agentproto/secrets@2.1.1
  - @agentproto/workflow-runtime@0.19.1

## 0.11.2

### Patch Changes

- Updated dependencies [bb711b8]
- Updated dependencies [bb711b8]
  - @agentproto/secrets@2.1.0
  - @agentproto/worktree@0.15.2

## 0.11.1

### Patch Changes

- dc01c8b: Sandbox session proxy re-arms the box lifetime every 10 minutes while a turn is in flight and runs a pre-deadline guard (final renewal or checkpoint). Docs and provider comments updated.
- Updated dependencies [24f1cf5]
- Updated dependencies [c1e3dfd]
  - @agentproto/secrets@2.0.2
  - @agentproto/workflow-runtime@0.19.0
  - @agentproto/worktree@0.15.1

## 0.11.0

### Minor Changes

- 795c382: Sandbox sessions now survive a host daemon restart. Shutdown detaches provider-box sessions instead of killing them: the host closes its connection only, leaves the box and its agent session running, persists a re-attach record (`sandboxReattach`, row stays `running` with `hostDetached`), and asks the provider to extend the box lifetime to 60 minutes (`BootedSandbox.extendTimeout`, implemented for e2b via `setTimeout`; providers cap it, a rejected request leaves the existing lifetime). At boot, before eager resume, the daemon reconnects through `SandboxProvider.connect`, replays the events the box produced meanwhile from the saved transcript seq, and re-binds the same session id without re-prompting the agent. A box that no longer exists ends the row with the new `sandbox_gone` end reason and a `gone` ledger entry. `/health` and `daemon_health` gain `sandboxSessions`, and `agentproto daemon restart`/`stop` report how many sandbox sessions were detached and re-attached. Explicit kill, idle reap and cost kill still tear the box down; device-paired sandboxes and local sessions are unchanged.

### Patch Changes

- 36dac26: Sandbox boxes are kept alive while their session is working: the proxy re-arms the box lifetime (throttled to once per 60s) when a prompt is dispatched and as box events stream back, never while idle. The e2b `extendTimeout` clamps to the 1h account cap, and `BootedSandbox`/`SandboxAgentSessionHost` expose the box's configured `lifetimeMs`.
- e74439f: Sandbox sessions are now recoverable for workspaces with no `remote` in workspaces.json. The clone source is derived from the checkout's git `origin` (ssh forms normalized to https, public repos only, cloned anonymously and read-only with no credential attached, never persisted); a workspace with no usable origin has its box working dir checkpointed to the host as a size-capped, owner-only tarball at turn end and teardown, and `session_restart` on a fresh box extracts it. Missing pieces are reported with how to fix them. The sandbox agent-session host also forwards the provider's `writeFile`.
- Updated dependencies [fe3c879]
- Updated dependencies [cedd329]
- Updated dependencies [ff572e6]
  - @agentproto/workflow-runtime@0.18.0
  - @agentproto/worktree@0.15.0

## 0.10.0

### Minor Changes

- 877bc60: `sandbox_exec` can take secrets without the caller holding them: `envProfiles: { ENV_NAME: authProfileId }` has the daemon read the profile's credential (keychain, or its sub-account provider) into the command's env. Exec errors are now cut to ~200 chars of the command (`…(N chars)`) and resolved secrets are redacted from errors, stdout and stderr; commands over 16 KB / env over 32 KB are rejected with an actionable error, and an optional `files` input uploads scripts via the new optional `BootedSandbox.writeFile` (implemented for e2b). New `agentproto sandbox exec` CLI and daemon route `POST /sandboxes/exec`, whose exit code is the box command's exit code.
- d7e24ba: Sandbox spawns can now work from a workspace's git remote. `agentproto workspace remote` (with `--token-stdin`) registers an https clone URL and a keychain credential for a workspace; `agent_start({ workspaceSlug, sandbox, worktree })` then clones it into the box, cuts `wt/<slug>` from `worktree.base`, and starts the session there with the token injected only as the `AGENTPROTO_GIT_TOKEN` env var behind a credential helper. When the box is torn down, the work branch is pushed to `origin` if it is ahead of its base, with a `git bundle` fallback saved to `~/.agentproto/sessions/<id>/delivery.bundle`, and the outcome is recorded on the session descriptor (`sandboxDelivery`). `BootedSandbox` gains an optional `readFile`, implemented for E2B.

  Behaviour changes to be aware of:

  - With `env.autoPassthrough` on a sandbox spawn that uses a Claude subscription profile (claude-code), the profile's long-lived `CLAUDE_CODE_OAUTH_TOKEN` is now resolved from the OS keychain and sent into the box. Previously it was only forwarded when it was already present in the daemon's environment, so the credential now reaches a third-party box where it did not before. Sub-account pins are unaffected.
  - `AGENTPROTO_GIT_TOKEN` is an ordinary environment variable inside the box, so the agent running there can read it (and `sandbox_exec` can print it). Register a token scoped to the one repository and revoke it when the work is done. A box booted with a workspace's token can only be reused by that same workspace.

## 0.9.0

### Minor Changes

- fdb7e74: Add `sandbox_exec` MCP tool for sandbox command execution

### Patch Changes

- Updated dependencies [dcf3f33]
  - @agentproto/workflow-runtime@0.17.2
  - @agentproto/secrets@2.0.1
  - @agentproto/worktree@0.14.6

## 0.8.5

### Patch Changes

- @agentproto/workflow-runtime@0.17.1
- @agentproto/worktree@0.14.5

## 0.8.4

### Patch Changes

- Updated dependencies [4a833e9]
- Updated dependencies [5b021a8]
- Updated dependencies [6cf7140]
- Updated dependencies [3e61035]
  - @agentproto/workflow-runtime@0.17.0
  - @agentproto/worktree@0.14.4

## 0.8.3

### Patch Changes

- Updated dependencies [fdaaf7d]
- Updated dependencies [fdaaf7d]
  - @agentproto/secrets@2.0.0

## 0.8.2

### Patch Changes

- Updated dependencies [38b5538]
- Updated dependencies [5787677]
  - @agentproto/secrets@1.3.0

## 0.8.1

### Patch Changes

- @agentproto/worktree@0.14.3

## 0.8.0

### Minor Changes

- f6b1555: Device session mirroring (BOOTSTRAP P7, refs #1637): a controller spawning into
  `sandbox: "device:<fp|name>"` can now BOTH address the host conversation and
  read turns that happened on the host.

  - P7a: a device spawn stamps `hostSessionId` + `hostFingerprint` onto the
    controller descriptor (the device provider resolves the paired host's real
    fingerprint even for a name target); `device_prompt` (tool + REST route)
    accepts a controller session id and substitutes its mapped host id when the
    exact id 404s, with an actionable error naming the host when both fail; the
    fields ride `session_list`'s compact projection (`device_sessions`' list body
    is host-authored, so controller-side ids surface via the session descriptors).
  - P7b: read-time device-mirror (`device-mirror.ts`) — the session READ paths
    (`GET /sessions/:id` and its `/output`, `/events`, `/export`,
    `/conversation` twins, plus the `agent_output` tool) sync host turns into the
    controller transcript before reading, tagged `origin: "device"` + `hostSeq` +
    `sourceRef: "device:<fp>"`, with a restart-safe dedup cursor derived from the
    mirrored file itself and a `mirrorError` marker (never stale data) when the
    host is unreachable. Consumes EXISTING host endpoints only; hosts older than
    the id-mapping fields keep today's behaviour.
  - The sandbox package only gains an optional `device?.fingerprint` on
    `BootedSandbox` / `SandboxAgentSessionHost` (device-provider metadata).

- f6b1555: Device session mirroring (BOOTSTRAP P7, refs #1637): a controller spawning into
  `sandbox: "device:<fp|name>"` can now BOTH address the host conversation and
  read turns that happened on the host.

  - P7a: a device spawn stamps `hostSessionId` + `hostFingerprint` onto the
    controller descriptor (the device provider resolves the paired host's real
    fingerprint even for a name target); `device_prompt` (tool + REST route)
    accepts a controller session id and substitutes its mapped host id when the
    exact id 404s, with an actionable error naming the host when both fail; the
    fields ride `session_list`'s compact projection.
  - P7b: read-time device-mirror (`device-mirror.ts`) — the session READ paths
    (`GET /sessions/:id` and its `/output`, `/events`, `/export`,
    `/conversation` twins, plus the `agent_output` tool) sync host turns into the
    controller transcript before reading, tagged `origin: "device"` + `hostSeq` +
    `sourceRef: "device:<fp>"`, with a restart-safe dedup cursor and a
    `mirrorError` marker when the host is unreachable. Consumes EXISTING host
    endpoints only; hosts older than the id-mapping fields keep today's behaviour.
  - Minor (not patch) because runtime adds new exports
    (`promptDeviceSession`, `syncDeviceMirror`, …) and sandbox adds the optional
    `device?.fingerprint` field on `BootedSandbox`.

### Patch Changes

- @agentproto/worktree@0.14.2

## 0.7.4

### Patch Changes

- @agentproto/secrets@1.2.1

## 0.7.3

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/secrets@1.2.0
  - @agentproto/workflow-runtime@0.16.0
  - @agentproto/worktree@0.14.1

## 0.7.2

### Patch Changes

- Updated dependencies [88f2836]
- Updated dependencies [461df5e]
- Updated dependencies [14e2494]
- Updated dependencies [036c9df]
- Updated dependencies [2b36ea0]
- Updated dependencies [78cd278]
  - @agentproto/worktree@0.14.0
  - @agentproto/define-doctype@0.1.3
  - @agentproto/workflow-runtime@0.15.0
  - @agentproto/secrets@1.1.1

## 0.7.1

### Patch Changes

- Updated dependencies [904f3d4]
- Updated dependencies [9a9a3e7]
  - @agentproto/worktree@0.13.0

## 0.7.0

### Minor Changes

- b7b85d6: Auto-join wiring for sandbox boxes: optional `join: { tokenEnv: string }` on the AIP-36 `SandboxDefinition` (`@agentproto/sandbox`) names a host env var whose value (a join-token URL) is forwarded into the box under the same name at boot — sugar over `env.passthrough`, self-documenting for the auto-join case, and a no-op (never a boot failure) when the named host env var isn't actually set. `@agentproto/runtime`'s sandbox-boot slug collection (`bootSandboxAgentSession`) now includes `join.tokenEnv` in the resolved secret set whenever it's present and resolvable.

### Patch Changes

- Updated dependencies [83ffc2d]
- Updated dependencies [4ecd91b]
  - @agentproto/worktree@0.12.0

## 0.6.2

### Patch Changes

- Updated dependencies [8277109]
- Updated dependencies [c1899d7]
- Updated dependencies [8518b3f]
  - @agentproto/worktree@0.11.0
  - @agentproto/workflow-runtime@0.14.0

## 0.6.1

### Patch Changes

- Updated dependencies [1f03bf3]
- Updated dependencies [b0eeee7]
- Updated dependencies [8a29038]
- Updated dependencies [b9f9bb6]
- Updated dependencies [332aebf]
- Updated dependencies [7f50ff6]
  - @agentproto/worktree@0.10.0
  - @agentproto/workflow-runtime@0.13.1
  - @agentproto/secrets@1.1.0

## 0.6.0

### Minor Changes

- e412bd8: Sandbox spawn defaults cwd to the box's home, kills by default on close, and reconciles the ledger against the real provider

### Patch Changes

- Updated dependencies [eaa50f8]
- Updated dependencies [c3314bd]
- Updated dependencies [7c059bc]
- Updated dependencies [582b79c]
- Updated dependencies [579227e]
- Updated dependencies [6c68009]
- Updated dependencies [1e871ec]
- Updated dependencies [5a466d6]
- Updated dependencies [9a5d311]
- Updated dependencies [bdb5830]
- Updated dependencies [476b1ca]
- Updated dependencies [b61405e]
- Updated dependencies [219e8cf]
- Updated dependencies [f70d919]
- Updated dependencies [5f0f9d1]
- Updated dependencies [ef9f57e]
- Updated dependencies [502f4c9]
- Updated dependencies [8dc445b]
  - @agentproto/worktree@0.9.0
  - @agentproto/workflow-runtime@0.13.0
  - @agentproto/secrets@1.0.0

## 0.5.3

### Patch Changes

- Updated dependencies [41b8b76]
- Updated dependencies [854db1f]
  - @agentproto/workflow-runtime@0.12.0
  - @agentproto/worktree@0.8.1

## 0.5.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
- Updated dependencies [6fb4a28]
  - @agentproto/secrets@0.2.6
  - @agentproto/workflow-runtime@0.11.1
  - @agentproto/worktree@0.8.0

## 0.5.1

### Patch Changes

- Updated dependencies [e759d6d]
  - @agentproto/worktree@0.7.0

## 0.5.0

### Minor Changes

- 5c0acd2: Reap sandboxes left behind by failed boots and add `sandbox gc`
- d3f0e0d: Expose sandbox liveness separately from session liveness: optional `SandboxProvider.probe()` with `SandboxProbeResult`, a portable `SandboxBoxGoneError` sentinel (e2b maps provider 404s to it), a `GET /sandboxes/:id/alive` runtime route, a new `"gone"` sandbox-ledger state with `sandboxAlive`/`sandboxCheckedAt` projected onto session summaries, and a LIVE column plus `--no-probe` flag for `sandbox list`.

## 0.4.0

### Minor Changes

- 648e789: Add semantic config.installAdapters field to sandbox specs
- 87a2814: feat: opt-in `env.autoPassthrough` on sandbox specs. `@agentproto/sandbox` declares the optional flag on `SandboxDefinition.env` (+ zod schema, default strictly absent); `@agentproto/runtime` implements it: when the flag is set and the spawn's host-side billing-credential resolution produced a credential, the credential's env-var NAME (its `setEnv`, e.g. `ANTHROPIC_API_KEY`) is injected into `spec.env.passthrough` before the sandbox box boots, so a fresh box inherits host auth without the caller naming vars. Only the name is injected — the value travels via the existing passthrough mechanism (host secrets broker → box env) and is never read, logged, or echoed by the flag. Billing credential only; explicit `env.passthrough` entries are unioned (deduped, caller entries kept). When no credential resolved — or the host process cannot resolve the var — nothing is injected and the spawn proceeds unchanged.
- 834bfb8: Pause is the default sandbox teardown: closing a session with no `lifecycle` declaration now pauses the box (`pause({ keepMemory: true })`) instead of killing it, so every closed box stays reattachable via `sandbox.reuse` / `agentproto sandbox attach`. Explicit declarations stay authoritative — `lifecycle.destroy_on` kills, `pause_after_idle` pauses. Paused boxes still die at their own `timeoutMs` (45 min by default), so pauses don't accumulate indefinitely.
- feffc34: Accept AIP-38 `policy` blocks in SANDBOX frontmatter schemas: the strict
  `z.object` now declares the top-level `policy` key that the vendored JSON
  draft has always advertised, so manifests carrying a policy block no longer
  fail validation as an unknown key. Note: the block's shape is not yet
  validated — the scaffolder emits `z.any()` for it until local `$ref`
  resolution is implemented; accepting the key is the change.

### Patch Changes

- d034471: Auto-install the spawned adapter into sandbox boxes' installPackages
- Updated dependencies [c809f12]
  - @agentproto/workflow-runtime@0.11.0
  - @agentproto/worktree@0.6.2

## 0.3.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2
  - @agentproto/secrets@0.2.5
  - @agentproto/workflow-runtime@0.10.1
  - @agentproto/worktree@0.6.1

## 0.3.0

### Minor Changes

- db90fb3: Implement port exposure for sandboxes. Add `expose(port)` method and `ports` map to `BootedSandbox` to enable agents to expose HTTP server ports inside sandboxes as publicly accessible URLs. Support pre-declaring ports via `extraPorts` in the sandbox spec for eager resolution at boot time. E2B provider implements port exposure via `sandbox.getHost(port)`. Surface exposed ports in `SessionDescriptor` and `SessionSummary` via new `sandboxPorts` field.
- c71753a: Add `agent_start.appServe`: with `sandbox`, the daemon installs the app on the box (the box daemon's `app_install`), launches `agentproto app serve --host 0.0.0.0 --port <port>` detached through the box's `command_execute` (seeding the box command allowlist), and stamps the public URL on the descriptor/result; `SandboxAgentSessionHost` now carries `mcpUrl` so callers can drive the box's other daemon tools.

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [80c837e]
- Updated dependencies [a48dc03]
- Updated dependencies [1cd0220]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/worktree@0.6.0
  - @agentproto/define-doctype@0.1.1
  - @agentproto/secrets@0.2.4

## 0.2.6

### Patch Changes

- Updated dependencies [11b5564]
- Updated dependencies [2fc4c69]
  - @agentproto/workflow-runtime@0.9.0
  - @agentproto/worktree@0.5.5

## 0.2.5

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [f0c51a7]
  - @agentproto/secrets@0.2.4
  - @agentproto/workflow-runtime@0.8.1
  - @agentproto/worktree@0.5.4

## 0.2.4

### Patch Changes

- Updated dependencies [76f2c78]
- Updated dependencies [e3ad769]
- Updated dependencies [6372c19]
- Updated dependencies [8a3d53d]
- Updated dependencies [c5016ed]
- Updated dependencies [b1a8b7e]
  - @agentproto/secrets@0.2.3
  - @agentproto/worktree@0.5.3
  - @agentproto/workflow-runtime@0.8.0

## 0.2.3

### Patch Changes

- Updated dependencies [5f5b1bc]
  - @agentproto/worktree@0.5.2

## 0.2.2

### Patch Changes

- Updated dependencies [4b6bbe6]
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
  - @agentproto/worktree@0.5.1
  - @agentproto/workflow-runtime@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [c1399f3]
- Updated dependencies [8228d88]
- Updated dependencies [fd3e287]
  - @agentproto/worktree@0.5.0

## 0.2.0

### Minor Changes

- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.

### Patch Changes

- 013e7b3: Carry provider auth headers through attach; fix Box boot auth
- Updated dependencies [7192faf]
- Updated dependencies [41cd652]
- Updated dependencies [7465b6c]
- Updated dependencies [4d200a9]
- Updated dependencies [23fa73e]
  - @agentproto/worktree@0.4.3
  - @agentproto/workflow-runtime@0.6.0
  - @agentproto/secrets@0.2.2

## 0.1.5

### Patch Changes

- @agentproto/secrets@0.2.1

## 0.1.4

### Patch Changes

- Updated dependencies [57d1499]
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/worktree@0.4.2

## 0.1.3

### Patch Changes

- Updated dependencies [a116fd6]
  - @agentproto/worktree@0.4.1

## 0.1.2

### Patch Changes

- Updated dependencies [98bbebf]
  - @agentproto/worktree@0.4.0

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [5ae8c13]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [4f62f46]
- Updated dependencies [8a4d5d5]
- Updated dependencies [2bed7e6]
- Updated dependencies [3639abd]
- Updated dependencies [3e99abf]
- Updated dependencies [a63b4bc]
- Updated dependencies [47d3251]
- Updated dependencies [a32bb69]
- Updated dependencies [e0fbccc]
- Updated dependencies [0839e5f]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/secrets@0.2.0
  - @agentproto/workflow-runtime@0.4.0
  - @agentproto/worktree@0.3.0

## 0.1.0

### Minor Changes

- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support

### Patch Changes

- Updated dependencies [4a1ea0f]
- Updated dependencies [f8ebe41]
- Updated dependencies [7aaf24a]
- Updated dependencies [435dfbf]
- Updated dependencies [a6dce67]
- Updated dependencies [126f7c6]
- Updated dependencies [fe13f4e]
- Updated dependencies [829a6c0]
- Updated dependencies [4733077]
- Updated dependencies [e94757d]
- Updated dependencies [2154ed5]
- Updated dependencies [5988bf4]
- Updated dependencies [e029a35]
  - @agentproto/worktree@0.2.0
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/secrets@0.1.0
