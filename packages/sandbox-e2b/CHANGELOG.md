# @agentproto/sandbox-e2b

## 0.11.0

### Minor Changes

- e395b66: Tag e2b sandboxes with tenantId, owner and label metadata
- a5475aa: Add fail-closed overflow safety rails to the auto sandbox provider: residency, daily box and EUR caps, a secret allowlist, template CLI parity, and a maxEurPerBox timeout ceiling.

### Patch Changes

- b027bf4: Bake the `@anthropic-ai/claude-code` runtime CLI alongside `opencode-ai` in the workstation template, and generalize the template generator to emit one ARG and one build-time `--version` smoke check per runtime package.
- f765a96: Record the proven stable `agentproto-workstation` bake: template `53ybr99wdfgoebi9nee8` now reports CLI `1.31.0`, the bumped adapter set (including `@agentproto/adapter-claude-code` and `@agentproto/adapter-openclaw`), and the matching runtime pins in the generated `TEMPLATES.stable.baked` metadata.
- 2584203: Bump baked @agentproto/cli in e2b workstation template to 1.31.0
- Updated dependencies [e395b66]
  - @agentproto/sandbox@0.15.0

## 0.10.0

### Minor Changes

- a00f77d: Add list and estimated usage windows for e2b boxes. Usage is a live inventory estimate, not a billing history (a killed box drops out of the list; the fleet ledger is the record). Paused boxes are listed for inventory/gc but excluded from usage, since e2b stops billing them once paused.

### Patch Changes

- 84ac51b: Move the typed session presets from `@agentproto/harness` to `@agentproto/session-presets`. This is step 1 of 2 for AIP-45: the presets moved to `@agentproto/session-presets`, and the name `@agentproto/harness` now carries the AIP-45 runner (see the aip-45 changeset). `@agentproto/worktree` now imports the new package. The sandbox providers only update a doc comment that names the package, so they take a patch bump to satisfy the changeset coverage gate.
- Updated dependencies [61e6068]
- Updated dependencies [1d7b55a]
- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [804db17]
- Updated dependencies [5ab8114]
- Updated dependencies [61e6068]
  - @agentproto/sandbox@0.14.0

## 0.9.1

### Patch Changes

- a63eafb: fix(sandbox): never lose work to a box that outlives its welcome — bounded pre-deadline checkpoints, host-side rescue push on a wedged low-disk session, release dead-session boxes, capacity-free teardown

  - A session's end-of-turn checkpoint raced the provider's reaper: the box
    hit its E2B lifetime mid-turn ("sandbox not found") and the periodic
    checkpoint had pushed nothing. The deadline-near checkpoint is now
    BOUNDED to the remaining lifetime minus a safety margin (it never runs
    past the deadline), and a renewal while a turn is in flight is retried
    instead of falling through to the checkpoint branch after one failure.
  - Low disk + a wedged session (ENOSPC never settles after interrupt):
    when a forced low-disk checkpoint does not secure the box's work, the
    proxy runs a HOST-side rescue push — `git add -A` + `commit
--no-verify` + force-push to a `rescue/<session>` branch, executed via
    `sandbox exec`, and emits the rescue outcome as an agent warning.
  - A session that DIED (crashed / killed / errored) used to leave its box
    paused and RAM-held (the computer provider kept answering "capacity
    exhausted (available 511)"). The watchdog-driven death now ends with
    `close({ deathRelease: true })`: checkpoint → notify → REALLY release
    the box (kill/stop, never a memory-holding pause).
  - Teardown and `sandbox rm --box` never need capacity: `SandboxProvider`
    gains an optional `remove(sandboxId)` that destroys the box on the
    control plane WITHOUT connecting to it (which used to RESUME a
    suspended computer just to delete it, needing free RAM first).
    `sandbox gc` / reaping prefers `remove`; a periodic automatic
    `sandbox gc` runs on the daemon (1 h cadence,
    `AGENTPROTO_SANDBOX_GC_INTERVAL_MS` overrides / disables) reaping
    boxes whose origin session is dead.

- Updated dependencies [43e1fbc]
- Updated dependencies [e4d1185]
- Updated dependencies [ab53381]
- Updated dependencies [43e1fbc]
- Updated dependencies [ab53381]
- Updated dependencies [e4d1185]
- Updated dependencies [fb025f0]
- Updated dependencies [a63eafb]
  - @agentproto/sandbox@0.13.0

## 0.9.0

### Minor Changes

- 4d50b9b: Sandbox cost guardrails and device liveness:

  - e2b: a box whose spec declares `lifecycle.pause_after_idle` is created with `lifecycle.onTimeout: "pause"`, so a box that outlives its provider timeout is parked instead of destroyed. New `config.onTimeout` (`"pause" | "kill"`) overrides it.
  - runtime: the idle reaper honours a box's own `lifecycle.pause_after_idle` window when it is shorter than `daemon.sandboxIdleReapAfterMs` (new descriptor field `sandboxPauseAfterIdleMs`).
  - runtime: `device:` spawns probe the paired host's `/health` when it isn't already known online, and fail fast with a typed `device_offline` code (HTTP 400) instead of a generic `sandbox_boot_failed`, so a caller can fall back to a sandbox or queue the work.

- 4d50b9b: Sandbox cost guardrails and device liveness:

  - e2b: a box whose spec declares `lifecycle.pause_after_idle` is created with `lifecycle.onTimeout: "pause"`, so a box that outlives its provider timeout is parked instead of destroyed. New `config.onTimeout` (`"pause" | "kill"`) overrides it.
  - runtime: the idle reaper honours a box's own `lifecycle.pause_after_idle` window when it is shorter than `daemon.sandboxIdleReapAfterMs` (new descriptor field `sandboxPauseAfterIdleMs`).
  - runtime: `device:` spawns probe the paired host's `/health` when it isn't already known online, and fail fast with a typed `device_offline` code (HTTP 400) instead of a generic `sandbox_boot_failed`, so a caller can fall back to a sandbox or queue the work.

### Patch Changes

- @agentproto/sandbox@0.12.2

## 0.8.4

### Patch Changes

- Updated dependencies [9ebf51d]
  - @agentproto/sandbox@0.12.1

## 0.8.3

### Patch Changes

- 11f986f: runtime: classify a sandbox box that dies at/after its lifetime deadline while idle as expected expiry (`SandboxBoxExpiredError`), ending the row `status:"exited"` / `endedReason:"sandbox-expired"` instead of `crashed`; add the `sandbox-expired` end reason, a `markSandboxExpired` registry action, and a `type:"branch"` session-outcome artifact carrying the delivered work branch.

  sandbox-e2b: document the plan-level continuous-runtime cap behind the lifetime constants (comment-only).

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 11f986f: Sandbox sessions whose box reaches its lifetime deadline (e2b plan cap: 1h of continuous run on Hobby/Base, active or not) now end cleanly as `endedReason: "sandbox-expired"` / `status: "exited"` instead of being classified `crashed` / `error` without an artifact. The watchdog tags a death at/past the known (renewal-pushed) deadline as expected expiry (`SandboxBoxExpiredError`), the registry ends the row through a new `markSandboxExpired` (same lazy-resumable cleanup as a crash, but no crash status and no restart policy match), and the derived outcome surfaces the delivered work branch as a `type: "branch"` artifact. The e2b provider documents the real root cause of the "active session dies at start+~60min" reports: the plan's total continuous-run window — heartbeat renewal already works and cannot extend past it (Pro plan or e2b pause/resume is the escape hatch).
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [629e42c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
- Updated dependencies [629e42c]
- Updated dependencies [74f982c]
  - @agentproto/sandbox@0.12.0

## 0.8.2

### Patch Changes

- @agentproto/sandbox@0.11.2

## 0.8.1

### Patch Changes

- dc01c8b: Sandbox boxes no longer expire under a busy turn that streams nothing: while a turn is in flight the session proxy re-arms the box lifetime every 10 minutes, on top of the per-prompt and per-event renewals. About 5 minutes before the box's known deadline the proxy renews once more if a turn is still in flight, and otherwise (idle, or the renewal failed) runs a final checkpoint while the box is still reachable, instead of probing it after it is gone. Heartbeat and guard stop on close and on detach.
- dc01c8b: Sandbox session proxy re-arms the box lifetime every 10 minutes while a turn is in flight and runs a pre-deadline guard (final renewal or checkpoint). Docs and provider comments updated.
- Updated dependencies [dc01c8b]
  - @agentproto/sandbox@0.11.1

## 0.8.0

### Minor Changes

- d3549e7: The e2b provider sizes Node builds to the box: it derives `NODE_OPTIONS=--max-old-space-size=…` plus `npm_config_workspace_concurrency` / `TURBO_CONCURRENCY` from the resolved size preset (probed from the box with `nproc` / `free -m` for an explicit custom `template`) and ships them to every in-box process through the daemon's start env and `/etc/profile.d/agentproto-build.sh`, tunable or disableable via `config.buildEnv`, with a caller-provided value for the same var always winning.
- 27700c4: Size presets for the e2b workstation: `config.size` (`nano`, `small`, `medium`, `large`, `x-large`, `xx-large`) boots that preset's published `agentproto-workstation-<size>` template. `config.template` still wins, and with neither set the bare `agentproto-workstation` template boots, now built at the default `large` (4 vCPU / 8 GB). An unknown size fails with the list of valid sizes; a size e2b refused to create (today `x-large` / `xx-large`, over the plan's 8 vCPU / 8192 MB cap) fails with the recorded e2b error. Exports `SIZES`, `DEFAULT_SIZE` and the `WorkstationSize` type. The workstation templates now bake the GitHub CLI (`gh`, pinned and checksum-verified).

  Sandbox agents can open PRs themselves: a spawn whose workspace has a remote token now also gets that same daemon-derived token as `GH_TOKEN`, next to `AGENTPROTO_GIT_TOKEN`, so `gh pr create` works in the box (the token needs Contents + Pull requests write). `GH_TOKEN` is reserved like `AGENTPROTO_GIT_TOKEN`: it is stripped from caller-declared `env.passthrough` / `env.auth.state.env` / `join.tokenEnv`, and it never resolves to the daemon's own `GH_TOKEN`. A caller that used to pass `GH_TOKEN` through `env.passthrough` no longer gets it in the box.

- c6f1288: Sandbox sessions survive a box that dies outside `close()`. The host now checkpoints a box's work branch periodically (every 5 min, `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`, `0` = off) and at each turn end: it pushes `wt/<slug>` when ahead and force-pushes a snapshot of uncommitted work (built through a throwaway index) to `agentproto-checkpoint/wt/<slug>`, falling back to a host-side `checkpoint.bundle`. A watchdog probes the box daemon's `/health` and, after 3 failed or 10 unanswered probes, takes a last checkpoint and marks the session crashed so it can be restarted. `session_restart` on a session whose box is gone now boots a fresh box, re-clones the workspace remote, checks out the pushed branch and re-applies the snapshot, instead of failing. The e2b provider enables a 4 GiB swap file on fresh boots (`config.swapMb`, `0` = off).
- 795c382: Sandbox sessions now survive a host daemon restart. Shutdown detaches provider-box sessions instead of killing them: the host closes its connection only, leaves the box and its agent session running, persists a re-attach record (`sandboxReattach`, row stays `running` with `hostDetached`), and asks the provider to extend the box lifetime to 60 minutes (`BootedSandbox.extendTimeout`, implemented for e2b via `setTimeout`; providers cap it, a rejected request leaves the existing lifetime). At boot, before eager resume, the daemon reconnects through `SandboxProvider.connect`, replays the events the box produced meanwhile from the saved transcript seq, and re-binds the same session id without re-prompting the agent. A box that no longer exists ends the row with the new `sandbox_gone` end reason and a `gone` ledger entry. `/health` and `daemon_health` gain `sandboxSessions`, and `agentproto daemon restart`/`stop` report how many sandbox sessions were detached and re-attached. Explicit kill, idle reap and cost kill still tear the box down; device-paired sandboxes and local sessions are unchanged.

### Patch Changes

- 36dac26: Sandbox boxes are kept alive while their session is working: the proxy re-arms the box lifetime (throttled to once per 60s) when a prompt is dispatched and as box events stream back, never while idle. The e2b `extendTimeout` clamps to the 1h account cap, and `BootedSandbox`/`SandboxAgentSessionHost` expose the box's configured `lifetimeMs`.
- 2dda22e: Rebuild the `agentproto-workstation` e2b templates (stable and dev) on `@agentproto/cli` 1.20.0 with the latest adapters, so boxes apply the sub-account env forwarded from the host (#1890) and the sandbox exec fix (#1886).
- Updated dependencies [36dac26]
- Updated dependencies [795c382]
- Updated dependencies [e74439f]
  - @agentproto/sandbox@0.11.0

## 0.7.0

### Minor Changes

- 877bc60: `sandbox_exec` can take secrets without the caller holding them: `envProfiles: { ENV_NAME: authProfileId }` has the daemon read the profile's credential (keychain, or its sub-account provider) into the command's env. Exec errors are now cut to ~200 chars of the command (`…(N chars)`) and resolved secrets are redacted from errors, stdout and stderr; commands over 16 KB / env over 32 KB are rejected with an actionable error, and an optional `files` input uploads scripts via the new optional `BootedSandbox.writeFile` (implemented for e2b). New `agentproto sandbox exec` CLI and daemon route `POST /sandboxes/exec`, whose exit code is the box command's exit code.
- d7e24ba: Sandbox spawns can now work from a workspace's git remote. `agentproto workspace remote` (with `--token-stdin`) registers an https clone URL and a keychain credential for a workspace; `agent_start({ workspaceSlug, sandbox, worktree })` then clones it into the box, cuts `wt/<slug>` from `worktree.base`, and starts the session there with the token injected only as the `AGENTPROTO_GIT_TOKEN` env var behind a credential helper. When the box is torn down, the work branch is pushed to `origin` if it is ahead of its base, with a `git bundle` fallback saved to `~/.agentproto/sessions/<id>/delivery.bundle`, and the outcome is recorded on the session descriptor (`sandboxDelivery`). `BootedSandbox` gains an optional `readFile`, implemented for E2B.

  Behaviour changes to be aware of:

  - With `env.autoPassthrough` on a sandbox spawn that uses a Claude subscription profile (claude-code), the profile's long-lived `CLAUDE_CODE_OAUTH_TOKEN` is now resolved from the OS keychain and sent into the box. Previously it was only forwarded when it was already present in the daemon's environment, so the credential now reaches a third-party box where it did not before. Sub-account pins are unaffected.
  - `AGENTPROTO_GIT_TOKEN` is an ordinary environment variable inside the box, so the agent running there can read it (and `sandbox_exec` can print it). Register a token scoped to the one repository and revoke it when the work is done. A box booted with a workspace's token can only be reused by that same workspace.

### Patch Changes

- Updated dependencies [877bc60]
- Updated dependencies [d7e24ba]
  - @agentproto/sandbox@0.10.0

## 0.6.0

### Minor Changes

- fdb7e74: Add `sandbox_exec` MCP tool for sandbox command execution

### Patch Changes

- d8142d1: The stable `agentproto-workstation` e2b template now bakes CLI 1.16.0 (adapters opencode 1.6.8, hermes 0.4.34, mastra-agent 0.7.29), so stable boots no longer reinstall the CLI on every start.
- 35fffc9: Pin the workstation template to @agentproto/cli 1.16.0 and record the dev template rebake.
- 35fffc9: Regenerate workstation template pins (cli 1.16.0, refreshed adapter and opencode-ai versions) and the derived baked metadata via `sync-templates`. No API change.
- ecb70c1: sandbox_exec on e2b no longer kills the command after e2b's 60-second default; an omitted timeoutMs now runs as long as the box lives.
- Updated dependencies [fdb7e74]
  - @agentproto/sandbox@0.9.0

## 0.5.17

### Patch Changes

- @agentproto/sandbox@0.8.5

## 0.5.16

### Patch Changes

- @agentproto/sandbox@0.8.4

## 0.5.15

### Patch Changes

- @agentproto/sandbox@0.8.3

## 0.5.14

### Patch Changes

- a18c4d7: Security dependency bumps from the pnpm audit: `ai` 6.0.277→6.0.300 (adapter-ai-sdk) and `e2b` 2.51.0→2.52.1 (sandbox-e2b). Root `pnpm.overrides` also pins `undici`, `brace-expansion`, and `basic-ftp` to patched ranges across the workspace.
  - @agentproto/sandbox@0.8.2

## 0.5.13

### Patch Changes

- @agentproto/sandbox@0.8.1

## 0.5.12

### Patch Changes

- Updated dependencies [f6b1555]
- Updated dependencies [f6b1555]
  - @agentproto/sandbox@0.8.0

## 0.5.11

### Patch Changes

- @agentproto/sandbox@0.7.4

## 0.5.10

### Patch Changes

- @agentproto/sandbox@0.7.3

## 0.5.9

### Patch Changes

- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).
  - @agentproto/sandbox@0.7.2

## 0.5.8

### Patch Changes

- @agentproto/sandbox@0.7.1

## 0.5.7

### Patch Changes

- Updated dependencies [b7b85d6]
  - @agentproto/sandbox@0.7.0

## 0.5.6

### Patch Changes

- @agentproto/sandbox@0.6.2

## 0.5.5

### Patch Changes

- @agentproto/sandbox@0.6.1

## 0.5.4

### Patch Changes

- Updated dependencies [e412bd8]
  - @agentproto/sandbox@0.6.0

## 0.5.3

### Patch Changes

- @agentproto/sandbox@0.5.3

## 0.5.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/sandbox@0.5.2

## 0.5.1

### Patch Changes

- 750839b: Test-only: replace presence-only env gates for live e2e suites (moonshot, hermes bin, Box, e2b/OpenRouter) with runtime preflight credential/capability probes that skip loudly on definitively dead credentials and run honestly on ambiguity.
  - @agentproto/sandbox@0.5.1

## 0.5.0

### Minor Changes

- d3f0e0d: Expose sandbox liveness separately from session liveness: optional `SandboxProvider.probe()` with `SandboxProbeResult`, a portable `SandboxBoxGoneError` sentinel (e2b maps provider 404s to it), a `GET /sandboxes/:id/alive` runtime route, a new `"gone"` sandbox-ledger state with `sandboxAlive`/`sandboxCheckedAt` projected onto session summaries, and a LIVE column plus `--no-probe` flag for `sandbox list`.

### Patch Changes

- Updated dependencies [5c0acd2]
- Updated dependencies [d3f0e0d]
  - @agentproto/sandbox@0.5.0

## 0.4.2

### Patch Changes

- Updated dependencies [d034471]
- Updated dependencies [648e789]
- Updated dependencies [87a2814]
- Updated dependencies [834bfb8]
- Updated dependencies [feffc34]
  - @agentproto/sandbox@0.4.0

## 0.4.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/sandbox@0.3.1

## 0.4.0

### Minor Changes

- 5328e9b: Introduce template version management system for agentproto-workstation e2b template. Establishes `templates/workstation/versions.json` as the canonical pin declaration (CLI, adapters, runtime, base image) and introduces `scripts/sync-templates.mjs` to regenerate all derived artifacts. Enhances `@agentproto/sandbox-e2b` provider with `resolveUpdateCli()` function to intelligently skip the on-boot CLI install when a template's recorded baked image provably carries the requested CLI version—defaulting conservatively to install when the bake is unproven, maintaining backward compatibility.
- db90fb3: Implement port exposure for sandboxes. Add `expose(port)` method and `ports` map to `BootedSandbox` to enable agents to expose HTTP server ports inside sandboxes as publicly accessible URLs. Support pre-declaring ports via `extraPorts` in the sandbox spec for eager resolution at boot time. E2B provider implements port exposure via `sandbox.getHost(port)`. Surface exposed ports in `SessionDescriptor` and `SessionSummary` via new `sandboxPorts` field.

### Patch Changes

- 1817079: Fix adapter installation in e2b template: use one ARG per package instead of space-separated list (E2B's builder mangles spaces in ENV values), consolidate toolchain into single `npm i -g` invocation, and generate Dockerfile from versions.json to prevent pin drift.
- 3c6ca11: Record stable e2b workstation template as proven with real baked CLI and adapters (0.17.0 + hermes/opencode); skip on-boot npm install when template is proven and cliVersion matches, reducing boot time by ~90s on default paths.
- b1b569c: Add mastra-agent adapter support and sandbox resource configuration. The mastra adapter's heavy runtime install requires 2048 MB memory (vs. e2b's 512 MB default), which would otherwise OOM. Resource flags are now validated in versions.json and threaded into build commands as required CLI arguments to `e2b template create`.
- 49a89ba: Fix sandbox spec field forwarding in HTTP path and prevent VM leaks on boot/reconnect failures.

  **@agentproto/runtime**: Fixed #1150 regression where `POST /sessions/agent` silently dropped `extraPorts`, `env`, `lifecycle`, and other fields from inline sandbox specs. Extracted shared schema `sandboxSpecWithReuseSchema` to ensure both HTTP and MCP paths validate against identical schema and forward all fields.

  **@agentproto/sandbox-e2b**: Centralized sandbox cleanup on boot/reconnect failure to prevent VM leaks (observed live: six boxes left running without sessions). Added fast-fail mechanism that exits immediately when daemon crashes during boot, surfacing captured stderr for diagnostics, instead of blocking the full readiness timeout.

- 0deea71: Update stable e2b template to include mastra-agent adapter 0.6.0 in baked image attestation.
- Updated dependencies [db90fb3]
- Updated dependencies [c71753a]
  - @agentproto/sandbox@0.3.0

## 0.3.7

### Patch Changes

- @agentproto/sandbox@0.2.6

## 0.3.6

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
  - @agentproto/sandbox@0.2.5

## 0.3.5

### Patch Changes

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.
  - @agentproto/sandbox@0.2.4

## 0.3.4

### Patch Changes

- 6e403f8: Skip integration test when OPENROUTER_API_KEY is missing
- c4ca23a: Separate integration tests from unit tests via dedicated vitest configs, add auth error handling (gracefully skip on 401/403), install hermes adapter in sandbox boot, and increase test timeout from 120s to 240s. Improves test reliability and maintainability without API changes.
  - @agentproto/sandbox@0.2.3

## 0.3.3

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.3.2

### Patch Changes

- @agentproto/sandbox@0.2.2

## 0.3.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
  - @agentproto/sandbox@0.2.1

## 0.3.0

### Minor Changes

- 6c35cb9: add config.setupCommands provision hook to e2b sandbox boot
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 5615d80: Run setupCommands even when the e2b daemon is already autostarted
- Updated dependencies [013e7b3]
- Updated dependencies [e81ad25]
- Updated dependencies [15abbee]
  - @agentproto/sandbox@0.2.0

## 0.2.1

### Patch Changes

- 8e44bce: Pin the boot-time `@agentproto/cli` install to a configurable `cliVersion` (defaulting to `@latest`) instead of a hardcoded `@agentproto/cli@latest`, so a broken `@latest` npm publish can no longer silently kill the sandbox on boot.
  - @agentproto/sandbox@0.1.5

## 0.2.0

### Minor Changes

- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option

### Patch Changes

- 3d403d7: Fix e2b sandbox timeout issues and add poll resilience.

  Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

  Changes:
  - **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
  - **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
  - **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
  - **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)
  - @agentproto/sandbox@0.1.4

## 0.1.3

### Patch Changes

- @agentproto/sandbox@0.1.3

## 0.1.2

### Patch Changes

- @agentproto/sandbox@0.1.2

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/sandbox@0.1.1

## 0.1.0

### Minor Changes

- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- 414a327: e2b sandbox: update CLI on boot and open daemon origin allowlist
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support

### Patch Changes

- Updated dependencies [126f7c6]
- Updated dependencies [e029a35]
- Updated dependencies [553597a]
  - @agentproto/sandbox@0.1.0
