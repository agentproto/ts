# @agentproto/runtime

## 5.30.0

### Minor Changes

- aca2e3a: Make the AIP-42 `on` map of a workspace `AGENT.md` live: the daemon scans manifests on every routine reconcile and fires their `agentproto:session-completed` actions for that agent's sessions.
- 0c114ae: Add the opt-in brain-ingest reaction on `agentproto:session-completed`, owned per workspace via `defaults.reactions.brainIngest.workspaces`, with boot reconciliation and a gateway handle method.
- 56b7fd0: Add an opt-in durable reaction that dispatches the AIP-68 clerk pass, per workspace, while preserving the legacy dispatch as the default owner.
- 86e541d: Resolve event routines and agent `on:` maps into one shape of event binding exposed by the routine registrar, adding `resolveRoutineEventBinding`, `resolveAgentOnBindings`, `matchEventFilter`, `EventBindingError`, and `eventBindings()` on the routine registrar.
- 639d67f: Turn resolved event bindings into runnable reaction bindings with one typed action registry and the action, tool, workflow and agent target arms.
- 2e3fa73: Reaction chains now carry their causation through every arm, so the depth cap bounds sessions started by tool and workflow reactions too.
- dae78b8: Add the generic durable reaction runner over the reaction receipt store with single-flight execution, retries, recursion capping and boot reconciliation.
- 9ae92a7: Wire AIP-41 event routines into the daemon through a hot-refreshed reaction runner binding set.
- 5ce470d: Add a synchronous reaction runner health read model, one structured trace line per terminal transition and a read-only `GET /reactions` route.
- ff060de: Add the durable reaction receipt store for action hooks with durable pending and running writes, a five-state lifecycle, redaction, retention and load validation.
- fb5159a: Add the `session:archive` action so an event routine can archive the session of a completed event through the durable reaction runner.
- bcb6a8c: Keep sandbox gc off boxes a live successor or paused teardown holds
- a68476e: Discover Chrome browser UUID, fail loudly, add key/select/wait tools
- 1d7b55a: Add auto sandbox provider with capacity overflow from computer to e2b
- 8d53429: Add model lists with selectors, ordering and composition. A seeded `zero-cost` list (catalog price 0/0) replaces the free-model predicates, and the runtime enforces one generic `modelPolicy` (`allow`/`block` over list ids, set on `agent_start`) at spawn, `setModel`, restart and rotation instead of any free-versus-paid rule. Also, `getEnrichment` now tags zero-priced LLMs `price:zero` on both the explicit and inferred paths. The runtime gains a `~/.agentproto/model-lists.json` store plus `model_list_save`, `model_list_list`, `model_list_delete` and `model_list_resolve` MCP tools.
- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.
- 76003b9: Declare native hook capabilities under `capabilities.hooks`, report them from harness capability discovery, and echo a session harness's declared hooks from `session_capabilities`.
- 8c4169e: Make `allowPromptFrom` and `operatorLabel` survive restart/continue-fresh and the HTTP spawn path.

  - New MCP tool `agent_set_operator_label`: lets the human operator stamp a
    session's operator-assigned `operatorLabel` directly, without a fresh root
    spawn.
    Needed for a lineage that has lived by resume/continue-fresh since before
    it ever got a label, so there was never a prior label for the existing
    carry-forward logic to propagate.
  - `session_restart` and `session_continue_fresh` now also carry forward
    `allowPromptFrom` from the replaced session to its successor, the same way
    they already carry forward `operatorLabel`. Previously a permanent agent's
    drive grants (e.g. a `label:` grant) were silently dropped at the next
    restart/continuation.
  - `POST /sessions/agent` now applies `allowPromptFrom` post-spawn, the same
    way the `agent_start` MCP tool handler already does. Previously the HTTP
    spawn path (used by non-MCP callers such as Pygmalion's `EngineClient`)
    silently accepted and dropped the field.
  - New route `POST /sessions/:id/prompt-policy`, the HTTP twin of
    `agent_set_prompt_policy`: (re-)grants `allowPromptFrom` on a session
    that is ALREADY LIVE, for a non-MCP caller. The spawn-time field above
    only reaches a fresh spawn, so a permanent `keepAlive` agent already
    running before a grant was added would otherwise never pick it up until
    it happens to restart.

- 5a429e0: Corrective bump for PR #2177: beyond the reliability fixes already covered by
  `.changeset/follow-sentinel-message-reliability.md` (bumped `patch`), this PR
  adds new public exports from `@agentproto/runtime` — `PROTECTED_MESSAGE_KINDS`,
  `isProtectedMessage`, `isNoiseMessage`, and `effectiveMessageUrgency` — via
  `export * from "./session-message.js"` in `index.ts`, plus behavior changes
  (blocker/question urgency upgrade, noise-first inbox eviction, the default
  7-day `expiresAt` backstop on follows and session-target sentinels, and the new
  `sweepWiringLifecycle` pass). Repo bump rules make added exports and behavior
  changes a `minor`; combined with the committed patch changeset the release
  resolves to `minor`.
- 8c4169e: Carry `allowPromptFrom` forward across `session_restart` / `session_continue_fresh`, apply it on the HTTP `POST /sessions/agent` spawn path, and add the operator-only `agent_set_operator_label` MCP tool for stamping a session's `operatorLabel` without a fresh root spawn.
- 8d53429: Add model lists with selectors, ordering and composition. The new `zero-cost` list (seed: catalog price 0/0) replaces every free-model predicate in the runtime, and `getEnrichment` now tags zero-priced LLMs `price:zero` on both the explicit and inferred paths. The runtime gains a `~/.agentproto/model-lists.json` store plus `model_list_save`, `model_list_list`, `model_list_delete` and `model_list_resolve` MCP tools. `@agentproto/model-intel` reuses an internal `isZeroPriced` helper for the same rule.
- 3d5d2eb: Add `turnRetry.fallback` overlays that move a failed session across models, auth profiles and harnesses after same-config retries are exhausted, recording each step and emitting a `session:fallback` event.
- d3d7119: Add AIP-46 session presets: `tags`, `extends`, `defaultFor`, `modelPolicy`,
  nested `config` and key-merged `options` on the user preset store; one pure
  session-config resolver shared by the spawn path and exposed as
  `agentproto preset resolve` / `user_preset_resolve`; preset model policies
  compose with the request's so both apply.
- 804db17: Make computer sandbox boot visible, bounded, and honest about impossible capacity: register a `starting` session row before the box boots and adopt it once the driver session exists (with a new `sandbox` provisioning phase), give the whole provider boot one deadline that fails with a typed `sandbox_boot_timeout` naming the stuck phase, refuse requests above the tenant's total budget with `sandbox_capacity_exceeds_budget`, log one daemon line per boot phase through the new optional `SandboxBootOpts.log`, and abort a boot whose `starting` row is killed (provider create requests are aborted on a create-phase deadline, and a completed boot is torn down so a killed spawn can never resurrect). `sandbox-computer` also gains `ComputerControllerClient.getCapacity()`, the `bootDeadlineMs` config, and additive error fields (`budget`, `phase`, `timeoutMs`, `sandboxId`); its bump is `minor` because those exports are new.
- ff060de: Add the durable AIP-71 reaction receipt store for action hooks. The new exports (`createReactionReceiptStore`, `buildReactionReceiptKey`, `ReceiptTransitionError`, `RECEIPT_REDACTION_REVISION`, and the receipt types/options) provide durable pending/running/terminal writes, a five-state lifecycle, redaction, retention, and load-time validation. Persistence is enabled by default when using the built-in receipt path.
- dae78b8: Add the generic durable reaction runner over the reaction receipt store: single-flight execution, deterministic retry backoff, recursion capping, boot reconciliation and a retry/sweep tick. Exposes `createReactionRunner` and the `ReactionTarget`, `ReactionBinding`, `ReactionRunner` and related types.
- d57dccf: Add `WorkflowRunner.dispose()`: a new exported method that clears the runner's trailing-flush and lease-heartbeat timers, unsubscribes its session-event-bus listeners, removes its process-exit drain, and awaits queued persistence so a test or shutdown path can tear down a persist directory without racing an in-flight write.

  > Reviewer note: the PR's existing `.changeset/workflow-runner-dispose.md` marks this `patch`, but a new exported method on the public `WorkflowRunner` interface is a new feature. If this file lands alongside it, changesets selects the highest bump (minor). Adjust/supersede the existing changeset accordingly.

- 9ae92a7: Wire AIP-41 `schedule.kind: "event"` routines into the daemon: `createReactionWiring`/`sessionFactsOf` turn resolved event bindings into reaction bindings, and `ReactionRunner.replaceBindings` hot-swaps the live binding set on every reconcile/boot. The agent-arm guard now fails closed when an event's session facts cannot be read.

  Document how event routines are resolved in the routine README.

- 02c8d08: Add in-place merging for queued session-follow digests: a busy follower now receives one persisted digest carrying all coalesced events (with a 50-entry cap) instead of a new digest per flush. This also exposes the digest/merge hook on the sessions registry.
- 2e3fa73: Reaction chains now carry their causation through every arm: the runner derives each receipt's reaction depth and caused event id from the completing session's facts, enters an async reaction context around every target, and stamps sessions spawned inside it with origin and reaction meta. The depth cap therefore bounds sessions started by tool and workflow reactions too. This mirrors the existing `.changeset/action-hooks-reaction-causation.md` in the PR.
- 5ce470d: Expose reaction runner health through a new `ReactionRunner.health()` read model and a read-only `GET /reactions` HTTP route, add a `ReactionWiring.current()` accessor, and emit one structured trace line per terminal reaction transition on a separate `trace` channel.
- fb5159a: Add the `session:archive` action so an event routine can archive the session of a completed event through the durable reaction runner. The handler skips missing, already-archived, alive, pinned and keepAlive sessions with an `outcomeRef`, and surfaces an archive failure as a retryable reaction failure.
- 3c0045a: Add a persisted, bounded `dedupeKey` to prompt admission (`enqueuePrompt` and the MCP `agent_prompt` tool) so a retried prompt is delivered at most once inside a 24 hour window, returning `delivery: "duplicate"` with no delivery or queue mutation.
- aca2e3a: Make the AIP-42 `on` map of a workspace `AGENT.md` live: the daemon rescans `.agents/<id>/AGENT.md` on every routine reconcile, scopes each entry to sessions whose `meta.agentId` matches the declaring agent, and fires the named action for `agentproto:session-completed`.
- 8955834: Add `sandbox_list` / `collectSandboxInventory` for a unified, per-provider sandbox inventory. `sandbox_gc` defaults to `computer` only, and reports an explicit `e2b` sweep as `notScanned` (the shared account writes no daemon marker, so its boxes cannot be attributed to this daemon).
- 3c0045a: Add a persisted, bounded `dedupeKey` to prompt admission so a retried prompt is delivered at most once inside a 24 hour window. The exported `PromptDelivery` union gains `"duplicate"`; a consumer with an exhaustive switch must handle it.
- 8955834: Add sandbox_list across every concrete provider; sandbox_gc now defaults to `computer` only (its controller scopes boxes to this daemon's tenant), and refuses an explicit e2b sweep because that shared account writes no daemon marker at boot
- 2797c4a: Add per-call human approval for imported MCP tools. A `hold` rule in `.agentproto/hooks.json` matching an imported tool (for example `send_message` on agentpush) now parks the call as a real pending permission (`allow_once` / `reject_once`, fail-closed on timeout, session death and shutdown) before it reaches the upstream server; `deny` and `gate` rules are treated as the same human hold at this seam. New exports `ToolPermissionRequest` and `ToolPermissionOutcome`, new `SessionsRegistry.requestToolPermission`. An opt-in Telegram bridge (`approvals.permissionTelegramChatId` + `approvals.permissionTelegramUserIds`, plus `permissionTelegramAlias` and `permissionTelegramTools`) mirrors each pending permission on the configured tools to a chat with tap buttons and routes the tap back to the permission, through callback_query updates on a signed telegram inbound endpoint. With no hold rule and no bridge config, behaviour is unchanged.
- 3d5d2eb: Add `turnRetry.fallback` overlays that move a failed session across models, auth profiles and harnesses after same-config retries are exhausted, recording each step and emitting a `session:fallback` event.
- 02c8d08: Merge queued follow digests in place instead of stacking one per flush, retaining both batches across a daemon restart and capping merged events at 50.
- d3d7119: Add AIP-46 session presets: `tags`, `extends`, `defaultFor`, `modelPolicy` and
  an optional nested `config` on the user preset store; one pure session-config
  resolver used by the spawn path and exposed as `agentproto preset resolve` /
  `user_preset_resolve`; preset model policies compose with the request's.
- d57dccf: Add `WorkflowRunner.dispose()` to stop trailing-flush and lease timers, unsubscribe bus listeners, and drain pending persistence writes.

### Patch Changes

- b60089c: Add the internal action-hooks contract types for the action envelope, admission decisions, hook owner, and occurrence keys.
- 1b09503: Add the `agentproto:session-completed` host event with a pure derivation helper and an emitter wired into the runtime composition root.
- a031ce9: Route the existing spawn dedupe and collision decisions through the pure spawn admission policy, with unchanged behaviour.
- 7a90c4b: AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

  Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

  The switched dependents only rename their dependency and import specifiers, hence the patch bumps.

- 97a0074: Rename three packages to their AIP-70 names: `@agentproto/llm-endpoint` to `@agentproto/inference-endpoint` (AIP-61), `@agentproto/app-kit` to `@agentproto/app` (AIP-53) and `@agentproto/mastra` to `@agentproto/bridge` (AIP-52). The old names stay as deprecated re-export shims with the same exports, and every workspace dependency, import, test and doc points at the new names.
- ecd171b: Autocompact now fires on sessions whose harness advertises its compact slash command (`/compact`, or `/compress` for hermes) in `available-commands`. It used to require a `compact` session mode, which no real ACP adapter advertises, so the absolute token threshold never compacted a claude-code session.
- 5391176: Checkpoint snapshots no longer miss a same-size edit made in the same second.
- 6366c83: Allow at most one continue-fresh per source session: a duplicate or concurrent call with the same options now returns the first call's checkpoint and successor instead of spawning a second one, while a later call with different options is refused with `already_continued` rather than silently returning the first successor.
- f370600: Extract the durable keyed-row file mechanics into a shared module and use it from the sentinel webhook outbox, with no behavior change.
- 2aea136: Extract the AIP-66 managed cloud spawn surface into the new `@agentproto/cloud-agent` package. The vendor registry, pure spawn resolver and refusal shapes, `meta.cloud` identity helpers, relay session-meta side file and declared-remote spawn env now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- a54ae71: Extract the AIP-65 decision core into the new `@agentproto/decision` package. Policy parsing, bounded evidence collection, and the typed decision primitive now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 89e3acc: Extract the AIP-58 run substrate into the new `@agentproto/run` package. The per-run workspace, the append-only event log, the on-disk run store, the file-backed step cache, and the pure run-record types now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package. The sentinel store, runtime, providers, MCP tools and webhook outbox now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- bf31a70: Stop a late lease heartbeat from recreating a finished run's lease sidecar.
- 15c186b: Persist a workflow run's terminal state before draining the app ledger, so `flush()` waits for the lease sidecar removal once the run is observed done or failed.
- 5a429e0: Harden blocker delivery, inbox eviction, and follow/sentinel lifetimes.

  - `blocker` and `question` messages are never downgraded to `fyi`: an
    explicit `fyi` is applied as `next-turn`, so the recipient wakes (or the
    message parks with the inbox's non-loss guarantee).
  - A full inbox now evicts noise (`notice`/`fyi`) first and never drops an
    un-consumed `blocker`/`question`. When every entry is protected, a new
    noisy message is refused instead; a new protected message may exceed the
    soft cap rather than lose a blocker.
  - Follows and sentinels now carry an `expiresAt` (defaulted to 7 days,
    matching the cron scheduler's owned-job backstop) and a periodic wiring
    sweep removes expired records and those whose recipient is gone or retired
    (relinking to a live successor when one exists). The sweep runs at boot and
    every 60 seconds, cleaning up orphans left by an older daemon.

- c9edab3: Fail open when follow triage throws, and add event timestamps, occurrence keys, task ids and a per-flush digest id to the follow triage ledger.
- 1ac9090: Checkpoint sandbox work every 3 minutes by default instead of 10
- 0f880f5: Stamp `operatorLabel` on operator spawns via `POST /sessions/agent`, matching `agent_start` so `label:` entries in `allowPromptFrom` apply.
- e9256c2: Report installed apps whose dir is gone instead of a no-adapter error
- 2391104: Keep box sessions alive across a dropped relay stream
- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package. The hook configuration, the turn-end subscriber and the pass runner now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 449ab6f: Move the AIP-67 quota API to the new `@agentproto/quota` package. `@agentproto/model-intel` keeps `diffCatalog` and re-exports the quota API as deprecated aliases; `@agentproto/runtime` imports quota symbols from `@agentproto/quota`.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- c2a17e4: Quiesce active workflow runs (cancel, wait for lease release, flush persistence) before tmpdir teardown in the workflow-retry tests, deflaking teardown against late asynchronous writes.
- 2391104: Keep box sessions alive across a dropped relay stream: re-open the structured `/events/stream` from the last consumed transcript seq with a bounded retry budget instead of declaring the box dead, reconstruct live tool-call phase state from flattened relay `[tool]` lines, and surface ring-buffer output on long-poll timeouts so long-running box builds don't trip the stall watchdog.
- f370600: Extract the durable keyed-row file mechanics into a shared module and rewire the sentinel webhook outbox to use it, with no behavior change.
- 0f880f5: Stamp `operatorLabel` on operator spawns made through `POST /sessions/agent`, matching the `agent_start` MCP tool so `label:` entries in `allowPromptFrom` apply to sessions that Pygmalion launches over HTTP.
- c1a17d7: Correct the `ContextProfile` documentation to accurately describe the adapters' `lean` semantics and the built-in executor default, and drop a stale source line reference.
- df98be7: Record follow-triage rule verdicts to the triage ledger for every session-follow event even when triage is disabled. Ledger lines now include `source: "follow"` and `applied: false` in that mode; digest text, urgency, and delivery are unchanged.
- 9d4f337: Fix sentinel triage key timing: record the coalesce key only after a successful delivery so a failed send is retried without being classified as a repeat of itself, and guard the repeat window against backwards clock steps.
- 97a0074: Complete the AIP-52/AIP-53/AIP-61 batch renames: add the canonical `@agentproto/bridge`, `@agentproto/app` and `@agentproto/inference-endpoint` packages (moved from `mastra`, `app-kit` and `llm-endpoint`), keep the old names as deprecated re-export shims, and repoint every workspace dependency, import, test and doc at the new names.

  This complements the changeset already in the PR (`.changeset/aip70-p3-batch7b-renames.md`); the two are merged by changesets so each package is bumped at most once.

- a031ce9: Route the existing spawn dedupe and worktree collision decisions through the pure spawn admission policy. Adds observer parity telemetry and parity tests; no public API change and no behaviour change.
- 1b09503: Wire the `agentproto:session-completed` host event: a pure derivation helper for the terminal-transition occurrence (`exit:<endedAt>`), a bounded in-process emitter wired to `session:exited` and `policy:passed`, and the corresponding bus event type. The PR already ships `.changeset/action-hooks-session-completed.md` with the same package and bump; this file is redundant and CI may drop it. Once completions recorded after the exit event (steward close, `session_mark_completed`, operator "Mark as completed") are emitted too, revisit whether the new host-event contract warrants a `minor` bump.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package: hook configuration (agent > workspace > daemon resolution), the debounced/single-flight turn-end subscriber, and the routine/command pass runner now live there. `@agentproto/runtime` depends on the package and re-exports the same public names, so its public API is unchanged.
- 89e3acc: Extract the AIP-58 run substrate into the new `@agentproto/run` package: the per-run workspace layout, the append-only event log, the on-disk run store, the file-backed step cache, and the pure run-record types. `@agentproto/runtime` depends on the package and re-exports the same public names, so existing consumers keep working.
- ecd171b: Autocompact now recognises the slash command a harness actually advertises in `available-commands` (`/compact`, or `/compress` on hermes) rather than requiring an unadvertised `compact` session mode, so sessions on real ACP adapters compact at the absolute token threshold again. This is already covered by `.changeset/autocompact-advertised-compact-command.md` on the branch; this entry mirrors the same patch bump for the workflow handoff.
- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package (store, runtime, providers, MCP tools, webhook outbox). `@agentproto/runtime` now depends on the package through a runtime-owned platform-port layer and re-exports the same public names, so its API is unchanged.
- 2aea136: Extract the AIP-66 managed cloud spawn surface into the new `@agentproto/cloud-agent` package: the vendor registry, pure spawn resolver and refusal shapes, `meta.cloud` identity helpers, relay session-meta side file, `GIT_TOKEN_ENV`, and declared-remote spawn env (now taking the runtime's remote validators through a `CloudRemotePort`). `@agentproto/runtime` depends on the new package and keeps the same behavior at its spawn/restart call sites.
- 7114c28: Record a host-side `silent` turn-end when an agent acks its wake as an explicit `inbox_ack({ noop: true })` no-op, and let session-follow skip or deliver it like an empty turn.
- b626b79: Classify a Codex usage cap printed as assistant text as provider-limit, so a bare "Internal error" that follows the cap message is attributed to the provider quota rather than a generic turn failure.
- dfb1aef: Rename `@agentproto/redaction` to the AIP-70 name `@agentproto/processor`, with a `@agentproto/redaction` shim that re-exports it unchanged.
- d3ce829: Point the `go-free` and `free-sonnet` model-role presets at `opencode-go/beam-free`: upstream deprecated `opencode-go/longcat-2.5-preview-free`, so the catalog no longer carries it.
- 0aa32f3: Surface the PR's head branch name (`headRefName`) in `review_pr`'s status
  snapshot and in `local-gh` sentinel events, so a watching session can read
  who opened a PR directly from the event's `data` instead of GitHub's
  `author` field — which is always the same bot account for every PR we open,
  and so cannot distinguish which agent/role opened it. The branch's own
  prefix convention (`pm-brain/...`, `mainteneur/...`, `fix-pr-<n>-...`) does.
- 68485ca: Keep sentinel triage from demoting a failing verdict on a head already seen as pending, use a fixed repeat window, and add the event timestamp and triage key to the observation ledger.
- 9d4f337: Record what a triage stage would decide for sentinel deliveries. The new `sentinel-triage` module classifies each session delivery as `wake` or `fyi` using ordered rules (`terminal`, `coalesced-repeat` within 10 minutes, then `default`) and appends an observation-only JSONL line (`applied: false`) to `~/.agentproto/sentinel-triage.jsonl`. Delivery itself is unchanged.
- 7114c28: Record a host-side `silent` turn-end when an agent acks its wake as an explicit `inbox_ack({ noop: true })` no-op, and let session-follow skip or deliver it like an empty turn.
- b626b79: Classify a Codex usage cap printed as assistant text as provider-limit
- 34216fc: Attribute task tools called on the root `/mcp` via `?callerSessionId=` to that session instead of the operator, and add `defaults.tasks.operatorDelegates` to keep the ledger's operator rights for explicitly listed sessions.
- df98be7: Record follow triage decisions in the ledger while triage is off, without changing delivery.
- Updated dependencies [ba7e5a1]
- Updated dependencies [001368d]
- Updated dependencies [7a90c4b]
- Updated dependencies [6b78431]
- Updated dependencies [52f8616]
- Updated dependencies [97a0074]
- Updated dependencies [d3ce829]
- Updated dependencies [61e6068]
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [2aea136]
- Updated dependencies [a54ae71]
- Updated dependencies [89e3acc]
- Updated dependencies [07daf79]
- Updated dependencies [a68476e]
- Updated dependencies [9fbf379]
- Updated dependencies [bee10e3]
- Updated dependencies [1d7b55a]
- Updated dependencies [8d53429]
- Updated dependencies [3e78d31]
- Updated dependencies [84ac51b]
- Updated dependencies [449ab6f]
- Updated dependencies [d3dd524]
- Updated dependencies [76003b9]
- Updated dependencies [5ab8114]
- Updated dependencies [f41d51c]
- Updated dependencies [8d53429]
- Updated dependencies [bee10e3]
- Updated dependencies [804db17]
- Updated dependencies [97a0074]
- Updated dependencies [5ab8114]
- Updated dependencies [3e78d31]
- Updated dependencies [89e3acc]
- Updated dependencies [07daf79]
- Updated dependencies [2aea136]
- Updated dependencies [9ae92a7]
- Updated dependencies [d3ce829]
- Updated dependencies [0865827]
- Updated dependencies [61e6068]
- Updated dependencies [c6e0daa]
- Updated dependencies [dfb1aef]
  - @agentproto/lifecycle@0.2.0
  - @agentproto/agent@0.5.0
  - @agentproto/harness@2.16.0
  - @agentproto/governance@0.2.0
  - @agentproto/governance-engine@0.2.0
  - @agentproto/review@0.7.0
  - @agentproto/inference-endpoint@0.12.0
  - @agentproto/app@2.4.0
  - @agentproto/apps@0.24.2
  - @agentproto/app-client@0.4.4
  - @agentproto/model-catalog@0.14.0
  - @agentproto/sandbox@0.14.0
  - @agentproto/provider-presets@0.7.2
  - @agentproto/mcp-server@0.7.2
  - @agentproto/driver-http@0.2.0
  - @agentproto/driver-browser@0.4.0
  - @agentproto/cloud-agent@0.2.0
  - @agentproto/decision@0.2.0
  - @agentproto/run@0.2.0
  - @agentproto/sentinel@0.2.0
  - @agentproto/adapter-browser@0.9.0
  - @agentproto/model-intel@0.4.0
  - @agentproto/clerk@0.2.0
  - @agentproto/quota@0.1.0
  - @agentproto/acp@0.12.0
  - @agentproto/auth@1.4.0
  - @agentproto/driver@0.4.0
  - @agentproto/routine@0.4.0
  - @agentproto/secrets@2.2.0
  - @agentproto/tool@0.6.0
  - @agentproto/workflow@0.8.0
  - @agentproto/provider-kit@0.5.0
  - @agentproto/manifest@0.2.5
  - @agentproto/processor@0.3.0
  - @agentproto/workflow-runtime@0.20.2
  - @agentproto/workspace-brain@0.5.5
  - @agentproto/eval-reporters@0.2.29
  - @agentproto/telemetry-langfuse@0.2.27
  - @agentproto/providers-store@0.4.1
  - @agentproto/pairing-host@0.2.11
  - @agentproto/storage-github@0.2.2
  - @agentproto/workflow-loader@0.2.10
  - @agentproto/plugin-local-browser@0.3.7

## 5.29.0

### Minor Changes

- d732326: App services run as deterministic managed processes: replace the LLM-prompted owner session with a detached, non-PTY child process spawned and supervised by the daemon (sessions-registry registration, structured `cwd/command/args` service declarations with legacy `entry` compatibility, restart backoff + rolling-window cap, group-kill cleanup gated by PID-identity checks, per-app serialization, own `daemon.resumeServicesOnBoot` knob defaulting on, and full reconcile purging services removed from a manifest).
- a3075d4: Auth-profile switching: pick an existing profile for a session, and move every session off a profile in one command.

  The VS Code extension's session "Auth profile" picker only offered "+ add profile": the existing profiles in `~/.agentproto/auth-profiles.json` were never listed, because the picker showed only the profiles the CATALOG marked eligible for the session's route, and that set is empty whenever the route lookup misses. The picker now lists the profiles the daemon knows (name/label only, never key material) and, when one is picked, restarts the session onto it via `POST /sessions/:id/restart` with `access.profileRef`.

  The new `agentproto sessions switch-profile --from <profileRef> --to <profileRef>` does the same for a whole fleet: every session currently billing against the `from` profile is restarted onto the `to` profile in one command. Live sessions are restarted too (any in-flight turn is interrupted); use `--dry-run` to preview.

  - The restart keeps the session's POSTURE: switching the wallet never silently changes what the agent may do.
  - A restart continues the conversation under a NEW session id, so the cron jobs that targeted the old id are RE-ARMED: their target moves to the successor id (persisted with the job file), instead of failing the next tick with "session not found". Agent-label targets are resolved at fire time and need no re-arm.

- 07f5b70: Autocompact: an ABSOLUTE token threshold that compacts an idle session's context, plus the resume prompt that follows it.

  The context-continuity policy was percent-only (`warnAtPct` / `compactAtPct` / `continueFreshAtPct` / `hardStopAtPct`), which cannot fire on a large window: 558k tokens in a 1M-token context is "55% full", the warn band, so nothing ever compacted while every call re-read the whole context. The new `contextContinuity.autoCompactAtTokens` is a token COUNT, not a percentage, so it behaves the same on a 200k and on a 1M window.

  - Threshold: default 150000 tokens, clamped into `[1000, 200000]` (a value above the maximum is clamped down, never rejected), `0` disables. Configurable per session (`agent_start` → `contextContinuity.autoCompactAtTokens`), per agent/adapter default (`defaults.contextContinuity` / `defaults.adapters.<slug>.contextContinuity` in the daemon config) and from the CLI (`agentproto sessions restart --auto-compact-at-tokens <n>`, which also carries the policy across the restart).
  - Behaviour: fires at a turn boundary only on an IDLE session (turn ended, no background task outstanding), never twice while a compaction is in flight, and compacts through the same `/compact` path as the `session_compact` verb (a checkpoint is written first).
  - Resume: after the compaction a short resume prompt is injected ONLY when a mission is in progress (a non-empty `goal` section in the continuity checkpoint written just before the compaction). The prompt cites the path of the full transcript, so the session can look up anything the summary dropped.
  - `session_context_status` now reports `autoCompactAtTokens` and `autoCompactAboveThreshold`.

  Conversation resumption: two new MCP tools, `transcript_search` and `transcript_read`, that look back along a session's LINEAGE.

  After a restart (or a continue-fresh handoff) the history a session is carrying on lives in its predecessors' transcripts, not in its own: the new row starts with an empty `events.jsonl`. The two tools walk that lineage (the restart link `resumedFrom`, the continue-fresh link `continuedFrom` and the handover link `succeeds`) and return DATED EXCERPTS, never a whole transcript: a per-excerpt cap, a total character cap and a result cap, with the transcript streamed (never slurped).

  The shared logic lives in the runtime package (`transcript-search.ts`, internal: used by the MCP tools and not a public subpath export of `@agentproto/runtime`), not in the vscode package: the vscode extension's `searchTranscripts` command is a UI over the daemon's brain query (`GET /brain/query`), which needs an ingested corpus, while these tools read the transcripts directly and need none.

- 379eb05: Resume the last checkpoint of a session that died, instead of starting over
  from the base branch.

  The daemon already snapshots a sandbox session's uncommitted work and
  force-pushes it to `agentproto-checkpoint/<worktree>` on the workspace
  remote, but that ref is named after the WORK TREE, which is minted per spawn:
  nothing told a relaunch which snapshot belonged to the session that died, so
  every relaunch started from `main` again.

  The session now keeps the link to its own last checkpoint
  (`SessionDescriptor.lastCheckpoint`: ref, sha, branch, session id), written by
  the same code path that creates the checkpoint, so it cannot drift from the
  checkpoint itself. A relaunch resolves that link:

  - `session_restart` of a dead box restores the recorded ref with
    `git restore --source=<ref>` instead of guessing from the branch name;
  - a new `agent_start` linked to a dead session through the new `resumeFrom`
    argument (`{ sessionId }`, or a `{ label }` / `{ taskId }` correlation
    against the dead sessions) restores the same recorded ref and reuses the
    dead session's work branch, so its pushed commits come back as commits;
  - a LIVE session is never resumed - its work is still in its box.

  The correlation keys travel with the resumed session: the task id and the
  label are inherited from the resolved source, so the NEXT relaunch finds the
  session that resumed (not the one it continued). A correlation key always
  resolves to the MOST RECENT checkpoint of the matching dead sessions.

  The restore is a best-effort setup step, never fatal: a missing ref, a
  dirty checkout or a failed fetch leaves the session where it is and says so.
  Only a checkpoint that actually reached the remote is restorable.

- 486339e: AIP-68 clerk hook: a daemon subscriber (`clerk-turn-end`) that runs ONE clerk pass (steward/secretary) after a session's turn ends. The pass is debounced on the session's idle time (10 minutes by default, AIP-68 §3.6), single-flight per session (never two passes on one session at once) and fire-and-forget (the turn is never blocked or slowed). The hook is DISABLED by default and ignores its own sessions, empty turns, interrupted turns and excluded sessions.

  Configuration has three levels, most specific wins (merged per field): the daemon default (`~/.agentproto/config.json` → `daemon.clerk`, disabled), the workspace (`.agentproto/hooks.json` → `hooks.clerk`, the PR #2142 `hooks.enabled` / `on: "turn_end"` vocabulary), and the agent (its manifest's `metadata.hooks.clerk`, or an `agent_start` option's `hooks.clerk`). Fields: `enabled`, `on`, `debounceMs`, `run` (a routine id or a shell command) and `exclude`.

  The `run` arms (`routine` / `command`) are mutually exclusive across levels: the most specific level that names an arm replaces the other one. The command arm is default-deny behind the same allowlist as `command_execute`, supports `$SESSION_ID` in its args, and anchors `run.cwd` under the session's cwd. Sessions spawned by the clerk's own routine are ignored, and `session_continue_fresh` keeps the agent-level hook config.

- 8954bba: Claude Code cloud sessions can now run on a workspace's declared remote (`workspaces.json` → `remote`, set with `agentproto workspace remote set`), the same way a sandbox spawn gets its checkout. You no longer need a local clean, pushed clone.

  `@agentproto/runtime`: a `cloud` spawn (and its restart) on a workspace with a declared `remote` passes the url, branch and a checkout dir inside the session's isolated config dir to the relay. A `credentialRef` is resolved from the keychain into `AGENTPROTO_GIT_TOKEN`; a ref that resolves to nothing refuses the spawn (`cloud_spawn_refused`, field `workspace.remote.credentialRef`). New `cloudRepoSpawnEnv` / `cloudRepoCheckoutDir` helpers.

  `@agentproto/adapter-claude-code-cloud`: new `materializeRepoCheckout`. With `AGENTPROTO_CLOUD_REPO_URL` + `AGENTPROTO_CLOUD_REPO_DIR` set, `session/new` and `session/load` shallow-clone `origin/<branch>`, or fetch and hard-reset an existing checkout. That checkout must pass the usual AIP-66 §3 validation, and `claude --cloud` then runs from it. The git token is only ever read by a per-command credential helper and is removed from the vendor CLI's env.

- a544d88: Continue-fresh no longer renames the session: the new session keeps EXACTLY the previous label and title (like a session that compacts in place), and the continuation lineage is shown separately via a new `continuationGeneration` descriptor field (previous generation + 1, starting at 1; exposed in the session list/show/tree/evidence projections). Sessions still carrying a legacy ` (continued)` / ` (continued N)` suffix get their clean name back on their next continuation (`stripContinuedSuffix`). VS Code session rows show a `↻ N` badge with a "Continued N times — previous: <prev>" tooltip and an action to open the previous session in the chain.
- c9553f7: Let a `prompt-session` cron job target an AGENT LABEL instead of a session id: `action.agent` (or the `agent:<label>` spelling in `sessionId`, from `cron_create` or `agentproto cron add --target-session agent:<label>`). The label is resolved when the job FIRES, not when it is created, so the job survives the target agent being relaunched under a new id (a restart or continue-fresh keeps the label, the id changes). Resolution picks the newest live session with that label (exact, case-insensitive), follows a retired session's successor chain, revives an ended session through the usual restart path, and otherwise fails the tick naming the label; the run result records the session id the label resolved to. Jobs that carry a plain `sessionId` keep working unchanged.
- 46faeb4: Session-follow digests now have a deterministic **triage** stage: every event is classified `wake` / `fyi` / `drop` BEFORE a digest is allowed to wake the follower, so an orchestrator that follows many sessions is no longer woken by dozens of digests an hour that ask for nothing. No LLM is involved, and the whole stage is **disabled by default** - a follow without `triage.enabled` behaves exactly as before.

  The rules, each independently switchable: a `task-changed` the follower made itself is `drop`ped; an `exited` with reason `operator-stopped` / `operator-completed` is `fyi`; an `exited` whose cron run finished OK is `drop`ped; a `turn-end` from a session that reported up to the follower in the last `reportWindowMs` (60s) is `drop`ped (the report already arrived); an empty/cancelled `turn-end` that a new turn superseded is `fyi`; a `pr-opened` / `pr-merged` authored by another live session of the follower is `fyi`. Always wake: `awaiting-input`, `crashed`, and a turn-end carrying a question.

  A digest whose events are all `fyi`/`drop` never wakes - it is parked in the follower's inbox as `fyi`. One `wake` is enough to wake, and the digest then carries only the `wake` events plus a `[session-follow] N other event(s) in info` counter. Every triaged event is appended to `~/.agentproto/follow-triage.jsonl` (`{ ts, follower, event, sessionId, decision, rule }`) as training data.

  Configured per follow (`session_follow`'s `triage: { enabled, rules, reportWindowMs? }`) and daemon-wide (`~/.agentproto/config.json` -> `follow.triage`); the follow's own block wins, per field (a rule set `false` on a follow switches it off; among follows sharing a digest, ON wins). The `classifier` block, daemon config only (it runs a command / HTTP call on the host, so `session_follow` rejects it), is the documented extension point for a future LLM classifier (Jev): it receives the event as JSON and answers `wake`/`fyi`/`drop`; on timeout, error, or an unparsable answer the deterministic rules decide instead.

- a33bdeb: **Output change (backwards-compatible shape, different default fields):** `adapter_list`'s COMPACT default projection no longer includes the `models` id array — it now emits `installed` (package presence: only status `supported` reports false; `available` and `unresolvable` still count as installed) and `modelCount` instead, because the model arrays pushed the whole listing past the daemon's 100 KB MCP result cap and produced a `{ truncated: true }` stub callers misread as an empty list. Consumers needing model ids must pass `full: true` (page it with `limit`/`cursor`). `AdapterListEntry` gains the optional `status` the merged listing already carries.

  `@agentproto/app-client`'s runner picker walks `limit`/`cursor` pages of the compact rows (no `fields` filter — that bypasses the compact projection and would re-ship the unbounded model arrays), filters not-installed catalog rows out of the dropdown, and surfaces a truncated stub as an error instead of an empty list.

  `agentproto-vscode`'s `DaemonClient.listAdapters()` page-walks full detail with `limit`/`cursor` (typed `McpInvalidParamsError` fallback for daemons predating the pagination params, `McpResultTruncatedError` instead of an empty list); `sessionConfig`, the harnesses tree, the Harnesses webview, the auth/model mind map, the auth explorer and the Configuration Lab surface a failed listing as an error instead of "no adapters installed".

- 1b79127: Bind routine workflow targets to their own workspace root
- 7066458: Compact agent_start answers by default and add session_commands tool
- fb8341d: Add the generic **lineage handover** mechanism: a successor session can take over a replaced session's children, so a persistent orchestrator (the "brain") that is replaced by a NEW session (restart, wallet change, continue-fresh) leaves its supervisors/executors reachable.

  - `agent_start.succeeds: "<sessionId>"` declares the new session the successor of another one. Only the human operator, the replaced session itself, or the session that owns it may declare it. On declaration the replaced row's LIVE children are re-parented onto the new session (its `parentSessionId` moves), which is what makes the successor their OWNER for the drive tools (`agent_prompt` / `agent_interrupt` / `agent_kill` / `session_restart` - the session-owner gate keys on `parentSessionId`) and what routes their `message_parent` reports to the successor instead of the dead row. The successor also inherits the replaced row's place in the spawn tree.
  - `session_continue_fresh` does the same automatically: the fresh continuation takes over the retired row's children, so the continued "brain" can still drive them and they can still report up.
  - New MCP verb `session_adopt { childIds, from }` moves named children of a row onto its DECLARED successor. Only the human operator or that declared successor may run it.
  - Every handover records the succession on both descriptors (`succeededBy` / `succeeds`, persisted) and emits a `session:lineage-handover` event on the session event bus (from, successor, adopted/skipped children, reason, actor).

- 39d69ba: Live model switch: the daemon now publishes the harness's OWN model vocabulary on the session descriptor.

  A mid-session model switch sent the CATALOG model id straight to the agent's ACP `model` config option, and a live agent only accepts the values IT advertises: picking `claude-sonnet-5-5` on a claude-code session answered "Invalid value for config option model: claude-sonnet-5-5" and switched nothing.

  - `SessionDescriptor.configOptions` -- a read-time projection (never persisted, like `availableModes`) of the live harness's advertised ACP config options (`session/new` / `session/load_session`), stamped at `list()`/`get()` so `GET /sessions` and `GET /sessions/:id` carry it. The `model` entry is the vocabulary the running agent validates against.
  - `POST /sessions/:id/model` (and `agent_set_model`) now sends a value the agent ADVERTISED verbatim, skipping the catalog wire normalization (vendor-prefix stripping) that would otherwise rewrite an already-advertised value into a string the agent does not accept. A value the agent did NOT advertise is normalized exactly as before.

- d1e8263: Add session_transcript tool and cap turbo concurrency in worktrees
- 1620b03: `message_send` / `message_reply` can now reach any session of the SAME workspace, even without a tree edge. Two permanent agents of one workspace (a marketing officer consulting a PM, a PM agent asking a supervisor session) were refused before because the messaging ACL only knows tree neighbours - parent, direct children, and, with `defaults.messaging.allowSiblings`, siblings. The new allowance is a new config key, `defaults.messaging.allowSameWorkspace` (default `true`), hot-applied like the other `defaults.messaging.*` knobs; set it to `false` to restore the tree-only rule. The message the recipient sees carries the new relation `peer`.

  The allowance is narrow on purpose: it needs the same non-empty `workspaceSlug` on both descriptors. A different workspace, or a session with no workspace slug, is refused exactly as before, and the tree rules are untouched - a parent and a direct child always pass, and a sibling passes with `allowSiblings` (the one exception is a sibling pair linked by a peer group, see below). Two siblings of the same workspace are still gated by `allowSiblings`.

  Same-workspace is not always enough: a deployment may run related agents in DIFFERENT workspaces (a Pygmalion brain and its copywriter in `app-agentik-pygmalion`, the PMs and the OVH supervisor in `agentik-studio`). The new config key `defaults.messaging.peerGroups` (default `[]`) lists groups of workspace slugs, e.g. `[["agentik-studio", "app-agentik-pygmalion"]]`: two sessions may message each other without a tree edge when both workspace slugs sit in the SAME group. The key is hot-applied like the other `defaults.messaging.*` knobs, is validated as an array of arrays of non-empty strings, and applies INDEPENDENTLY of `allowSameWorkspace` - a group link holds even when the same-workspace rule is off. The default stays empty, so a deployment that configures no group behaves exactly as before, and a pair outside every group keeps today's refusal. A session without a workspace slug is never linked.

- 74e8a71: Give the parent-relay token (box `message_parent` relayed to the host parent,
  configured with `AGENTPROTO_PARENT_RELAY_URL`) a full lifecycle.

  The host keeps only the token's SHA-256 hash, persisted (0600) in
  `parent-relay-grants.json` next to the sessions state and reloaded at boot, so
  a host daemon restart keeps live relays. A grant slides on every successful
  use and is renewed by a periodic sweep while both its box session and its
  parent are live; it is revoked when either session ends, is archived or
  forgotten, when the box boot fails, and by the sweep once either session is
  dead; expired grants are pruned. Restarting the box session (live-box
  re-attach or fresh box) re-mints the grant and forwards the remote parent
  again. The box keeps the raw token in memory only. `remoteParent` on
  `agent_start` is daemon-internal: a session caller that supplies it is
  refused, and cron/routine agent jobs strip it.

- 92e4e99: Add one permission decision point, `decide(principal, action, resource, context)` (exported as `decidePermission`), with the v1 action vocabulary (`session.message`, `session.message.interrupt`, `session.drive`, `session.spawn`, `command.exec`, and the rest as declared, not yet routed actions), and a read-only `permissions_explain` MCP tool that answers with the same function.

  The messaging ACL is now one predicate for every entry point: `message_send` / `message_reply`, `message_parent`, `POST /sessions/:id/messages` and the box parent relay all call `decide()`, and `registry.sendMessage` refuses a message whose attached decision does not allow it. The HTTP route now resolves the caller like `/mcp` does (the `?callerSessionId=` query, else the trusted `x-agentproto-caller-session-id` header), honours `defaults.messaging.allowSiblings`, and grants interrupt to a session sender only under `defaults.messaging.agentInterrupt: "allow"`, matching the MCP tool. A caller with no session identity keeps operator rights: it can still message and interrupt any session.

- 1b79127: Bind AIP-41 routine `target.workflow` targets to the routine's own workspace: relative `file` paths resolve against the workspace root, the dispatched `workflow_run_file` call runs with `cwd` set to it, and `input.repoRoot` defaults to it (an explicit `repoRoot` still wins). Adds an exported `RoutineTargetOptions` type and an optional third parameter to `routineTargetToToolCall`; documents the behavior in the routine README and the repo-maintenance ROUTINE manifests.
- 7686e56: Sandbox sessions gain a periodic in-turn checkpoint on its own `on: ["interval"]` trigger, configurable via `sandbox.checkpoint.intervalMs` (default every 10 minutes), so a turn running longer than the box lifetime is checkpointed mid-flight instead of being lost with the box. The periodic tick also guards the box's free disk: under 10% free it emits a warning and forces a checkpoint even when the tree looks unchanged, while `turn-end` now only wires the per-turn hook (explicit `on: ["turn-end"]` configs no longer imply the periodic timer).
- f8a0013: The runtime adds a pageable `adapter_models` MCP tool and an `adapter` filter on `adapter_list`, and its compact `adapter_list` projection now surfaces each adapter's exact `status`, picker `hint`, and `modes` (id/status/status_note) so list-only clients can render readiness without a `full` round-trip; `AdapterListEntry` is typed with the optional `modelDetails` rows.

  `agentproto-vscode` consumes those compact rows in the Harnesses tree, pages per-adapter model detail, and narrows the legacy-daemon fallback to genuine unknown-tool/method errors so a tool-level "adapter … was not found" is no longer misread as a missing tool.

- 62f0ec1: Surfaces a session's daemon-reported `awaitingQuestion` as answerable UI. The runtime adds an optional `SessionAwaitingQuestion.recommended` field (set by the context-continuity ask to `continue-fresh`) so clients can mark the daemon's own recommendation, and the VS Code extension gains a new `agentproto.answerSessionQuestion` command that quick-picks the enumerated options and sends the chosen one verbatim through the normal prompt path. Tree rows, tooltips, webview rows, and the transcript pause card lead with the question text and its options, while an `awaitingInput` session without a question now reads as the calm `idle-awaiting` / "idle, waiting for next prompt" parked state.
- 471c1da: PR provenance is fixed to the sessions that actually wrote the code, not the session that ran `gh pr create`.

  - The footer renders an "Authored by" entry per session that committed to the PR's head branch — each with its own adapter, auth profile, model, sandbox provider and per-session cost — plus an "Opened by" entry for the session that opened the PR. The opener's cumulative cost/tokens are suppressed when authorship is attributed.
  - Authorship is collected per branch from sandbox delivery targets, `Agentproto-Session:` trailers on the PR's commits, and the checkpoint-branch tip (through the configured `refPrefix`), so a branch stays attributable after the registry forgets the box session.
  - The teardown delivery stamps the authoring-session trailer onto the pushed work branch itself via an idempotent `commit-tree` + guarded `update-ref`, so it survives checkpoint deletion.
  - New daemon `pr_open` tool: the host runs `gh pr create` against a named authoring session's pushed branch, stamps the authorship-aware footer, and records the PR against that session; `OpenPrForSessionInput` now keys checkpoint reads off the PR's actual `headRefName`.
  - `openPrForSession` is exported from `@agentproto/runtime` so CLI/HTTP lanes can open PRs on behalf of a box session.

- 486339e: Add the AIP-68 clerk turn-end hook: a debounced, single-flight, fire-and-forget daemon subscriber that runs one clerk pass after a session's turn ends, a three-level (daemon/workspace/agent) configuration resolver, and a routine/command pass runner, wired into `createGateway`. Adds the `agent_start.hooks` field and records the agent-level config on the session descriptor.
- fb8341d: Add a generic lineage-handover mechanism: a successor session takes over a replaced session's position in the spawn tree by re-parenting its live children. New exported helpers (`handoverLineage`, `checkSuccessorDeclaration`, `checkAdoptAuthority`), `succeeds`/`succeededBy` descriptor fields, the `agent_start.succeeds` option, and the `session_adopt` MCP verb.
- 8954bba: Cloud sessions can run on a workspace's declared remote instead of requiring a local clean clone. The runtime passes the remote URL, branch and an isolated checkout dir (plus a keychain-resolved git token when a `credentialRef` is set) to the relay; the adapter materializes a clean `origin/<branch>` checkout and validates it under AIP-66 §3 before running the vendor CLI.
- 1620b03: Messaging can now cross workspace boundaries: `defaults.messaging.peerGroups` links groups of workspace slugs so `message_send` / `message_reply` (and the HTTP typed-message route) may reach a session in a peer workspace without a tree edge, independent of `defaults.messaging.allowSameWorkspace`. The ACL decision is centralized in `resolveMessageAcl` and shared by both the MCP tools and `POST /sessions/:id/messages`; `transcript-fixtures` now accepts the `peer` relation in raw session-message envelopes.
- 92e4e99: Expose the unified permission decision point: `decide(principal, action, resource, context)` (exported as `decidePermission`) with the v1 action vocabulary and the read-only `permissions_explain` MCP tool, and route `message_send` / `message_reply`, `message_parent`, `POST /sessions/:id/messages` and the box parent relay through the same messaging ACL, enforced again at `registry.sendMessage` via the attached `Decision`.
- a3075d4: Auth-profile switching across the fleet and in the VS Code extension.

  `agentproto sessions switch-profile --from <profileRef> --to <profileRef>` moves every session billing against one profile onto another through the daemon's restart-with-override route, with `--dry-run` and `--json` output.

  The runtime re-arms `prompt-session` cron jobs on a session restart: when the conversation continues under a new session id, jobs that named the retired id are re-pointed at the successor (persisted with the job file) instead of failing their next tick. Agent-label targets are resolved at fire time and are left alone.

  `agentproto-vscode`'s session auth-profile picker now lists every profile the daemon knows (eligible ones first, the rest flagged), and applies the pick via `restartSessionWithOverride`, so a session whose route the catalog does not know no longer offers only "+ add profile".

- 39d69ba: Live model switch now uses the running agent's own vocabulary instead of the catalog id.

  `SessionDescriptor.configOptions` (runtime) is a read-time projection of the live harness's advertised ACP `configOptions` (stamped at `list()`/`get()`, never persisted), and `POST /sessions/:id/model` sends an advertised value verbatim rather than catalog wire-normalizing it. The VS Code model picker (`changeModel` / `sessionConfig`) re-reads the live session, offers the agent's accepted values as extra rows, and flags catalog ids the agent would reject as restart-only.

- 379eb05: Resume a crashed sandbox session from its last checkpoint instead of the base branch. Sessions record `lastCheckpoint` when a checkpoint reaches the workspace remote, `session_restart` restores that ref, and the new `agent_start.resumeFrom` (`{ sessionId }`, `{ label }` or `{ taskId }`) links a fresh spawn to a dead session, restoring its checkpoint and reusing its work branch. A live session is never resumed.
- d1e8263: Add the `session_transcript` MCP tool for reading a session's normalised conversation from the daemon's events transcript (with an optional tail `limit`), and add `resolveWorktreesTurboConcurrency` / `WORKTREES_TURBO_CONCURRENCY_ENV` so provisioned worktree setup hooks run turbo with a bounded concurrency.
- 7066458: `agent_start` now answers with a compact descriptor by default (identity/routing fields plus counters), with `full: true` restoring the raw descriptor and `fields: [...]` selecting an explicit allowlist. The harness slash-command list moves to the new paginated `session_commands` tool, referenced from `agent_start` via `commandsRef`.
- 4191fe7: Finish cold-start install and provider auth in one command: share the `config.json` helpers, pin global npm installs to the CLI's prefix, enroll adapters from `agentproto install`, write adapter `api-key` defaults from `auth provider set`, and hot-reload stored provider keys in a running daemon via `POST /providers/reload`.
- 471c1da: PR provenance is fixed to the sessions that actually wrote the code, not the session that ran `gh pr create`. Box sessions (E2B, computer) push their work branch but have no `gh`, so the host's orchestrator session used to open the PR and every PR was credited to the orchestrator: its model, its wallet, its cumulative ledger.

  - The footer now renders an "Authored by" entry per session that committed to the branch — each with its own adapter, auth-profile (wallet), model, sandbox provider and per-session cost — plus an "Opened by" for the session that opened the PR. When authorship is attributed, the opener's cumulative cost/tokens are suppressed, so a PR never shows a $469 ledger that belongs to the orchestrator.
  - Authorship is tracked per branch from complementary sources, all keyed off the PR's head branch: sandboxed sessions' `sandboxDeliveryTarget.branch` (checkpoint/delivery/rescue pushes), `Agentproto-Session: <id>` trailers on the PR's commits, and the trailer on the tip of the branch's checkpoint ref (read through the configured `refPrefix`) — `collectBranchAuthors`, `sessionIdsFromTrailers`. Trailers keep a branch attributable after the registry stops knowing the box session.
  - New daemon-side `pr_open` MCP tool: the host runs `gh pr create` (it holds the token; boxes never do) against a named authoring session's pushed branch, stamps the authorship-aware footer, and records the PR against that session. The caller of `pr_open` renders as "Opened by". It is gated like `command_execute`: `gh` runs in the TARGET session's own workspace (its worktree, or for a sandbox session the host checkout of its registered workspace), never the daemon's boot workspace, and `gh` must be in THAT workspace's `.agentproto/allowed-commands.json` (with an argv that permits `gh pr create`). A calling session may only open a PR for itself or a session it spawned (directly or transitively); the operator lane is not scoped. Anything else is refused with an explicit error.
  - `openPrForSession` is exported from `@agentproto/runtime` so CLI/HTTP lanes can open PRs on behalf of a box session too.

  - Review follow-ups on the authorship lane: an ARCHIVED session is credited with its model, wallet and cost (the registry resolves it even though `list()` hides it), branch-based matches are scoped to the PR's own workspace (branch names are repo-local, another workspace's `wt/feat` no longer leaks into the PR), a footer that gains an author (or a richer rendering of one) is re-rendered instead of keeping the opener's ledger, and the "Opened by" entry survives a cost refresh. The checkpoint namespace the stamper reads is the one the delivery actually pushed to (the session's per-spawn `refPrefix` wins over the daemon's global default), the work branch is not stamped when the uncommitted-work snapshot already carries the session trailer (that stamp made the checkpoint unrestorable), and a restarted session's live-box delivery now carries the restarted session id, so its authorship survives in the trailers.

  - Review follow-ups on the `pr_open` gate: the footer stamp's own `gh` calls (`gh pr view`, `gh pr edit`, and the checkpoint `gh api` read) now go through the same `authorizeArgs` gate as the `gh pr create` itself, an allowlist entry that does not permit those argv stops them instead of running them unaudited (the PR still opens and is recorded, it just loses its footer); and when the uncommitted-work snapshot exists but its checkpoint push FAILED, the work branch is stamped and re-pushed as a recovery so attribution does not die with the failed rescue.

- fb025f0: Provider-control-plane orphan GC: `agentproto sandbox gc` and the new `sandbox_gc` MCP tool sweep a provider for boxes it still holds (and still charges RAM for) that the daemon's sandbox registry never knew and that no live session references, listing them (state, age, memory) and deleting them with `remove(..., { force: true })` only under `--apply` (dry run by default).

  A candidate must be PAST A 15-MINUTE GRACE WINDOW (`ORPHAN_GRACE_MS`) and carry NO attached session (`sessions === 0`); the new `--include-attached` CLI flag (and the MCP tool's `includeAttached`) lifts the attached-session check explicitly. A box the provider does not date can never be proven stale and is never proposed. The shared gone-detection of the ledger gc (`GONE_RE`/`isGoneError`) now also decides "already disappeared" on the provider sweep, and a sweep that never ran (no daemon, no provider configured, no `listBoxes`) is reported as `not scanned` instead of "no orphan found".

  Adds `SandboxProvider.listBoxes`/`SandboxProviderBox`, the computer provider's `GET /v1/computers` listing (`ComputerControllerClient.listComputers`), the `computerListEntrySchema`/`computerListResponseSchema` contract, and the `--provider` / `--include-attached` CLI flags. A box held by a live session is never a candidate and a failing provider is reported without stopping the sweep of the others.

- 7686e56: Sandbox sessions gain a periodic in-turn checkpoint on its own `on: ["interval"]` trigger (configurable via `sandbox.checkpoint.intervalMs`, default every 10 minutes), so a turn running longer than the box lifetime is checkpointed mid-flight and not lost with the box. `"turn-end"` keeps wiring the timer as before, so an explicit `["turn-end", "teardown"]` config needs no migration. The periodic tick now also guards the box's free disk: under 10% it forces a checkpoint (bypassing the unchanged-since-last skip, but never running concurrently with another checkpoint) and emits a one-time warning into the session's transcript. New exported surface: `DISK_GUARD_MIN_FREE_FRACTION`, `buildDiskFreeCommand`/`parseDiskFree`/`diskFreeFraction`, and the proxy's `onWarning` callback.
- 4191fe7: Finish cold-start install and provider auth setup in one command, and let a
  hot reload rotate or retract keys the store injected earlier.
- 9309cd5: The prompt-cache split (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) now survives the durable usage path. `usage_rollup` buckets sum it as a window delta, a sandboxed session's usage read-back forwards it from the box's `session_usage` answer (new exported `projectRemoteUsage`), and the direct-child rows of `session_usage` with `includeSubtree` carry their own split, with `reasoningTokens` rolled into the subtree totals. A field that no session reports stays absent and never reads as a measured 0.
- f8a0013: Keep the VS Code harness surfaces under the daemon's MCP result cap after the `adapter_list` compact change. `agentproto-vscode`'s `DaemonClient.listAdapters()` now pages the COMPACT rows (no `full`) and exposes `getAdapter(slug)` / `listAdapterModels(slug)` for one adapter's detail; the harnesses tree, auth/model map, auth explorer, Configuration Lab, spawn wizard, change-model and session-config pickers load detail per adapter only when they need it. The runtime adds an `adapter` filter to `adapter_list` and a NEW pageable `adapter_models` tool so even a runaway model list (opencode is ~700 ids) can be fetched one page at a time. The runtime's compact `adapter_list` projection now also surfaces each adapter's exact `status`, picker `hint`, and `modes` (id/status) — enough for list-only UI clients to render without a `full` round-trip — and `AdapterListEntry` is typed with the optional `modelDetails` rows `adapter_models` serves.
- 62f0ec1: A session parked on the daemon's `awaitingQuestion` is now answerable in one click from the VS Code session list and the transcript panel. The tree row and webview list lead with the question text ("Context is at 69%. Continue fresh to avoid losing continuity?" with its `continue-fresh` / `handoff:*` / `keep-going` options), the tooltip carries the full option list with the daemon-recommended one check-marked (NEW `SessionAwaitingQuestion.recommended`, set by the runtime's context-continuity ask to `continue-fresh`), and a new `agentproto.answerSessionQuestion` command quick-picks those options and sends the chosen one verbatim through the normal prompt path. A session flagged `awaitingInput` WITHOUT a question no longer alarms: it reads "idle, waiting for next prompt" with the calm quiet dot (tree icon `iconForSession`, webview list `idle-awaiting` row status, transcript tab `titleStatusState` refinement). The transcript pause card renders the question text, heuristic-source hint, and the same option buttons — each sending the exact option string via the normal composer send path.
- b58e083: Restore wallet (auth-profile) choice in the VS Code launch and change-wallet pickers after the catalog went compact. The runtime's `catalog_models` COMPACT rows now carry the cheap presence ids — `eligibleProfiles`, `adapters`, `adapterModes` — so a client paging COMPACT rows can resolve "which wallet can bill this route" without a `full: true` round trip that overruns the MCP result cap and truncates to a stub the client misreads as an empty catalog. `agentproto-vscode`'s `DaemonClient.catalogModels()` now pages that tool with `limit`/`cursor` (falling back to one unpaged full call on pre-pagination daemons) instead of asking for the whole full catalog in a single result — the truncated full response used to leave the spawn wizard on the manifest fallback (no route, so only the daemon's default wallet ever attached) and the change-wallet access chip offering only "Add a new wallet". It also accepts an optional adapter slug, and every adapter-scoped picker (spawn wizard, change-model, session config/access, transcript route chip, Configuration Lab) now asks with it: the unscoped route unions every curating adapter's auth surface, so its eligibleProfiles could name wallets that adapter's spawn then refuses with `access_profile_ineligible` (the reported `moonshot-api` / `claude-sdk` 400). Also fixed: the wizard no longer fetches the whole catalog up front, only the picked harness's slice.

### Patch Changes

- d03ca33: Autocompact: the resume prompt now fires only when there is real work in progress, and the full transcript pointer survives the compaction.

  Two fixes to the autocompact path (`contextContinuity.autoCompactAtTokens`):

  - Resume: the short resume prompt is injected after an automatic compaction ONLY when the session really had work in progress at the moment of the compaction, read from the runtime state captured BEFORE the `/compact` prompt went out: a background task outstanding, a tool call still unanswered (or a parked permission request), or a last turn that ended on an error or an interruption. A user stop (`cancelled`) and a session parked on an unanswered question are NOT work in progress: resuming would restart what the user stopped, or drop the pending question. The session title and the checkpoint's goal are NEVER the trigger. The checkpoint's goal section falls back to the session title, so the goal-based rule fired on essentially every session and spent a turn (and a model call) to wake an idle agent that had nothing to resume. The goal survives only as optional text inside the resume prompt.
  - Transcript lookup: the compaction always carries the path of the full transcript and a reminder that `transcript_search` / `transcript_read` exist, so the session can recover whatever the summary dropped. A harness whose compact command takes an argument (claude-code: `/compact <instructions>`) gets it on the command itself; for every other harness the same one-line reminder rides along with the NEXT prompt the session receives, exactly once, and never as a turn of its own. The resume prompt cites the path and the two tools too.

- e4ca9cc: Relay `message_parent` from inside a box (E2B / computer) to its host parent.

  A session running inside a box has no local parent row (the parent lives in
  the HOST daemon's registry), so `message_parent` failed with "no recorded
  parent". The host now forwards a remote parent (parent session id + relay URL
  - a short-lived, single-session-scoped token) into the box's own
    `agent_start`; the box's `message_parent` relays the report to the host's
    relay endpoint, which resolves the recipient from the token and delivers it
    to the parent through the ordinary message path (kind/urgency preserved).
    Without a configured relay URL the behaviour is unchanged (the current clear
    error).

  The relay token is treated as a secret: it never lands on a session
  descriptor nor on disk (the persisted row carries only the parent session id
  and the relay URL), so a box daemon that restarts fails `message_parent` with
  a clear "relay token lost after restart" instead of sending an
  unauthenticated report. The grant slides its expiry on every successful
  relay use, is revoked when the host-side box session ends (or when the box
  boot fails), and expired grants are pruned.

- a884e9d: Carry the CALLER SESSION IDENTITY of a daemon-spawned session on its `/mcp` mount in a header as well as in the URL query, and recognize the daemon's own endpoint by origin + path instead of by exact string.

  A session that reaches the daemon anonymously is a session the daemon cannot reason about: `message_parent` answers "cannot identify the calling session", and every spawn that session makes lands as a depth-0 orphan with no parent (the auto-parent has no identity to derive - see `spawn-attach.ts`).

  - The identity now travels two ways on a daemon mount: the `?callerSessionId=` query (unchanged, still the form the trust checks read) and a new `x-agentproto-caller-session-id` header. A URL query is the fragile carrier - a client or an intermediary that rebuilds the mount URL drops it - while the header travels with the request whatever the client does to the URL. The gateway reads whichever carrier survived (the query wins when both are present), and the header is honoured on the same trust footing as a query claim (loopback socket or a valid daemon bearer).
  - A mount is recognized as "this daemon's own `/mcp` endpoint" by origin (host:port) and path, not by exact string equality. An ambient mount (a project `.mcp.json`, an operator's global MCP config, a config a supervisor passed down) spells the same endpoint differently - `localhost` vs `127.0.0.1`, a trailing slash, a `?host=...` query - and every one of those spellings used to fail the exact match, so the mount was never identity-stamped. A foreign endpoint, and the scoped `/mcp/orchestrator` sub-gateway (which attributes through its own scope token), are still left untouched.
  - A restart or a continue-fresh strips the retired session's own identity header alongside its own query stamp, so a fresh session never keeps speaking to the daemon under the dead session's id.

- 43e1fbc: Detach and tear down computer boxes on session kill, crash, and shared-box survivor teardown.
- 42f8b1c: Documentation sync for already-shipped features. The CLI references now document the `capabilities.deferredToolDiscovery` gate on the daemon self-mount (a harness that cannot call a tool omitted from its last `tools/list` gets an eager `?deferred=0` mount), the `sandbox_checkpoint_gc` plan/apply steps in the `maintain` workflow (with `safe`/`keep`/`unknown` classification and `--apply-merged` gating), and the corrected conditional requirement for `transmit_message.sessionId` (required with the default `bind: true`, optional with `bind: false`). No runtime behavior changes.
- e4d1185: Run `sandbox_exec` against an existing computer box without consuming a session slot or disturbing the in-box daemon: adds an optional `SandboxProvider.connectForExec` exec-only attach path and has `sandbox_exec` prefer it, falling back to `connect()` for providers that don't implement it. Note: the PR already carries an equivalent changeset (`.changeset/sandbox-exec-no-session-slot.md`); this file is only a reviewer handoff and may be dropped if the existing one is kept.
- 43e1fbc: Detach and tear down computer boxes on session kill, crash, and shared-box survivor teardown. A killed session on a shared box now releases its provider/controller slot without stopping the box under the survivors, an operator kill on an already-ended (crashed-adapter) sandbox row retries box teardown, and the computer provider's holder-scoped detach is idempotent. Adds an optional `detach()` seam to `BootedSandbox`/`SandboxAgentSessionHost`. Note: the PR already carries an equivalent changeset (`.changeset/computer-box-detach-leaks.md`); this file is only a reviewer handoff.
- d03ca33: Autocompact only injects the resume prompt when the session really had work in progress at compaction time, and the full-transcript pointer (`transcript_search` / `transcript_read`) is carried both on the compaction command for harnesses that accept instructions and as a one-shot note on the next prompt for the rest.
- e489439: Page the session-steward `session_list` scan under the MCP result cap (50 rows per page across 16 pages) and fail loudly on a truncation hint instead of reading it as an empty result. The runtime change is regression-test coverage only (bytes-capped `session_list` fixture plus pagination/workflow tests).
- 36ac93e: Pick the most recent checkpoint when a relaunch correlates a dead session by task id, matching the existing most-recent rule for labels, and add regression coverage for inherited correlation keys and non-`wt/` delivery branches.
- 9705c46: Forward the agent-level `hooks` object (including `hooks.clerk`) from `POST /sessions/agent` and `POST /sessions/chat` to the shared spawn core, so an HTTP spawn no longer silently drops a manifest's `metadata.hooks.clerk` and behaves like the MCP `agent_start` path.
- 36ac93e: Inherit resume correlation keys and pick the most recent checkpoint
- e4d1185: Run sandbox_exec on a busy computer box without taking a session slot or disturbing its daemon.
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

- 6a2542f: Fix role/orchestrator propagation through the sandbox start path: a sandbox spawn with `role: "supervisor"` + `orchestrator: true` no longer receives the executor disposition in the inner prompt, and role-defaulted sandbox orchestrator spawns resolve supervisor (the delegation surface exists inside the box). An executor stays a leaf: no orchestrator scope is ever forwarded for a delegation-denied role.
- Updated dependencies [d732326]
- Updated dependencies [9bf6d95]
- Updated dependencies [c66d8bf]
- Updated dependencies [43e1fbc]
- Updated dependencies [a33bdeb]
- Updated dependencies [1b79127]
- Updated dependencies [e613028]
- Updated dependencies [42f8b1c]
- Updated dependencies [e4d1185]
- Updated dependencies [e613028]
- Updated dependencies [1b79127]
- Updated dependencies [ab53381]
- Updated dependencies [43e1fbc]
- Updated dependencies [9bf6d95]
- Updated dependencies [e489439]
- Updated dependencies [c14b061]
- Updated dependencies [ab53381]
- Updated dependencies [e4d1185]
- Updated dependencies [fb025f0]
- Updated dependencies [a63eafb]
- Updated dependencies [4191fe7]
  - @agentproto/app-kit@2.3.0
  - @agentproto/model-catalog@0.13.2
  - @agentproto/apps@0.24.1
  - @agentproto/sandbox@0.13.0
  - @agentproto/app-client@0.4.3
  - @agentproto/routine@0.3.3
  - @agentproto/driver-agent-cli@2.15.0
  - @agentproto/providers-store@0.4.0
  - @agentproto/mcp-server@0.7.1
  - @agentproto/llm-endpoint@0.11.15
  - @agentproto/workflow-runtime@0.20.1
  - @agentproto/workspace-brain@0.5.4
  - @agentproto/review@0.6.2
  - @agentproto/eval-reporters@0.2.28
  - @agentproto/telemetry-langfuse@0.2.26

## 5.28.0

### Minor Changes

- 7bf4955: Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, and a `catalog_diff` MCP tool in `@agentproto/runtime` backed by a persisted snapshot store — plus a `model-catalog-watch` app (daily cron routine + workflow: sync → diff → gate → free-model digest).
- ed1462e: Add operator approval to bypass branch_gc guard; make verdict writes safe
- cc06be2: Add sandbox_checkpoint_gc daemon tool and wire it into maintain workflow
- e2d0b48: Send the repo-maintenance notify step through the provider-agnostic `transmit_message` primitive (with an optional `notify` target of `{ provider, alias, address, source }`) instead of a hardcoded agentpush MCP alias; allow `transmit_message` to send with `bind: false` and no `sessionId`.
- 7bf4955: Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, a persisted-baseline `catalog_diff` MCP tool to `@agentproto/runtime`, and ship the `model-catalog-watch` bundled app (daily cron routine + `watch` workflow: sync → diff → gate → free-model digest) in `@agentproto/apps`.
- 8b228b0: Add `AgentStep.access` / `AgentStep.route` and forward model-role auth `profile` and `route` to the maintain workflow's reviewer spawns. Add the opt-in `maintain --apply-reviewed` input, which reclaims agreed `review`-class branches subject to `branch_gc`'s line-coverage guard and reports guard refusals in the run report.
- cc06be2: Add the `sandbox_checkpoint_gc` MCP tool (plus `sandbox_checkpoint_gc_status`) for sweeping stale `agentproto-checkpoint/*` refs, a `SandboxCheckpointGcRunner` port wired through the serve gateway, and checkpoint plan/apply steps in the repo-maintenance `maintain` workflow.
- ed1462e: Add an optional `operator` approval to branch verdicts: with `includeReviewed`, an operator block bypasses `branch_gc`'s deterministic line-coverage guard for the exact tip and the plan records who bypassed it. Also make verdict-store writes lossless under concurrency by serialising per-file writers in-process and committing each write with a unique temp file plus atomic rename.
- 4d50b9b: Sandbox cost guardrails and device liveness:

  - e2b: a box whose spec declares `lifecycle.pause_after_idle` is created with `lifecycle.onTimeout: "pause"`, so a box that outlives its provider timeout is parked instead of destroyed. New `config.onTimeout` (`"pause" | "kill"`) overrides it.
  - runtime: the idle reaper honours a box's own `lifecycle.pause_after_idle` window when it is shorter than `daemon.sandboxIdleReapAfterMs` (new descriptor field `sandboxPauseAfterIdleMs`).
  - runtime: `device:` spawns probe the paired host's `/health` when it isn't already known online, and fail fast with a typed `device_offline` code (HTTP 400) instead of a generic `sandbox_boot_failed`, so a caller can fall back to a sandbox or queue the work.

- e2d0b48: Send the repo-maintenance notify step through the provider-agnostic `transmit_message` primitive (with an optional `notify` target of `{ provider, alias, address, source }`) instead of a hardcoded agentpush MCP alias, and allow `transmit_message` to send fire-and-forget with `bind: false` and no `sessionId`.
- 8b228b0: Pass a model role's auth `profile` and `route` to the maintain workflow's reviewer agent steps, and add the opt-in `applyReviewed` input that reclaims agreed reviewed branches under branch_gc's line-coverage guard.
- 4d50b9b: Sandbox cost guardrails and device liveness:

  - e2b: a box whose spec declares `lifecycle.pause_after_idle` is created with `lifecycle.onTimeout: "pause"`, so a box that outlives its provider timeout is parked instead of destroyed. New `config.onTimeout` (`"pause" | "kill"`) overrides it.
  - runtime: the idle reaper honours a box's own `lifecycle.pause_after_idle` window when it is shorter than `daemon.sandboxIdleReapAfterMs` (new descriptor field `sandboxPauseAfterIdleMs`).
  - runtime: `device:` spawns probe the paired host's `/health` when it isn't already known online, and fail fast with a typed `device_offline` code (HTTP 400) instead of a generic `sandbox_boot_failed`, so a caller can fall back to a sandbox or queue the work.

### Patch Changes

- b2593c3: Add `capabilities.deferredToolDiscovery` and wire it through the adapter resolver: a harness that cannot call a tool omitted from its last `tools/list` (opencode rejects it client-side) now gets the daemon self-mount eager, so `daemonMount` no longer hides `branch_gc_verdict` and other tools behind a `tool_search` the model cannot use.
- f641bc8: Persist the sandbox session holder on the session descriptor and replay it on both re-attach paths (`session_restart` and the boot-time reattach pass). Sandbox spawns now send the agentproto session id to the provider as `config.sessionHolder`, and no secret is persisted.
- Updated dependencies [7bf4955]
- Updated dependencies [ed1462e]
- Updated dependencies [cc06be2]
- Updated dependencies [b2593c3]
- Updated dependencies [e2d0b48]
- Updated dependencies [7bf4955]
- Updated dependencies [8b228b0]
- Updated dependencies [cc06be2]
- Updated dependencies [ed1462e]
- Updated dependencies [e2d0b48]
- Updated dependencies [8b228b0]
  - @agentproto/model-intel@0.3.0
  - @agentproto/apps@0.24.0
  - @agentproto/driver-agent-cli@2.14.0
  - @agentproto/workflow-runtime@0.20.0
  - @agentproto/sandbox@0.12.2
  - @agentproto/review@0.6.2
  - @agentproto/eval-reporters@0.2.27
  - @agentproto/telemetry-langfuse@0.2.25

## 5.27.1

### Patch Changes

- 7411ddf: `computer` sandbox provider: `daemonRoute` no longer requires `gatewayUrl`. A configuration that sets both is rejected with a clear error instead of silently falling back to the explicit gateway. This also applies when `gatewayUrl` comes from the stored provider profile or `COMPUTER_GATEWAY_URL`, so remove it before enabling `daemonRoute`. Ports can only be exposed with `daemonRoute` disabled. The `setup_sandbox_provider` fields document that `gatewayUrl` is optional and mutually exclusive with `daemonRoute`.

## 5.27.0

### Minor Changes

- 9a90833: Persist the orchestrator scope-token registry to `orchestrator-scopes.json` (mode 0600, atomic debounced writes) so `/mcp/orchestrator?scope=` URLs already baked into session descriptors keep authorizing across a daemon restart, prune dead-owner and orphaned unowned tokens at boot, and adopt legacy tokens minted by older daemons from the session descriptors that still reference them (never wider than the default tool subset). Adds new exported API: `orchestratorScopesFile()`, `adoptLegacyOrchestratorScopes()`, `collectReferencedOrchestratorScopeTokens()`, the `ScopeTokenRegistryOptions` type, and an optional `opts` parameter on `createScopeTokenRegistry()`.
- 57ae214: `branch gc` gains two safety mechanisms. Orphan refs whose tip IS a base remote's `refs/pull/<N>/head` are classified `forge-mirror` and reclaimed without running the ladder (the forge keeps those refs forever, so the local ref is never the only copy), and their restore log re-fetches the PR head instead of `update-ref`. Separately, `includeReviewed` now refuses an agreeing verdict deterministically: the tip carries `lineCoverage` (the share of its non-trivial added lines already present verbatim in base's version of the same path), and an approval below `minLineCoverage` (default 95, configurable via `agentproto branch gc --min-line-coverage PCT`, the `branch_gc` MCP tool, and the daemon HTTP surface) leaves the ref `review` with `verdictGuard` / `refused-guard` rather than reclaiming it. The repo-maintenance reviewer prompt and review-queue builder surface `lineCoverage` so reviewers account for the missing lines.
- 9a90833: Persist the orchestrator scope-token registry to `orchestrator-scopes.json` (mode 0600, atomic debounced writes) so `/mcp/orchestrator?scope=` URLs already baked into session descriptors keep authorizing across a daemon restart, prune tokens whose owning session is gone or unrecoverable at boot, and adopt legacy tokens minted by older daemons from the session descriptors that still reference them (never wider than the default tool subset). This also adds new exported API — `orchestratorScopesFile()`, `adoptLegacyOrchestratorScopes()`, the `ScopeTokenRegistryOptions` type, and an optional `opts` parameter on `createScopeTokenRegistry()`.
- ca9dc5e: Add the `quota_status` MCP tool (AIP-67) and `agentproto quota status --profile <ref> [--refresh] [--json]`: live provider quota for a named auth profile, read through `@agentproto/model-intel`'s `QuotaReaderRegistry`.

### Patch Changes

- 6d8a531: `computer` sandbox provider: optional extra request headers (`extraHeaders` config, `COMPUTER_EXTRA_HEADERS`, and the `COMPUTER_ACCESS_CLIENT_ID` / `COMPUTER_ACCESS_CLIENT_SECRET` pair mapped to `CF-Access-Client-Id` / `CF-Access-Client-Secret`) for a controller reached through an authenticating proxy. Values are never logged and are redacted from errors.

  New `daemonRoute` mode (`config.daemonRoute` or `COMPUTER_DAEMON_ROUTE=1`): drive a computer through the controller's own URL instead of a per-port gateway. The provider keeps controller credentials out of client-facing handles — `BootedSandbox.mcpUrl`/`authHeaders` only ever carry the box's own per-box daemon token, never the controller-wide credential or the edge Access secret, so nothing persisted into a session descriptor or an exported MCP config can leak them. `expose()`/`extraPorts` are rejected with a clear error in this mode (the controller route reaches only the daemon's own port). The runtime setup fields gain `daemonRoute`, `accessClientId` and `accessClientSecret`.

  Also carries the daemon bearer / `/mcp` / `COMPUTER_GATEWAY_URL` / published-port recovery fixes from the previous provider change that did not reach main.

- 8ea3ce4: Source comments and docs now use neutral example domains (`example.com` / `example.dev`) instead of real hostnames. No behaviour change.
- 4c5f6e4: Add `agentproto sandbox checkpoint-gc` plus the underlying `@agentproto/worktree` engine (`planSandboxCheckpointGc` / `applySandboxCheckpointGc` / `reclaimOneSandboxCheckpoint`) that reaps stale remote `agentproto-checkpoint/*` refs whose rescued work is provably elsewhere (PR merged/closed, snapshot tree already in the work or base branch, or a clean snapshot whose parent landed via merge/squash/patch). Dry run is the default; `--apply` re-plans fresh before each delete. A new best-effort `SandboxCheckpointReclaimer` port is wired into the daemon so a sandboxed session's own ref is deleted at exit when superseded, never failing the session.
- 13390f0: Ship `docs/mcp-tools` alongside the bundled `cli.mjs` so `tool_help` and `agentproto help <tool>` find long tool docs in the published CLI package. The CLI build now copies `runtime/docs/mcp-tools` into the CLI package and lists `docs` in `files`; a new bundled-layout test in the runtime package guards the resolution path.
- 22ab84f: `allowPromptFrom` entries may now name callers by session label: `label:<exact label>` grants a caller whose registered label matches, and `label:<prefix>*` grants any caller whose label starts with the prefix. Covering this PR's runtime change; note the PR already ships `.changeset/prompt-allow-by-label.md` for the same package, and the review flags that mutable labels are a weak authorization key.
- 22ab84f: `allowPromptFrom` entries may now name callers by label: `label:<exact label>` grants a root caller session (no parent) whose operator-assigned, immutable label matches, and `label:<prefix>*` grants any such caller whose label starts with the prefix. The label (`operatorLabel`) is stamped only when the human operator spawns the session via `agent_start`, carries over `session_restart` and `session_continue_fresh`, and cannot be changed with `session_rename` or by child sessions, so the grant survives the caller restarting under a new session id without being spoofable.
- 4c5f6e4: Sandbox checkpoint refs no longer accumulate forever. `agentproto sandbox checkpoint-gc` (dry run by default, `--apply` to delete) lists every remote `agentproto-checkpoint/*` ref with its work branch, PR state, and verdict: safe when the PR of `wt/<slug>` is merged or closed on the forge, when the snapshot's tree is already the remote work branch's or the base branch's tree, or (for a clean snapshot) when the parent's commits are merged, squash-merged or patch-merged into the base. A snapshot whose tree differs from its parent's counts as uncommitted work and can only be proven safe by the PR or tree tiers; anything else is kept. The daemon also runs the same classification best-effort at a sandboxed session's exit and deletes the session's own ref when it is superseded, logged, never failing the session.
- 13390f0: Ship `docs/mcp-tools` alongside the bundled `cli.mjs` so `tool_help` and `agentproto help <tool>` find long tool docs in the published CLI package.
- Updated dependencies [d81be85]
- Updated dependencies [bec9df2]
- Updated dependencies [305199d]
- Updated dependencies [9ebf51d]
- Updated dependencies [c6ddf99]
- Updated dependencies [57ae214]
- Updated dependencies [305199d]
- Updated dependencies [d81be85]
  - @agentproto/app-kit@2.2.0
  - @agentproto/model-catalog@0.13.1
  - @agentproto/acp@0.11.3
  - @agentproto/sandbox@0.12.1
  - @agentproto/model-intel@0.2.0
  - @agentproto/apps@0.23.7
  - @agentproto/providers-store@0.3.32
  - @agentproto/driver-agent-cli@2.13.3
  - @agentproto/pairing-host@0.2.10
  - @agentproto/llm-endpoint@0.11.14

## 5.26.0

### Minor Changes

- e9e2cb5: `chrome-live` gains two agent-surface features, exposed as new MCP tools in `@agentproto/runtime`:

  - **File upload onto a real `<input type=file>`** — `browser_upload_file { sessionId, selector, paths, tabId? }` attaches local files through CDP `DOM.querySelector` + `DOM.setFileInputFiles` (the same mechanism devtools uses; the input is fed, never written back out). Every path must be absolute+existing and live inside an upload allowlist: the agent's workspace + `~/.pygmalion/data` by default, extendable via `AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS` (a `:`-separated dir list). Outside the allowlist → typed refusal, the driver is never touched.
  - **Several tabs in the agent's own window** — `browser_new_tab { sessionId, url? }` opens a FRESH tab (the same activate-anchor → `Target.createTarget` → `getWindowForTarget` flow as the first tab, never a reuse, never the user's windows), `browser_list_tabs { sessionId }` lists the agent-owned tabs (`{ targetId, url, windowId }[]`), and every existing browser tool already accepts those `tabId`s.

  `ChromeLiveInstance` grew `uploadFileOwnedTarget` / `newTabOwnedTarget` / `listOwnedTabs`; `evalRaw` on `ChromeCdpDriver` became `protected` so the live driver can probe the file input first (`no <input type=file> matches selector …`).

- 46244e2: Decouple the compaction handoff turn from `/compact`. A `/compact` or `/compress` prompt still writes a checkpoint before the harness compacts ("no checkpoint, no compaction" unchanged), but does so from the transcript alone by default — no billed handoff turn put to the live session. New `contextContinuity.compactHandoffTurn` flag (default `false`) restores the previous behaviour: when `true`, the prompt asks the live session for a handoff turn (goal, decisions, risks) before building the checkpoint. The context-rescue path (`runtime:context-rescue`) never asks, and explicit handoffs (`session_checkpoint`, `session_continue_fresh`) are unchanged.
- 743fa74: New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and `sharedSessions: true` capability plus a per-process `maxSessions` cap. The runtime registry adds the `sharedSessions` capability field (default `false`) and stores token/controllerUrl credentials for the provider.
- f2205fd: Add a recent-activity guard to `worktree gc`: a worktree whose own git index mtime is younger than `--active-minutes` (default 60, `0` disables) classifies `hold` with reason `recent-activity`, at plan time and again in apply's pre-removal re-check, so an actively-edited worktree is never reclaimed or salvaged. Plumbed end-to-end through the worktree engine (`PlanGcInput`/`ApplyGcOptions`), the runtime `worktree_gc` MCP tool and `POST /worktrees/gc` body, the `agentproto worktree gc --active-minutes` CLI flag, and the VS Code daemon client (`DaemonClient.gcWorktrees`). Apply outcomes and daemon plan/outcome views now carry the hold reason.
- ef1c877: Default `turnRetry` for executor and sandbox spawns: a spawn that names no policy now retries transient failures (rate-limit, upstream-5xx, no-output-stall; 6 retries; default backoff) instead of stopping the turn, and a free OpenCode model rotates onto other free ids by default. Supervisor spawns stay opt-in, and an explicit `turnRetry: null` or empty `on` disables retrying.
- 11f986f: runtime: classify a sandbox box that dies at/after its lifetime deadline while idle as expected expiry (`SandboxBoxExpiredError`), ending the row `status:"exited"` / `endedReason:"sandbox-expired"` instead of `crashed`; add the `sandbox-expired` end reason, a `markSandboxExpired` registry action, and a `type:"branch"` session-outcome artifact carrying the delivered work branch.

  sandbox-e2b: document the plan-level continuous-runtime cap behind the lifetime constants (comment-only).

- 239fe1f: AIP-36 amendment "shared sandbox" — ATTACH / DETACH lifecycle. A provider box can host several sessions at once (`reuse`/`attach`): the sandbox ledger is the durable refcount (`attachedSessions`, robust to a daemon restart). Session teardown is by default a DETACH — stopping session 1 of 2 never kills the box — and only the last remaining session tears the box down. Failed boots/setup of an attaching session detach instead of stopping a shared box (survivors are preserved for a paused box), and `agentproto sandbox list` shows the attached sessions.
- e9e2cb5: `chrome-live` gains two agent-surface features, exposed as new MCP tools in `@agentproto/runtime`:

  - **File upload onto a real `<input type=file>`** — `browser_upload_file { sessionId, selector, paths, tabId? }` attaches local files through CDP `DOM.querySelector` + `DOM.setFileInputFiles`. Every path must be absolute+existing and live inside an upload allowlist (the agent's workspace + `~/.pygmalion/data` by default, extendable via `AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS`).
  - **Several tabs in the agent's own window** — `browser_new_tab { sessionId, url? }` opens a FRESH tab, `browser_list_tabs { sessionId }` lists the agent-owned tabs, and every existing browser tool already accepts those `tabId`s.

  `ChromeLiveInstance` grew `uploadFileOwnedTarget` / `newTabOwnedTarget` / `listOwnedTabs`; `evalRaw` on `ChromeCdpDriver` became `protected` so the live driver can probe the file input first.

  Note: an equivalent changeset (`.changeset/chrome-live-upload-multitab.md`) is already present in this PR with the same package list and bumps.

- 3c30cda: Bound `session_list` results: an unpaged call now returns at most 50 rows plus `truncated`, `total` and `nextCursor` to page on, and a new `ids` filter reads known sessions without scanning the whole list. Any contract-layer MCP tool result over 100 KB is replaced by a `{truncated, totalBytes, hint}` marker.
- 9b836b4: Per-session git worktrees on a shared sandbox box. A spawn that attaches to a box other sessions may be using (`sandbox.reuse`) now gives the session its own git worktree of the shared per-workspace clone at `<home>/.worktrees/<workspaceSlug>/<slug>` instead of re-checking out that clone and switching the branch (and mixing uncommitted files) out from under the other sessions. Concurrent mutators on the shared clone serialize on an in-box `flock`; the base clone's checkout is not re-pointed at a session's branch. On detach from a still-shared box the session's worktree is removed through the box's exec, but only when it is clean and its branch is fully pushed — leftover work keeps the worktree and logs a notice. A session alone on a fresh box keeps the previous checkout behaviour.
- 743fa74: New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and a `sharedSessions: true` capability plus a per-process `maxSessions` cap.

  `@agentproto/runtime` gains the optional `sharedSessions` sandbox-provider capability field (default `false`) and stores controller token/URL credentials for the provider.

- 0b43b1f: Session-owner prompt gate: `agent_prompt` / `agent_interrupt` / `agent_kill` /
  `session_restart` / `session_continue_fresh` now refuse calls from another agent
  session unless the caller is the target's owner (the spawner, via
  `parentSessionId`, or any ancestor with subtree authority for transitive
  descendants), the target itself, the operator, or named in the target's
  spawn-time `allowPromptFrom` option (session ids or the `"any"` wildcard). Adds
  the `agent_set_prompt_policy` MCP tool for changing the allow-list later, the
  `allowPromptFrom` spawn option and `SessionDescriptor.allowPromptFrom` field,
  exported `session-owner.ts` gate helpers, and a `session:prompt` audit event
  recording who sent each accepted prompt. Spawn-time roles are also forwarded
  onto sandbox box daemons so delegation gates apply consistently.
- f915069: Reap idle sandboxed sessions and tear their box down. New `daemon.sandboxIdleReapAfterMs` (env `AGENTPROTO_SANDBOX_IDLE_REAP_AFTER_MS`, default 15 min, `0` = off) applies a shorter idle threshold to sessions running in a provider box. A reap takes a final checkpoint, then stops the box per the lifecycle policy (kill unless the spec asked to pause), and records `reapedAt`/`reapedIdleMs`/`reapedSessionId` in the sandbox ledger. A later prompt to the reaped row cold-boots a fresh box from the checkpoint branch and delivers the prompt there. Non-sandbox sessions are unchanged.
- 629e42c: Add the InstaBox sandbox provider (`@agentproto/sandbox-instabox`, AIP-36).

  - New `SandboxQuotaError` in `@agentproto/sandbox` and a `truncated` flag on `SandboxExecResult`.
  - `instaboxSandboxProvider` boots an InstaBox VM (always `vault:false`, `onTimeout:"kill"`), installs the agentproto daemon as a systemd unit with a 0600 EnvironmentFile, publishes the daemon port through the public edge, never suspends boxes, deletes the machine on boot failure, and maps account-quota failures to `SandboxQuotaError`.
  - Registered in the runtime provider catalog and the CLI (credential env key `INSTABOX_API_KEY`).

- 3c30cda: fix(runtime,mcp-server): `session_list` returns at most 50 rows by default (`truncated`, `total`, `nextCursor` to page on) and accepts an `ids` filter to read known sessions; any contract-layer MCP tool result over 100 KB is replaced by `{truncated:true,totalBytes,hint}`
- 0b43b1f: Only a session's owner can drive it through the daemon's drive tools. The owner
  of a session is the caller that spawned it (its `parentSessionId`), or the human
  operator for a root spawn. `agent_prompt`, `agent_interrupt`, `agent_kill`,
  `session_restart`, and `session_continue_fresh` now refuse calls coming from
  ANOTHER agent session, unless the target's spawn-time `allowPromptFrom` spawn
  option (session ids, or the wildcard `"any"`) names the caller. The
  `agent_set_prompt_policy` MCP tool changes the list later — only the session
  itself, its owner, or the operator may. The operator (a CLI/HTTP/UI client with
  no caller session) keeps full rights, and all existing parent→child flows keep
  working: the session owner always passes.

  Every accepted `agent_prompt` now also records WHO sent it in the session
  events (`session:prompt`: the trusted callerSessionId, or the literal
  `"operator"` for a no-caller call) — a session-level audit trail of whose
  prompts drive it.

  Role enforcement is consistent in box daemons too: a spawn-time role is
  forwarded onto a sandbox box's own `agent_start`, so the box daemon applies the
  same delegation gate (denyTools on its own daemon self-mount) the host would,
  instead of re-resolving the role from nothing executor-side.

- 9b836b4: Per-session git worktrees on a shared sandbox box (AIP-36 follow-up). A spawn that attaches to a box other sessions may be using (`sandbox.reuse`) no longer re-checks out the shared per-workspace clone — which switched the branch out from under the other sessions and mixed their uncommitted files. Instead it keeps the `<home>/<workspaceSlug>` clone as the shared base and gives the session its own git worktree at `<home>/.worktrees/<workspaceSlug>/<slug>` (`wt/<slug>` cut from `baseRef`, or from `origin/<branch>` when a previous box pushed the work), with kindred branch precedence to the fresh-box checkout. Concurrent `git fetch` / `worktree add` on the shared clone serialize on a `flock` inside the box (`<home>/.worktrees/<workspaceSlug>.lock`); the base clone's own checkout is detached-never-re-pointed. All per-session paths (delivery/checkpoint, restore, cwd resolution, branch learning, teardown) now target the session's worktree. On detach from a still-shared box the session's worktree is removed through the box's exec — but only when it is clean and its branch is fully pushed; any leftover work keeps the worktree and logs a notice. A session alone on a fresh box keeps the exact previous checkout behaviour (no worktree layering, no lock, byte-identical commands).
- 239fe1f: AIP-36 amendment "shared sandbox" — ATTACH / DETACH lifecycle. A provider box can host several sessions at once (`reuse`/`attach`): the sandbox ledger is the durable refcount (`attachedSessions`, robust to a daemon restart). Session teardown is by default a DETACH — stopping session 1 of 2 never kills the box — and only the last remaining session tears the box down (policy a: nothing attached; policy b: all attached idle + `destroyable`). Failed boots/setup of an attaching session detach instead of stopping a shared box; `agentproto sandbox list` shows the attached sessions.
- ef1c877: Graceful turn retry by default for executor and sandbox agent starts: a
  spawn without `turnRetry` now gets a default policy (retry on rate-limit,
  upstream-5xx and no-output-stall; 6 retries; default backoff) instead of
  letting a transient provider failure stop the turn. A free OpenCode model
  also rotates onto other free ids on every covered class by default; paid
  models never rotate by default. Explicit opt-out is `turnRetry: null`, an
  empty `on` list, or the CLI shorthand `--turn-retry off`.
- f2205fd: `worktree gc` now refuses to touch a recently-active worktree. A worktree whose own git index was written within the last 60 minutes (the worktree's private index — checkout/add/commit/status all rewrite it, so a young mtime means someone is working in there regardless of what any session registry knows) classifies `hold` with hold reason `recent-activity`, never `reclaim`/`salvage`, at plan time and again in apply's pre-removal re-check; the index mtime is always read before gc's own `git status` so the sweep can't report itself as activity. Plumbed end-to-end as `activeMinutes` (engine `PlanGcInput`/`ApplyGcOptions`, the `worktree_gc` MCP tool and `POST /worktrees/gc` body, `agentproto worktree gc --active-minutes <n>`, and the VS Code daemon client) with default 60; `0` disables the guard. Apply outcomes and the daemon's plan/outcome views now carry the hold reason, and a plan entry that became recently active between plan and apply aborts as `aborted-reclassified` to hold instead of acting on the stale plan.

### Patch Changes

- 78a3983: `computer` sandbox provider: forward a configurable `egress` allowlist on create (the controller denies all egress, DNS included, without one), and add an optional `tenantId` setup field that fills `COMPUTER_TENANT_ID` from the stored provider profile.

  Boot now works for the unprivileged guest user: the CLI installs under `~/.local` (global `/usr/local` is root-owned), the daemon log moves from `/var/log` (not writable) to `~/.agentproto-daemon.log`, and a non-zero exit from the CLI install or a setup command fails the boot with the step's output instead of timing out on health.

  The boot skips the npm CLI install when the image already carries an `agentproto` CLI (an extra `installPackages` list or a non-matching pinned `cliVersion` still installs), and `gatewayUrl` accepts a `{hostPort}` placeholder resolved from the host port the controller published for the daemon port, so a daemon outside the controller's network can reach a computer through a port forward.

  The pinned `cliVersion` is compared by exact version (a partial pin such as `1.2` no longer matches `1.26.0`), and a reconnect restarts a healthy in-box daemon whose recorded `--allow-origin` no longer matches the current `{hostPort}` origin.

- 80f0060: test(runtime): deflake `registry.recordNotice` — wait for the notice record itself, not just for `events.jsonl` to exist (the write stream creates the file empty before its first queued write lands).
- e736c7c: A `sandbox` spawn with `orchestrator` now forwards the request onto the box's own `agentproto serve` daemon, so the sandboxed supervisor orchestrates children on the same box instead of being handed the host's unreachable loopback `/mcp/orchestrator` mount.
- 01ea248: The imported-MCP passthrough mount `/mcp/imported/<id>` now honours the same `?denyTools=` / `?allowTools=` query contract as `/mcp` (#2050). Filtered tools are hidden from `tools/list`, and a `tools/call` for a filtered name is rejected with a JSON-RPC error (`InvalidParams`) before it ever reaches the upstream import — enforcement, not just hiding. Deny is applied after allow; a name on both lists is excluded. Requests without the params behave exactly as before.
- 629e42c: Fix reattach and event streaming against a gated sandbox daemon, and a silent readFile failure.

  - `SandboxAgentSessionHost` exposes `authHeaders`; the runtime sandbox proxy
    sends them on its raw HTTP reads (`GET /sessions/:id`, the backlog read and
    the SSE event stream). Without them a bearer-gated daemon (InstaBox) answered
    401, so a session could never be re-attached after a host restart and the
    event stream always fell back to polling.
  - InstaBox `readFile` guards its `dd | base64` pipeline with `test -r`, so a
    missing or unreadable file rejects instead of resolving to empty bytes.

- b324f0e: Fixed `agentproto mcp login <alias> --url <url>` always failing with `uses oauth but no keychain secret store is configured`, even right after printing the consent URL and scopes — the CLI's own `setMcpCredentialDeps` call never reached `openMcpClient`'s `createDaemonOAuthProvider`. Root cause: `@agentproto/runtime` ships `./mcp-oauth`, `./mcp-client-pool` and `./mcp-credential-deps` as separate tsup entries (`splitting: false`), so each bundles its own private copy of `mcp-credential-deps.ts`'s module state; a `setMcpCredentialDeps` call reached through one subpath is invisible to `getMcpCredentialDeps()` reached through another. `openMcpClient`'s `OpenMcpClientOptions` now accepts an explicit `oauthSecrets` override, which `mcp login`'s verify step and the daemon's `mcp-proxy.ts` both pass — the ambient singleton (kept, all three exports unchanged) is now only a same-bundle convenience fallback, never load-bearing across a subpath boundary.
- 70d533f: `@agentproto/app-kit` adds newly exported `parseServiceList` (and its `ServiceListResult` type) — a non-throwing wrapper around the `services:` manifest validator shared with `defineApp`/`loadAppHandle`, so callers outside the throw-based `normalizeManifestFields` flow get the same rule set.

  `@agentproto/runtime`'s `parseAppServices` now delegates to app-kit's `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. Install-time validation tightens accordingly (leading-letter names, no unknown object fields, fail-fast on the first bad entry, and an explicitly-present empty `services: []` is rejected).

- 7e5ffd8: fix(agent_start): a `cwd` on a `sandbox` + `workspaceSlug` spawn no longer cancels the in-box workspace setup. The workspace remote is always cloned into the box with the git token and delivery branch, and `cwd` is read as a path inside the box (relative to the checkout, or absolute under the box home); a host-only path or a path outside the box home is ignored with a warning. A sandbox spawn with a `cwd` but no workspace remote now returns an advisory warning that the box has no repo, git token or delivery branch.
- c30bf32: Slim the always-on MCP `tools/list` payload by advertising `agent_start`'s
  (and five other always-on tools') rarely-used nested object options as opaque
  values, with the real zod validation still enforced at call time and the full
  sub-field detail moved to `docs/mcp-tools/*.md` fetched via `tool_help`.
- 9b99d62: Test gateways (`persist: false`) no longer read or write the user's real `~/.agentproto/tunnels.json`, no longer relaunch that file's autostart tunnels (which spawned real `cloudflared` processes with the test workspace as cwd), and persist tunnel state to `<workspace>/.agentproto/tunnels.json` instead. `TunnelRegistry.shutdown()` and the cloudflared providers now also stop a tunnel whose `start()` completes after the shutdown (SIGTERM, then SIGKILL after 3 s), instead of letting it come up and outlive the registry.
- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 2d61d46: fix(sandbox): sandboxed sessions survive a daemon restart and idle reap. The boot reattach pass adopts detached sandbox rows whose workspace bucket no other live daemon serves (they were otherwise stranded as unserved), a restarted sandbox row still awaiting its first prompt gets a 60 min reap grace, a busy mid-turn row is never reapable, an idle reap pauses the box instead of stopping it when the final checkpoint did not secure the work, and the CLI prefixes daemon.log lines with an ISO-8601 timestamp when output is redirected.
- f1d0c95: fix(sentinel): auto-link PRs opened by sandboxed sessions and target the live successor

  A sandboxed session's cwd is a path inside its box, so the PR reconciler's branch lookup found no host checkout and every `gh` call ran in a non-existent directory — the PR was never recorded and no sentinel was created. Sandboxed sessions now resolve their PR from the box work branch (`sandboxDeliveryTarget.branch`) against the workspace's host checkout, and `gh` runs from there; `OpenPrResolver` accepts an optional `{ branch }` override. Auto-link also follows the `continuedTo` chain so a PR recorded on a row that a restart/continue superseded is watched for the live successor, without creating a duplicate sentinel.

- 7e5ffd8: fix(agent_start): a `cwd` no longer cancels the sandbox workspace setup. With `sandbox` + `workspaceSlug`, the git remote is always cloned into the box with the git token and delivery branch, and `cwd` is read as a path inside the box (relative to the checkout, or absolute under the box home); a host path is ignored with a warning. A sandbox spawn with a `cwd` but no workspace remote now returns a warning that the box has no repo, git token or delivery branch.
- 11f986f: Sandbox sessions whose box reaches its lifetime deadline (e2b plan cap: 1h of continuous run on Hobby/Base, active or not) now end cleanly as `endedReason: "sandbox-expired"` / `status: "exited"` instead of being classified `crashed` / `error` without an artifact. The watchdog tags a death at/past the known (renewal-pushed) deadline as expected expiry (`SandboxBoxExpiredError`), the registry ends the row through a new `markSandboxExpired` (same lazy-resumable cleanup as a crash, but no crash status and no restart policy match), and the derived outcome surfaces the delivered work branch as a `type: "branch"` artifact. The e2b provider documents the real root cause of the "active session dies at start+~60min" reports: the plan's total continuous-run window — heartbeat renewal already works and cannot extend past it (Pro plan or e2b pause/resume is the escape hatch).
- 3a50c3d: fix(runtime): sandbox proxy interrupt auth (401) + no-output-stall during tool calls

  Les interrupts vers une session sandbox (E2B) échouaient tous en HTTP 401 :
  le proxy frappait la route brute `POST /sessions/:id/interrupt` du daemon de
  la box, qui exige un Bearer par-boot que l'hôte ne détient jamais — alors
  que le prompt passe par le endpoint MCP, lui accessible. Correction :
  `HarnessClient.interrupt` (`agent_interrupt`) + un `interrupt` sur le host
  daemon ; le `cancel()` du proxy l'emprunte — le même canal MCP que le prompt
  authentifie déjà. Le watchdog de stall ne se déclenche plus pendant un tool
  call en cours (phase `tool-call:*` / tool call actif) : un long `pnpm
install` n'est plus traité comme un stall.

- 2d61d46: fix(sandbox): sandboxed sessions survive a daemon restart and idle reap. The boot reattach pass now adopts detached sandbox rows whose workspace bucket no other live daemon serves (they were stranded as unserved), a restarted sandbox row still awaiting its first prompt gets a 60 min reap grace, and an idle reap pauses the box instead of stopping it when the final checkpoint did not secure the work.
- f1d0c95: fix(sentinel): auto-link PRs opened by sandboxed sessions, and keep the sentinel on the live session across restart

  The PR reconciler (which records a session's opened PR and so triggers sentinel auto-link) used the session's cwd to find the PR, but a sandboxed session's cwd is a path inside its box. The branch lookup found nothing, and every `gh` call ran in a directory that does not exist on the host, so the PR was never recorded and no sentinel was created. A sandboxed session's PR is now resolved from its box work branch (`sandboxDeliveryTarget.branch`), checked against the host checkout of its workspace, and `gh` runs from there. `OpenPrResolver` takes an optional `{ branch }` override for this.

  Auto-link now also targets the end of the session's `continuedTo` chain. A PR recorded on a row that a restart or continue already superseded (for example a sandboxed session moved to a fresh box under a new id) is watched for the live successor, and the successor re-recording the same PR does not create a second sentinel.

- c30bf32: Slim the daemon's always-on MCP `tools/list` payload again. `agent_start`
  drops from ~28.2 KB to ~9.8 KB and the deferred always-on set from ~63.0 KB
  to ~39.0 KB, with no parameter rename, behaviour, default or runtime-validation
  change.

  The remaining weight was structural: roughly fifty parameters, many rarely
  used, with nested object schemas enumerating every sub-field. `agent_start`'s
  structured nested options (`sandbox`, `worktree`, `orchestrator`, `inference`,
  `auth`, `access`, `mcpServers`, `contextContinuity`, `restartPolicy`,
  `costBudget`, `appServe`, `attach`, `options`, `route`, `browser`, `prompt`)
  are now advertised as opaque values (`tool-schema-opaque.ts`, the
  `sandboxCheckpoint` pattern) so `tools/list` sends `{description}` instead of
  every sub-field, while the REAL zod validation at spawn time still runs,
  returns the schema's parsed output (transforms, defaults and unknown-key
  stripping all preserved, e.g. `browser: true` still normalizes to
  `"headless"`) and still reports the original issue path and message (e.g.
  `access.profileRef: ...`). The full sub-field detail moved to
  `docs/mcp-tools/*.md`, fetched on demand via
  `tool_help {name:"agent_start", topic:"<field>"}`.

  The next five always-on tools (`session_list`, `task_create`, `task_update`,
  `agent_prompt`, `message_parent`) get the same treatment at smaller scale, with
  new `tool_help` docs for their opaque nested options. `turnRetry` is untouched
  (another change edits it). The schema-budget test now also caps any single
  always-on tool at 12 KB.

- 7d7aaf9: The `cloudflare-managed` and `cloudflare-provisioned` tunnel providers no longer spawn `cloudflared` when `stop()` ran while `start()` was still awaiting preflight or remote provisioning. `start()` now throws `TunnelStartAbortedError` (settled as `stopped` by the registry) instead of starting a process nothing can stop. Same race `cloudflare-named` and `cloudflare-quick` were already fixed for.
- 9b99d62: Test gateways (`persist: false`) no longer read or write the user's real `~/.agentproto/tunnels.json`, no longer relaunch that file's autostart tunnels (which spawned real `cloudflared` processes with the test workspace as cwd — an orphaned-process leak), and persist tunnel state to `<workspace>/.agentproto/tunnels.json` instead. `TunnelRegistry.shutdown()` and the cloudflared providers now also stop a tunnel whose `start()` completes after the shutdown (SIGTERM, then SIGKILL after 3 s), instead of letting it come up and outlive the registry. A provider that reaps its own process after a mid-start `stop()` now throws the new exported `TunnelStartAbortedError`, which the registry settles as `stopped` (not `error`), so `autostart` tunnels caught mid-start by a restart are relaunched on the next boot.
- 70d533f: `@agentproto/app-kit` exports a new `parseServiceList` — a non-throwing wrapper around the `services:` manifest validator already used by `defineApp`/`loadAppHandle` — so callers outside the throw-based `normalizeManifestFields` flow get the same single rule set.

  `@agentproto/runtime`'s `parseAppServices` now delegates to `@agentproto/app-kit`'s `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. This changes install-time validation behavior: service names must now start with a letter (a digit-leading name like `0abc` is rejected, though consecutive/trailing hyphens are now allowed), unknown object fields on a service entry are now rejected, validation now fails fast on the first bad entry instead of accumulating every entry's errors, and an explicitly-present but empty `services: []` is now rejected instead of being treated as a no-op.

- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [a6f7c8b]
- Updated dependencies [7ed9762]
- Updated dependencies [e9e2cb5]
- Updated dependencies [629e42c]
- Updated dependencies [629e42c]
- Updated dependencies [3c30cda]
- Updated dependencies [70d533f]
- Updated dependencies [a6f7c8b]
- Updated dependencies [3c30cda]
- Updated dependencies [74f982c]
- Updated dependencies [629e42c]
- Updated dependencies [3c30cda]
- Updated dependencies [70d533f]
- Updated dependencies [74f982c]
  - @agentproto/model-catalog@0.13.0
  - @agentproto/adapter-browser@0.8.0
  - @agentproto/sandbox@0.12.0
  - @agentproto/apps@0.23.6
  - @agentproto/app-kit@2.1.0
  - @agentproto/mcp-server@0.7.0
  - @agentproto/a2a@0.2.2
  - @agentproto/acp@0.11.2
  - @agentproto/agent@0.4.1
  - @agentproto/app-client@0.4.2
  - @agentproto/auth@1.3.1
  - @agentproto/command-sandbox@0.3.1
  - @agentproto/driver@0.3.3
  - @agentproto/driver-agent-cli@2.13.2
  - @agentproto/driver-browser@0.3.1
  - @agentproto/driver-http@0.1.13
  - @agentproto/eval-reporters@0.2.26
  - @agentproto/governance@0.1.6
  - @agentproto/governance-engine@0.1.13
  - @agentproto/llm-endpoint@0.11.13
  - @agentproto/manifest@0.2.4
  - @agentproto/pairing-host@0.2.9
  - @agentproto/plugin-local-browser@0.3.6
  - @agentproto/provider-kit@0.4.7
  - @agentproto/provider-presets@0.7.1
  - @agentproto/providers-store@0.3.31
  - @agentproto/redaction@0.2.4
  - @agentproto/review@0.6.2
  - @agentproto/routine@0.3.2
  - @agentproto/secrets@2.1.1
  - @agentproto/storage-github@0.2.1
  - @agentproto/telemetry-langfuse@0.2.24
  - @agentproto/tool@0.5.2
  - @agentproto/workflow@0.7.2
  - @agentproto/workflow-loader@0.2.9
  - @agentproto/workflow-runtime@0.19.1
  - @agentproto/workspace-brain@0.5.3

## 5.25.0

### Minor Changes

- 42dfcb1: Added `session_role_refresh` and `session_role_watch` MCP tools (AIP-42 hot role refresh): a manifest-spawned session's AGENT.md can now be re-read and applied to a live keepAlive session without a restart. A changed role (body/persona/boundaries/traits text) is pushed into the session as a steer notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart` to change. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced, never polling) companion that calls the refresh automatically on every AGENT.md edit — off by default. This generalizes the ad-hoc composed-prompt-hash mechanism apps like Pygmalion previously hand-rolled for their own personas. The `ap-lifecycle` skill doc now documents both tools.
- f0d2860: Add a `telegram` decide channel to the approvals engine: `decideTelegram` plus `POST /approvals/:id/decision/telegram`, gated by a shared bot-bridge bearer secret (`approvals.telegramBotSecret`) instead of `web_click`'s browser Origin check (a Telegram webhook callback has none). Structurally identical to `decideWeb` otherwise — same `ApprovalDecideEvidence` shape, same `click_through` signing method, same "is this approval still pending" + "was the credential right" gate. Off by default (unset secret), same convention as `web_click`'s empty `webOrigins`.
- 345cf99: chrome-live gains the read AND control path that `start_browser` always lacked, all addressing the same agent-OWNED tab (never a foreign one): `navigateOwnedTarget`/`domOwnedTarget` (read) plus new `clickOwnedTarget`/`fillOwnedTarget`/`evaluateOwnedTarget`/`scrollOwnedTarget` (control) — the latter four thin dispatches onto the same owned driver's existing `click`/`fill`/`evaluate` (scroll has no driver primitive of its own; it's an `evaluate` of a generated `scrollIntoView`/`scrollTo` expression). All six go through the same ownership guard as `screenshotOwnedTarget`. `@agentproto/adapter-browser`'s `BrowserAdapterInstance` exposes these as optional `navigate`/`getDom`/`click`/`fill`/`evaluate`/`scroll`, wired for chrome-live — the bridge fills in the kit's required option fields (`trusted`, `clear`, `awaitPromise`, ...) that this facade's simpler surface leaves optional.

  `@agentproto/runtime` adds eight MCP tools, all ONE model (the agent's owned tab): `fetch_page` (plain HTTP read, no browser — `{ title, text, url, blocked }`, `blocked: true` on a 403/429/503/401/407 or a known anti-bot challenge fingerprint from Cloudflare/Akamai/PerimeterX/Datadome/Incapsula) and chrome-live-only `browser_navigate` / `browser_extract_text` / `browser_get_dom` / `browser_click` / `browser_fill` / `browser_evaluate` / `browser_scroll`. `browser_extract_text` and `fetch_page` both purify their HTML with a small Defuddle wrapper (`page-text.ts`) — mirrors `@agentproto/bureau-purify`'s approach rather than depending on it, so the daemon's core runtime stays free of a dependency on a downstream product package; `browser_get_dom` returns the raw serialized DOM for selector discovery instead.

  Resolves a name collision the review caught: the existing, currently-unused `projectBrowserTools` (`browser-projection.ts`) projected a DIFFERENT model (one whole attached instance, no per-agent tab ownership) onto the SAME `browser_navigate`/`browser_click`/`browser_fill`/`browser_evaluate`/`browser_screenshot`/`browser_get_dom` names. Its tools are renamed `browser_kit_*` (capability-gate ids are unchanged — each `ToolSpec` now carries its own `gateId` rather than deriving one from `name`) so the two surfaces can never collide if `projectBrowserTools` ever gets mounted.

- f1e23ad: Added an optional, empty-by-default observer seam on the browser tools (AIP-63 section 7). An operator registers an observer with `registerBrowserObserver` (or points `AGENTPROTO_BROWSER_OBSERVER_MODULE` at an absolute, user-owned, non-world-writable module that default-exports `(api) => void`) to receive `onAttach` / `onDetach` / `beforeCall` / `afterCall` for every `browser_*` call and to transform `browser_screenshot` images before they reach the caller. Observers fail open with a short time budget; only a `required` screenshot transform can fail a call (`browser:transform_failed`). Call arguments are redacted before the observer sees them: a `fill` value and an `evaluate` expression are never passed, not even their length. With no observer registered every tool behaves exactly as before.

  `onAttach` also receives an optional `capture` handle (`screenshot`, `evaluate`) for providers that implement both, so an observer can take its own frames and probe the page without a tool call. `@agentproto/runtime/browser-screencast` is now a public subpath (`encodeScreencastFramesToMp4`, `hasFfmpeg`).

- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`, same `BrowserCookieSource` shape `chrome` already uses) that injects cookies through `Network.setCookies` into ONLY the dedicated, zero-consent Chrome this provider auto-launches — the user's own, attached-to Chrome stays read-only exactly as before. Injection runs on every `attach()` of a dedicated instance, is filtered to the launch's `domains` option (both by the source's own request and, belt-and-suspenders, by this package again), and never logs a cookie value, only a count. This package has no opinion on where cookies come from or who may grant them: `cookieSource` is a pure injection point, no selection or consent logic lives here.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional fields, `domains` and `chromeProfile`, additive and ignored by existing callers (e.g. `chrome`'s own cookie source).

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` (chrome-live only, ignored by every other adapter) and a new `createChromeLiveAdapter(config)` factory so a host can build its own `chrome-live` adapter handle over a custom `ChromeLiveProviderConfig` (e.g. with a concrete `cookieSource`) without touching the default `chromeLiveAdapter` singleton, which ships with no `cookieSource` configured.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()` — chrome-live only, every other adapter ignores them.

- 6e75183: chrome-live now prefers the dedicated, zero-consent Chrome by DEFAULT: a bare `launch({})` launches (or reuses, hot) its own headful Chrome immediately, with no attempt to attach to the user's own Chrome and no consent wait. Attaching to the user's real, logged-in Chrome through the remote debugging toggle (port 9222) now requires an explicit ask — a pinned `wsUrl`/`port` (launch opts, provider config, or `CHROME_LIVE_*` env), or the new `attachIntent: true` launch option — and, as before, falls back to the dedicated Chrome if that attach is not possible. The new `preferDedicated` provider-config flag (`false` restores the old attach-first default for every call on that provider instance) and the new `attachIntent` launch option are both opt-in surfaces; existing callers that already pin an endpoint are unaffected. Two new pure helpers, `pinnedEndpoint` and `wantsAttachFirst`, are exported for testing the routing decision without touching a real Chrome.

  `@agentproto/adapter-browser` (the kit's `chrome-live` adapter description, `browser_adapter_list`) gets the `BrowserAdapterStartOptions.profile` field (`"dedicated" | "personal"`, mapped to `attachIntent` for chrome-live, ignored by every other adapter) alongside its doc-only patch. `@agentproto/runtime`'s `start_browser` MCP tool grows the matching `profile` parameter — an agent asks for `"personal"` only when it needs to see something from the user's own accounts, `"dedicated"` (default) otherwise — on top of its doc-only patch.

- 0939143: Imported MCPs can now authenticate with OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE), so remote MCPs that accept no API key or static header (e.g. Qonto) become usable by daemon-spawned agents. New `agentproto mcp login <alias> [--url <url>] [--scope "a b"] [--no-open]` runs the consent on a one-shot 127.0.0.1 loopback listener, prints the authorization URL and the requested scopes before the click, stores the client + tokens as one keychain item per import (never in `imported-mcps.json`), verifies with `tools/list`, and only then records `auth: { type: "oauth" }` on the import (`--url` creates a manual http import). `mcp logout` forgets the stored state. The daemon refreshes tokens on its own and never starts an interactive flow: when credentials are missing or revoked it fails with `oauth login required … run: agentproto mcp login <alias>`. Stored state is bound to the server origin, so a live-repointed entry never receives tokens. `@agentproto/runtime` adds the `./mcp-oauth`, `./mcp-client-pool` and `./mcp-credential-deps` exports and an `oauth` field on `McpConnectionConfig`.
- 345cf99: chrome-live gains the read AND control path that `start_browser` always lacked, all addressing the same agent-OWNED tab (never a foreign one): `navigateOwnedTarget`/`domOwnedTarget` (read) plus `clickOwnedTarget`/`fillOwnedTarget`/`evaluateOwnedTarget`/`scrollOwnedTarget` (control) — the latter four dispatch onto the same owned driver's `click`/`fill`/`evaluate` (scroll is an `evaluate` of a generated `scrollIntoView`/`scrollTo` expression). All six go through the same ownership guard as `screenshotOwnedTarget`. `navigateOwnedTarget` now reads back the committed `document.location.href` (best-effort) so its returned url reflects redirects. `@agentproto/adapter-browser` exposes these as optional `navigate`/`getDom`/`click`/`fill`/`evaluate`/`scroll` on `BrowserAdapterInstance`, wired for chrome-live.

  `@agentproto/runtime` adds the owned-tab MCP tools `fetch_page` (plain HTTP read, `{ title, text, url, blocked }`), `browser_navigate`, `browser_extract_text`, `browser_get_dom`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_scroll`. `fetch_page`/`browser_extract_text` purify HTML via a small Defuddle wrapper (`page-text.ts`); anti-bot detection is narrowed to challenge-only fingerprints so ordinary vendor-fronted pages no longer report `blocked`. The unused `projectBrowserTools` surface is renamed to `browser_kit_*` (with explicit per-`ToolSpec` `gateId`s) so it can never collide with the owned-tab tool names.

- 42dfcb1: AIP-42 hot role refresh: new `session_role_refresh` and `session_role_watch` MCP tools re-read a manifest-spawned session's `AGENT.md` and apply the parts that can change in place without a restart. A changed role (body/persona/boundaries/traits text) is steered into the live session as a notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart`. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced) companion that refreshes automatically on each AGENT.md edit — off by default and in-memory only. The `ap-lifecycle` skill doc documents both tools.
- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`) that injects granted cookies through `Network.setCookies` into only the dedicated, zero-consent Chrome this provider auto-launches; the user's own attached-to Chrome stays read-only. Injection is filtered to the launch's `domains` option and never logs cookie values.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional, additive fields, `domains` and `chromeProfile`.

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` and a new `createChromeLiveAdapter(config)` factory, and re-exports `chromeLiveLaunchOptionsFrom`.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()`.

- f1e23ad: `@agentproto/runtime`: adds an optional, empty-by-default observer seam over the `browser_*` MCP tools (AIP-63 section 7). New exports `registerBrowserObserver`, `unregisterBrowserObserver`, `loadBrowserObserverModule`, and `configureBrowserObservers` let an operator observe `onAttach` / `onDetach` / `beforeCall` / `afterCall` and transform `browser_screenshot` images. Observers fail open inside a short budget; only a `required` screenshot transform can fail a call (`browser:transform_failed`). Call arguments are redacted before observers see them: a `fill` value and an `evaluate` expression are never passed, not even their length. With no observer registered every tool behaves exactly as before.

  `@agentproto/cli`: the `serve` daemon now loads an operator browser-observer module from `AGENTPROTO_BROWSER_OBSERVER_MODULE` (absolute, user-owned, non-world-writable path default-exporting `(api) => void`); `AGENTPROTO_BROWSER_OBSERVER_REQUIRED=1` makes a load failure fatal, otherwise the daemon boots without observers.

- 0939143: Imported remote (http/sse) MCPs can now authenticate with OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE). `@agentproto/runtime` exposes the generic `McpOAuthProvider` (plus the `mcp-client-pool` and `mcp-credential-deps` subpath exports) and a new `oauth` field on `McpConnectionConfig`; `@agentproto/cli` adds `agentproto mcp login <alias> [--url <url>] [--scope "a b"] [--no-open]` and `agentproto mcp logout <alias>`, storing client + tokens as one keychain item per import. The daemon refreshes tokens silently and never starts an interactive flow, failing with `oauth login required … run: agentproto mcp login <alias>` when credentials are missing or revoked.
- 80fbfbe: Added a fleet-wide session stats report over a start-time window: `agentproto sessions report [--since 12h] [--topN 5] [--json]` and the equivalent `sessions_report` MCP tool / `GET /sessions/report` REST route. Reports session counts by harness and model, status + end-reason breakdown, total/average wall-clock duration, tokens and estimated cost (split subscription vs api-key billing when the session's resolved auth mode says so), PRs opened by in-window sessions, the top-N costliest and top-N longest-running sessions, every currently-active session, and every alive `keepAlive` "permanent" agent. Merges the live registry with cold on-disk session rows so a busy host's `HISTORY_CAP` doesn't undercount the window.

### Patch Changes

- c0dad4a: Fixed a stale comment in `decision-policy.ts` that still claimed "there is no AIP for decision policies yet" — AIP-65 (DECISION.md) shipped upstream on 2026-10-11 and specifies exactly this file's contract. No behavior change.
- 65c31b6: `agentproto serve` now re-ensures every installed app's `services:` owners at boot, right after the eager-resume and continue-on-boot passes. Previously `ensureAppServiceOwners` only ran from `app_install`, so an owner session killed by a daemon restart (`endedReason: "daemon-restart"`, not covered by its `crashed`/`error` restartPolicy) stayed down until the next reinstall. The boot pass force-replaces every recorded owner — signalling any pid left in its pid file first, so an orphaned child doesn't hold the port — gated by the same `daemon.resumeSessionsOnBoot` knob as the other boot-automation passes.
- 65c31b6: `agentproto serve` now re-ensures every installed app's `services:` owners at boot, after the resume and continue-on-boot passes. `ensureServices` previously ran only on the install path, so an app-service owner killed by a daemon restart (`endedReason: "daemon-restart"`, not covered by its `crashed`/`error` restartPolicy) stayed down until the next reinstall. The boot pass force-replaces every recorded owner — signalling any pid left in its pid file first so an orphaned child does not hold the port — gated by the same `daemon.resumeSessionsOnBoot` knob as the other boot-automation passes. Runtime gains the internal `reensureAppServiceOwners` / `buildAppServiceEnsurer` helpers (not re-exported from the package root); the CLI invokes and reports the new pass.
- c0dad4a: Fix a stale comment in `decision-policy.ts` that still claimed there was no AIP for decision policies; AIP-65 (DECISION.md) specifies this file's contract. Also adds a `check-aip-refs` CI gate (script + tests) that fails on dangling `AIP-<N>` references and warns on stale "no AIP" claims against the pinned canonical registry. No runtime behavior change.
- f0a0d89: `@agentproto/runtime` now stamps installed app service-owner sessions with an explicit `origin` of `app-service:<appId>` at spawn time, so session lifecycle policy can distinguish app-managed roots from human-launched sessions without inferring ownership from a mutable display label.

  `@agentproto/apps`' Session Steward now treats `app-service:*` and `pygmalion` / `pygmalion:*` origins as machine-owned roots eligible for origin-bounded lifecycle actions, and documents the separation between classifier verdicts and deterministic mutation authorization.

- Updated dependencies [345cf99]
- Updated dependencies [28a2949]
- Updated dependencies [350e966]
- Updated dependencies [6e75183]
- Updated dependencies [cc7ba9f]
- Updated dependencies [c265752]
- Updated dependencies [345cf99]
- Updated dependencies [350e966]
- Updated dependencies [f0a0d89]
- Updated dependencies [6ec4039]
  - @agentproto/adapter-browser@0.7.0
  - @agentproto/model-catalog@0.12.7
  - @agentproto/driver-browser@0.3.0
  - @agentproto/app-kit@2.0.0
  - @agentproto/apps@0.23.5
  - @agentproto/providers-store@0.3.30
  - @agentproto/llm-endpoint@0.11.12
  - @agentproto/plugin-local-browser@0.3.5

## 5.24.0

### Minor Changes

- a2cd821: Add `agentproto app tunnel`, the `app_tunnel` MCP tool, and the `buildSessionLink` miniapp helper
- 3a02a3b: New `create_tool` / `delete_tool` daemon verbs author an AIP-14/AIP-30
  TOOL.md + DRIVER.md pair into the workspace bundle
  (`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`). Gated by the
  caller's AIP-42 `actions.granted` (default-denied — an agent must grant
  `create_tool` in its own manifest). The grant subject is the daemon-resolved
  caller session identity — never a caller-supplied tool argument — and an
  unresolvable caller fails closed. Bounded by a minimum lifetime, an authoring
  marker that protects operator/`emitApp`-authored tools from `force`, a
  per-agent/day delete limit and a reclaimable authoring lock; created tools
  default to `approval: "always"`. `@agentproto/agent` now exports its
  `AGENT_ID_PATTERN` so callers validate AIP-42 ids before resolving them to
  paths. `isSelfSchedulingTool` now also refuses `create_*`/`delete_*` authoring
  verbs (including `create_tool`) as cron `tool` actions.
- 8a068e9: Cron jobs gain `ownedBy` + `expiresAt` lifetime guards: a session-created job is tagged with its owner (from `?callerSessionId=`) and retired — or relinked to a live successor — once that owner is gone, with a default 7-day expiry; `cron_create`/`cron_update`/`cron_list` surface both.
- 0d1cb7b: Add AIP-42 agent manifest authoring: the shared `renderAgentManifest` in app-kit, the `agentproto agent create|list` CLI verb, the daemon `create_agent` MCP tool, and spawn-time `agentId`/`agentPath` manifest defaults (plus `sessions start --agent`).
- a2cd821: Add `agentproto app tunnel` — create a public (private-by-default, signed-link) tunnel for an app's `ui.port` through the running daemon, optionally minting the miniapp session deep link. Adds the daemon-side `app_tunnel` MCP tool plus the exported `buildSessionLink` helper and `AppTunnelResult` type.
- c4f6652: Service-owner launcher for an app manifest's `services:` block (Pygmalion phase
  1b item 2): `parseAppServices` validates the frozen `{ name, entry, port? }`
  shape, `ensureAppServiceOwners` spawns one `keepAlive` + `restartPolicy` owner
  session per entry via `spawnAgentSession` and persists per-service ownership
  (install/apply/catalog), and `app_uninstall` kills every owner session and
  recorded pid via `removeAppServiceOwners`.
- 8a068e9: Cron jobs gain `ownedBy` + `expiresAt` lifetime guards: a session-created job is tagged with its owner (from `?callerSessionId=`) and retired — or relinked to a live successor — once that owner is gone, with a default 7-day expiry; `cron_create`/`cron_update`/`cron_list` surface both.
- 3a02a3b: New `create_tool` / `delete_tool` daemon MCP verbs that author an AIP-14
  `TOOL.md` (+ AIP-30 `DRIVER.md`) pair into the workspace bundle
  (`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`), gated by the
  caller's AIP-42 `actions.granted` and bounded by a minimum lifetime, a
  per-agent/day delete limit and an authoring lock, with created tools
  defaulting to `approval: "always"`. `isSelfSchedulingTool` now also refuses
  `create_*`/`delete_*` authoring verbs as cron `tool` actions.
- c4f6652: Launch service owners for an app's declared `services:` block at `app_install` time: one keepAlive + restartPolicy owner session per entry (spawned through the same infra as agents) supervises the entry as a detached child, with per-service ownership (appId + name + owner sessionId + pid) persisted beside the installed-app registry. `app_uninstall` kills every owner session and recorded pid; a reinstall replaces dead owners without spawning a duplicate.

### Patch Changes

- Updated dependencies [3a02a3b]
- Updated dependencies [0d1cb7b]
- Updated dependencies [5a1a7e0]
- Updated dependencies [5a1a7e0]
  - @agentproto/agent@0.4.0
  - @agentproto/app-kit@1.10.0
  - @agentproto/apps@0.23.4
  - @agentproto/mcp-server@0.6.5
  - @agentproto/adapter-browser@0.6.1

## 5.23.0

### Minor Changes

- 3c94e79: An app's WORKSPACE.md can now back its workspace with git: an inline `storage: github` with `sync.mode: pull-push`, a `config.repo_url` on github.com and an absolute `config.mount_path` is cloned there (through `@agentproto/storage-github`'s `createGithubWorkspaceSync`) when the app's workspace is registered, and the clone becomes the app workspace path. The token comes from the env var(s) named in `auth.state.env` (default `GITHUB_TOKEN`, `GH_TOKEN`). The clone only happens into an empty or missing directory; an existing git checkout is accepted untouched, any other non-empty directory is refused, and every failure falls back to the app dir. After a seed clone the token header storage-github writes into `.git/config` is removed — later pulls/pushes re-inject auth per invocation — so no credential is left at rest in the workspace. `branch_policy`/`pr_policy` are validated against the AIP-35 enums and dropped when unknown. A repo whose default branch is not `main` fails the clone unless `base_branch` is declared (the failure is warned and falls back to the app dir).
- ebfd261: Add `agentproto tunnel login`, `POST|GET /tunnels/login` and `PUT /tunnels/providers/:slug`; refuse a public tunnel to the daemon's own port while it does not authenticate remote requests
- 2b6189d: Carry review body and URL in sentinel pull_request_review events
- d6ccf1f: Add chrome-live screencast for live view and recording of agent's tab
- 28b35b3: Add Cloudflare provisioned tunnel provider with OIDC device login
- 28b35b3: Export the Cloudflare tunnel engine as `@agentproto/runtime/cloudflare-tunnel-engine`.
- 84d3993: Mint a unique human `slug` on every session: `spawnAgent`/`spawnPty` derive one via the shared `mintSlug` (slugified `title || label || adapterSlug || kind`, de-duplicated with `-2`, `-3`, … against held sessions), restored legacy rows are lazily backfilled idempotently on boot, and `renameSession` accepts an optional `slug` override that stays unique instead of throwing. The deprecated `name` becomes a read-only alias resolved through the new `getSlug` (`slug ?? name`); `spawnPty` no longer throws on a colliding `name` and no longer writes `name` at all.
- 2b6189d: Carry the PR review body (capped at 4096 chars as `data.body`) and the review's `html_url` (`data.reviewUrl`) on normalized `pull_request_review` webhook events, and append a whitespace-collapsed one-line snippet of the body (≤200 chars) to the event `summary` so watchers see why a verdict was given. An empty or absent review body keeps the previous `data`/`summary` shape exactly.
- 98cce09: Route/account selection moves into the auth model instead of CI glue. An auth profile can now declare extra billing `routes` it serves beyond its primary `endpoint` (e.g. one OpenCode key billed on both the `opencode-go` Go route and the `opencode` Zen route); the eligibility predicate admits the profile on any declared route. `agent_start` / `SpawnAgentSessionInput.access` accepts an ordered `profileRefs: string[]` (superseding `profileRef`), and the runtime bills the FIRST profile eligible for the model's route, failing closed with the candidate list when none are. `auth profile create` gains a repeatable `--route <route>` flag. Absent `routes`/`profileRefs` behaves exactly as before.
- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `@agentproto/runtime`: `appServe` pulls the app's declared `storage: github` `pull-push` workspace inside the box after `app_install` (new exports `readAppGithubWorkspaceSync`, `pullAppGithubWorkspace`, `boxGitRunner`, `boxSyncTree`), an opt-in close-time push rides `onBeforeTeardown` (`createGithubWorkspacePushAtClose`, `composeTeardownHooks`), token lookup via `resolveGithubWorkspaceToken`, and a failed seed clone in `app-workspace` now removes the just-created empty mount dir and warns on a failed auth scrub. New optional `exec` on `SandboxServeHost`.
  - `@agentproto/app-kit`: new `workspaceFromMarkdownText` parses `WORKSPACE.md` text without touching the filesystem (same manifest parse `loadAppHandle` runs), returning `undefined` for anything unparsable or schema-invalid.
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an `AsyncGitRunner`, so the sync contract can be driven over remote exec seams; `writeAuthConfig` is now async and accepts either runner shape.

- 84cd47a: Restart-with-override: add `mcpServers` as a restartable axis (`POST /sessions/:id/restart` body, the `session_restart` MCP overrides, and `RestartOverrides` via `SessionConfig.mcpServers`). A restarted session now lets the caller fully REPLACE the mounted MCP server list instead of always cloning the ORIGINAL one verbatim — the only way to change an HTTP-mounted server's baked-in config (e.g. a `?allowTools=` query string on the daemon self-mount). Full replacement, not a merge; the daemon self-mount's `callerSessionId` is re-stamped with the restarted session's id on the new list.
- 98cce09: Route/account selection moves into the auth model instead of CI glue. An auth
  profile can now declare extra billing `routes` it serves beyond its primary
  `endpoint` (e.g. one OpenCode key billed on both the `opencode-go` Go route and
  the `opencode` Zen route); the eligibility predicate admits the profile on any
  declared route. `agent_start` / `SpawnAgentSessionInput.access` accepts an
  ordered `profileRefs: string[]` (superseding `profileRef`), and the runtime bills
  the FIRST profile eligible for the model's route, failing closed with the
  candidate list when none are. `auth profile create` gains a repeatable
  `--route <route>` flag. Absent `routes`/`profileRefs` behaves exactly as before.
- b0224c7: Add cloudflare-managed tunnel provider and hostname/purge commands
- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `app_install`'s seed-clone follow-ups in `app-workspace`: a failed seed clone now removes the just-created empty mount dir again (nothing of the user's is ever deleted — `rmdir` only succeeds when the dir is empty), and a failed persisted-auth scrub (`git config --remove-section` after a clone) is warned about instead of silently dropped, so the "no credential at rest" guarantee is self-checking.
  - `appServe` pulls the app's declared `storage: github` `pull-push` workspace INSIDE the box after `app_install` and before the UI server launches: empty/missing mount path is cloned, an existing checkout is fetched and merged `--ff-only` (a diverged local branch fails the pull, never clobbered). Git runs through the box's per-command exec seam (`boxGitRunner` is passed to `createGithubWorkspaceSync`), never the host's `spawnSync` against an in-box path. The GitHub token is resolved through the daemon's secrets broker (`resolveGithubWorkspaceTokenFromBroker`) — never ambient `process.env` — and `persistAuth: false` keeps it off the box's command line and out of `.git/config` (every git call injects it via `SandboxExecOpts.env`). `pull`'s outcome is read from a real discriminant (`PullResult.ok`), not a message substring. An invalid declaration, a missing token, or a failed pull is warned about and never breaks the serve.
  - Opt-in push at session close: a declaration carrying BOTH a non-`main` `sync.push.branch_policy` AND a non-`none` `pr_policy` opts in; the hook runs on the box proxy's `onBeforeTeardown` (the last moment the box filesystem is reachable), pushing the working tree as `agentproto/<session>` / `agentproto/turn-<id>` per the branch policy, never the base branch. It is wired on the spawn path AND on the restart/re-attach paths, so a resumed session pushes like a fresh one. Without the declaration (or with `main`), nothing pushes. Failures are warned, never block the teardown.
  - `@agentproto/app-kit` gains `workspaceFromMarkdownText`: parse WORKSPACE.md text without touching the filesystem — the same manifest parse `loadAppHandle` runs on the file, lifted to a string so a caller holding text read from a box gets the identical validated handle (returns `undefined` for anything unparsable).
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an async runner (per-call `await`; sync runners unchanged), a new `persistAuth` opt (default `true`) can skip persisting the auth header for remote-seam runs, and `pull` now reports `PullResult.ok` on every path. `@agentproto/storage`'s `PullResult` gains that optional `ok` discriminant (a healthy refresh is `seeded: false, ok: true`; a failed clone/fetch/merge is `ok: false`).

- b83773b: session-follow: a follow can now subscribe to a task board with
  `selector.boardId` and the new `task-changed` event. The daemon wakes the
  follower (one coalesced digest, no polling) when a task on that board is
  created, claimed, changes status, or is released by another actor — a pure
  field edit is ignored, and the follower's own writes never wake it.

### Patch Changes

- d40020f: Keep `meta.cloud` (vendor/sessionId/url) and the vendor harness label (`claude-code`) on the descriptor of a restarted AIP-66 cloud session, instead of dropping the cloud binding and falling back to the relay adapter slug (`claude-code-cloud`).
- 855a9de: Keep chrome-live browser instances alive across /mcp requests
- 6796022: Enforce the canonical posture on opencode sessions instead of only announcing
  it. opencode advertises no native `bypass`/`accept-edits`/`read-only` mode, so
  those postures reached an opencode session as an advisory system-prompt
  preamble only, and `posture: "bypass"` still showed opencode's own permission
  prompts. The driver now layers a `permission` block into the session's own
  `OPENCODE_CONFIG_CONTENT` at spawn/restart (the user's opencode config files are
  never touched): `bypass` allows every permission, `accept-edits` sets
  `edit: "allow"`, `read-only` sets `edit: "deny"` and `bash: "deny"`. `plan` keeps
  opencode's native `plan` agent, and the preamble fallback for harnesses with no
  mapping is unchanged. An inline config that is not a JSON object now refuses the
  spawn rather than silently dropping the boundary.
- c6ac536: Report how a posture is actually enforced instead of calling every
  non-native posture advisory. The driver now exposes `spawnEnforcedPostures`
  (exported helper, and stamped on each started session) — the canonical
  postures an adapter enforces through its isolated spawn config: claude-code's
  `permissions.defaultMode` and opencode's per-session `permission` block. The
  runtime classifies a posture with the new pure `postureEnforcement` helper as
  `native`, `spawn-config`, `prompt-advisory`, `none` or `unavailable`, and
  surfaces it additively: a read-time `spawnEnforcedPostures` echo on the session
  descriptor (never persisted), `postureEnforcement` and
  `canonicalPostureEnforcement` on `session_capabilities` /
  `GET /sessions/:id/capabilities`, an `enforcement` field on `setPosture` /
  `agent_set_posture` results (so a `requires-restart` for opencode `bypass` says
  the restart lands a real boundary), and `spawn-config` in a read-only decision
  escalation's `toolControls.enforced.posture` where it used to say
  `prompt-advisory`.
- 58c4eed: Forward posture to the box's agent_start for sandbox spawns and restarts, surface the box's spawnEnforcedPostures, expose spawnEnforcedPostures on adapter listings, and label spawn-enforced postures "(enforced)" in the VS Code posture picker and Configuration Lab.
- 6e9b912: Route every session-addressing MCP tool through the shared `resolveSessionRef` + `sessionRefSchema` so `sessionId`, `idOrName`, and `slug` are all accepted uniformly across the session surface (previously each tool declared only one of the spellings), with a transport-level regression test in `session-ref-keys.test.ts`.
- e584cb3: Report detached sandbox rows from workspace buckets a daemon does not serve as `unserved` instead of pending forever
- 58c4eed: Carry posture through sandbox sessions and label spawn-enforced postures in
  pickers. A sandbox (box-proxied) spawn or restart now forwards `posture` to the
  box's own `agent_start`, so the box daemon applies it like a local spawn
  (native mode, isolated spawn config, or the advisory preamble). Before, the
  host dropped it outright. The box's `agent_start` response carries
  `spawnEnforcedPostures`, and the host proxy surfaces it, so a box session reports
  `spawn-config` instead of advisory. An older box that reports nothing stays
  advisory. `GET /adapters` entries carry `spawnEnforcedPostures` (claude-code,
  opencode). The VS Code posture picker and Configuration Lab label those postures
  "(enforced)", applied on restart, instead of "(advisory)".
- 6e9b912: Every session-addressing tool accepts `sessionId` / `idOrName` / `slug`. The MCP session surface (`session_capabilities`, `session_restart`, `session_unarchive`, `session_tree`, …) now routes lookups through the shared `resolveSessionRef` + `sessionRefSchema` instead of `findByIdOrName` alone, and the same three-key addressing is extended to `command_log_tail` / command tool-call reads, `conversation_read`, `conversation_export`, `workspace_brain_ingest`, and `app_session_events`. Resolution is archived-inclusive (via `archivedInclusiveRegistry`), so a legacy `name`/`slug` still resolves for an archived session — e.g. `session_unarchive` — and `ambiguous`/`conflict` outcomes surface as errors rather than silently degrading to the raw query.
- 96e5008: `task_list`'s description now names the write verbs and how to reach them when a mount lists `task_list` but not `task_create`/`task_claim`/`task_update` (a custom `deferredTools.alwaysOn` set defers them: `tool_search` `select:task_create,task_claim,task_update`). Every default mount still lists all four.
- 50dffe6: Summarize a command tool's result from its real stdout/stderr instead of the
  raw JSON blob. `command_execute` returns its result as one JSON string
  (`{exitCode,stdout,stderr}`), whose newlines are escaped — so the one-line
  renderer saw a single "line" and truncated it to the first ~160 chars, showing
  the JSON preamble plus the first thing the command printed (often the cwd).
  The presenter now detects that shape, parses it, and reports the exit code and
  the real line/byte count of the output.
- 87dfdfd: Route session lookup through a single id/slug/legacy-name resolver

  `findByIdOrName` now delegates to the shared resolver: a query is trimmed, exact `slug` matches are honored, and a query matching more than one session (duplicate legacy `name`s) resolves to not-found instead of the previous silent first match. A multi-key `SessionRef` whose keys disagree now returns the new `{ code: "conflict", query, keys }` error instead of `not_found`. The returned type is unchanged.

- Updated dependencies [989828b]
- Updated dependencies [d6ccf1f]
- Updated dependencies [bb711b8]
- Updated dependencies [a21b38b]
- Updated dependencies [6796022]
- Updated dependencies [179ea46]
- Updated dependencies [c6ac536]
- Updated dependencies [98cce09]
- Updated dependencies [efd7192]
- Updated dependencies [0bc2def]
- Updated dependencies [bb711b8]
- Updated dependencies [98cce09]
- Updated dependencies [0bc2def]
- Updated dependencies [50dffe6]
- Updated dependencies [efd7192]
  - @agentproto/model-catalog@0.12.6
  - @agentproto/adapter-browser@0.6.0
  - @agentproto/secrets@2.1.0
  - @agentproto/acp@0.11.1
  - @agentproto/driver-agent-cli@2.13.1
  - @agentproto/pairing-host@0.2.8
  - @agentproto/auth@1.3.0
  - @agentproto/storage-github@0.2.0
  - @agentproto/app-kit@1.9.0
  - @agentproto/apps@0.23.3
  - @agentproto/providers-store@0.3.29
  - @agentproto/sandbox@0.11.2
  - @agentproto/llm-endpoint@0.11.11

## 5.22.0

### Minor Changes

- 38a1c34: feat(app-kit,runtime): AIP-53 `ui.toolScope` link-token scoping, Telegram-identity-bound — closes the argument-scoping gap in `app_tool_call`/`POST /apps/:appId/tool-call` (an allowlisted UI tool like `conversation_read` could be called with ANY `sessionId`, not just the one it was shown for). `defineApp`'s `ui` gains an optional `toolScope` map (`{ toolName: { argName: "$link.<claim>" } }`), validated against `ui.tools` and carried through emit/load/install onto `InstalledApp.ui.toolScope`. A new privileged `app_link_mint` daemon tool (never placeable in `ui.tools`, refused unconditionally by `dispatchAllowlistedAppTool`) mints a short-lived, HMAC-signed link token bound to one `(appId, sessionId, telegramUserId)` — useless on its own until the opener's Telegram Mini App `initData` is verified against the daemon's stored bot token via the new `POST /apps/:appId/link-auth` (`app-link-auth.ts`), which exchanges it for a short-lived session token. `dispatchAllowlistedAppTool` runs in a fail-closed scoped mode under that session token: only tools in `ui.toolScope` are reachable, with their scoped arguments checked against the token's claims (absent → injected, mismatched → refused) — no union with `ui.tools`/`APP_UI_DISCOVERY_TOOLS`. `tunnelBearerAllowed` and the tool-call route's browser/bearer gates (http-server.ts) accept a valid session token ONLY for that one app's tool-call route and that one session's three read routes (`GET /sessions/:id`, `/events`, `/events/stream`); every other route, and the whole feature when no token is presented, is unaffected. New modules: `app-link-token.ts` (HMAC mint/verify, persisted `~/.agentproto/keys/app_link_hmac` key), `telegram-init-data.ts` (Telegram WebApp signature verification), `app-link-auth.ts` (the identity-bound exchange, single-use link tokens, audit logging), `app-link-gate.ts` (the HTTP-level predicates).
- 5982c03: AIP-66 managed cloud agents: `agent_start.cloud` names a vendor (e.g. `cloud: "anthropic"`) that owns the machine and harness; the runtime resolves it to the vendor's cloud adapter (`claude-code-cloud`), refuses the spawn fields a cloud target can never apply (worktree, commandSandbox, mcpServers, daemonMount, bundles, browser, appServe, inference) with a typed `cloud_spawn_refused` error, skips host auth/profile resolution, and persists the learned vendor session id onto `meta.cloud` so restarts and re-attaches resume the vendor's own session.
- 884868e: `session_mark_completed` now accepts an ALREADY-terminal session (`exited` /
  `killed` / `error`) and records an operator resolution on it, instead of
  refusing with `not_live`. A sandbox session that died — an e2b box hitting its
  time cap, a crashed child whose PR had already merged — after its work was
  fully pushed and merged used to keep reading FAILED in every list / recap / UI
  forever; the only tool that would touch such a row was `session_archive`,
  which hides it entirely and throws away the "this was fine" signal.

  A terminal row is resolved by the new `registry.resolveOutcome`, the terminal
  twin of `closeWithOutcome`: it stamps the SAME Level-2 `SessionOutcome`
  fields a live close writes (`source` / `verdict` / `judgedBy` / `summary` /
  `note` plus the structured `OutcomeDetail`) and nothing else. Nothing is
  revived, no process is signalled, and `status` / `endedReason` / `endedAt` /
  `exitCode` keep showing exactly how the row really died. `verdict: "done"`
  additionally relabels the outcome's `termination.reason` to
  `"operator-completed"` — the true death mechanism preserved in
  `previousReason` — and retires the row, matching the UI's existing "Mark as
  completed" affordance (`kill(id, …, "operator-completed")`) exactly. Every
  other closing verdict (`partial` / `failed` / `abandoned`) only labels the
  outcome; `blocked` / `needs-input` stay refused on a terminal row, since
  there is no live session left to wait on. Unknown ids and the live path are
  unchanged.

  New shared `isOutcomeCompleted(outcome)` (exported from the package root)
  answers "has an operator/judge declared this session's work complete?" from
  either the full outcome or the compact list projection, and the badge
  derivations that used to paint such a row as failed now consult it: the
  shared dashboard classifier `presenceFor` folds a resolved terminal row into
  `quiet` instead of `attention`, and the VS Code sessions tree / webview row
  status / outcome card read it as done (a `tool_help` doc for
  `session_mark_completed` documents the new contract).

- 884868e: `session_mark_completed` accepts already-terminal sessions via the new `registry.resolveOutcome`, and the new exported `isOutcomeCompleted` makes presence and VS Code session badges treat resolved rows as completed instead of failed.

### Patch Changes

- c7a240b: AIP-66 cloud review follow-ups. Runtime: `watchCloudSessionMeta` now only learns a meta file whose `vendor` matches the watch (a file written for another vendor is ignored and the watch keeps polling). Adapter: `session/load` validates the session id before the repo source, so a malformed id reports its own error first; `#seedSeenEvents` pages through the whole vendor history via `resume_cursor` (bounded at 50 pages) so every pre-existing event — including an older `result` — is pre-marked, leaving `pollCursor` at the newest position the normal poll loop resumes from.
- 1576bbb: AIP-66 cloud observe fixes. Adapter: the events cursor pages BACKWARD in time (no cursor = newest page; `resume_cursor` = the oldest `sequence_num` on the page, passed back returns the next OLDER page), so `#observeTurn` no longer uses a forward `cursor`/seen-id set — it tracks a per-session `lastSeq`, polls the newest page each tick, walks `cursor` backward only as far as needed (capped at 20 pages/tick), projects new events in ascending `sequence_num` order, and ends a turn only on a vendor `result` whose seq is above the high-water recorded before the prompt. `session/load` seeds `lastSeq` from one newest-page GET (the forward-paging loop and `SEED_EVENT_PAGES_LIMIT` are gone), and the `CloudSessionEvent`/page types now carry `sequence_num`, `source` and `next_cursor`. Runtime: the cloud-spawn refusal message is no longer double-prefixed with `agent_start:`, and `resolveCloudSpawn` records the vendor's harness (`claude-code`) on the descriptor instead of the local relay adapter slug (`claude-code-cloud`) — the adapter stays `claude-code-cloud` (AIP-66 §2).
- 19f5b2b: Interrupt sandbox turns via remote endpoint instead of replaying prompt
- 8b4135e: Docs: describe system-prompt channels per adapter, the sandbox-gone restart default, and the box-login bridge.
- e296593: Route Chrome Live screenshots and health checks through its provider.
- 49661e7: fix(sandbox,cli): bound the boot re-attach pass with a per-row deadline

  Every individual re-attach step was already bounded (the e2b SDK caps a request at 60s × 3
  retries, the MCP client caps a request at 60s, the box probe at 10s), but they stacked to
  4–6+ minutes **per row** with no overall deadline — so a single wedged box left
  `pending > 0` in `/health` and made `agentproto daemon restart` hang silently for minutes
  before printing a bare "still pending".

  Runtime (`runSandboxReattachPass`): a per-row `timeoutMs` (default 30s, overridable via
  `AGENTPROTO_REATTACH_TIMEOUT_MS`) races each row's attempt. On timeout the provider's
  `probe` is consulted (bounded at 5s) — `{ alive: false }` ends the row `sandbox_gone` and
  stamps the ledger `gone`, anything else ends it `failed` with the detail
  `reattach timed out after Ns`. Cleanup only detaches (MCP + timers); it never stops,
  pauses or kills a box that may still be running. A late settle from a timed-out row just
  releases the half-open handle, so the pass always drains `pending` to 0.

  CLI (`daemon restart`): prints a `re-attaching N sandbox session(s)…` progress line up
  front and caps the wait at 60s (runtime deadline + margin) instead of 120×500ms polls.
  If the pass hasn't settled by then it notes that the pass continues in the daemon and
  points at `agentproto daemon status`, which now also renders the re-attach tally next to
  the `/health` sandbox line.

- Updated dependencies [38a1c34]
- Updated dependencies [56efb5a]
- Updated dependencies [a727b5f]
- Updated dependencies [8b4135e]
- Updated dependencies [e296593]
  - @agentproto/app-kit@1.8.0
  - @agentproto/apps@0.23.2
  - @agentproto/adapter-browser@0.5.0

## 5.21.0

### Minor Changes

- f776cd2: feat(runtime): restartPolicy can move a box session to a fresh box when its box is gone

  `restartPolicy.on` gains a third value, `"sandbox-gone"`. A box session
  (`agent_start.sandbox`) that dies WITH ITS BOX GONE — lifetime cap reached,
  provider reclaim, unrecoverable unreachability — can no longer be revived
  in place, so a policy listing `"sandbox-gone"` schedules the same fresh-box
  move `session_restart` takes (`restartAgentSession` → `spawnOnFreshBox`:
  re-clone the workspace remote, re-check the `wt/` work branch out, restore
  the last checkpoint) instead, after the same exponential backoff and under
  the same `maxRetries`/`windowMs` crash-loop cap. The replacement session is
  prompted once to continue the original task from where the pushed work
  stops; a blocked move (no workspace remote, no tarball checkpoint, provider
  missing) leaves the session dead with a single `[sandbox-gone]` notice and
  never loops.

  Box-gone detection reuses evidence the daemon already has — the reattach
  pass's `endedReason:"sandbox_gone"`, recorded proxy/provider death messages,
  the sandbox ledger's `gone` state, and one provider liveness probe — with no
  new polling loop. Off unless a session's `restartPolicy.on` lists
  `"sandbox-gone"`; classic `crashed`/`error` in-place revival is unchanged,
  and non-box sessions never consult the probe.

  New daemon config `daemon.sandboxGoneRestartDefault` (off unless set) applies
  that policy to box sessions spawned with no explicit `restartPolicy`, so an
  executor box can opt in once instead of per spawn; an explicit per-session
  policy still wins, and turning it on also arms the restart sweep at 30s when
  `daemon.restartSweepIntervalMs` is unset. Nothing changes for anyone who has
  not set it.

- 24f1cf5: Codex and opencode logins are now file-based: the login JSON stored in the secrets store is copied into the box at boot and re-copied on restart, then refreshed in place with a throttle and a digest gate so an unchanged file is never re-uploaded, and the auth block carries a `loginFile` marker pointing at the copied file instead of embedding a token so no credential lands in the session record — when the secret is missing or unreadable the session degrades fail-loud with an error naming the missing key instead of silently starting an unauthenticated agent.
- 37562ef: New typed decision router: `DECISION.md` policies (markdown + YAML
  frontmatter) parse via `parseDecisionPolicy`, and `decide(policy, evidence)`
  resolves one closed choice rules-first — ordered rules, mandatory `floor`
  choices no classifier may downgrade (a floor pinning the strongest choice
  makes zero model calls), then at most one bounded Jev typed-choice classifier
  call through the existing generic client (`minProbability`/`minMargin`
  thresholds; missing probabilities are uncertainty, not certainty), then
  exactly one optional tool-less LLM escalation whose self-reported confidence
  is never threshold-checked, then the conservative default. The default
  evidence export policy sends no paths/code/messages; tier-1 state is
  field-allowlisted, string-capped and size-ceiled with omission markers, and
  truncated/incomplete evidence cannot be classifier-accepted. Outcomes carry
  choice, source (`rule | rule-floor | classifier | escalation | default`),
  matched rules, probability/margin data, escalation history, evidence refs
  and policy/evidence/classifier-config hashes; decisions are cached and
  concurrent identical calls share one computation. Surfaces: `decision_decide`
  on the root `/mcp` server (Jev key/baseUrl from the existing `jev` config;
  no escalation backend wired at the tool layer) plus package exports. Ships
  the review-routing example policy, `docs/decision-policy.md`, and a labeled
  studio integration design artifact (studio itself is not wired).
- 25e09ae: Ship the `decision-route` workflow (`workflows/decision-route/WORKFLOW.md`) and
  its `decision_*` stage tools: collect bounded metadata-only evidence (paths and
  code only on an explicit DECISION.md opt-in, secrets scrubbed), apply the
  DECISION.md rules with zero models, classify unresolved ranges through one Jev
  direct-API call, escalate through at most ONE configured agent-harness session,
  map the closed choice to a REVIEW.md binding and, in `enforce` mode only, run
  and validate the review. `shadow` is the default and starts no review lane.

  The execution profile is enforced before any spawn: `local-free` allows only
  OpenCode `-free` / `big-pickle` ids (including role overrides, fallbacks and
  `review.recovery`), `remote-sonnet` also allows the configured Claude Code
  Sonnet, E2B placement grants no entitlement, and unknown identity fails
  closed. The conservative `deep` route cannot bypass the profile. Every stage
  records workflow / run / step / profile / model / wait reason, parents spawned
  sessions under the workflow run, and reports failures, timeouts and
  cancellations separately from approval. Tool restrictions are reported as
  configured vs enforced, never as a hard no-tools guarantee.

  `decide()` no longer caches backend failures: a conservative fallback is never
  remembered as a trusted decision, and a changed classifier identity misses.
  Agent session spawns accept a `workflowOwner` that is stamped into the session meta.

- e1a291b: feat(adapter-hermes): system-prompt channel via an agentproto hermes plugin — ships a bundled `agentproto-system-prompt` hermes plugin (reads `AGENTPROTO_SYSTEM_PROMPT_FILE`, registers cache-safe sections at `after_memory`, frozen at session start), `hermesSystemPromptPluginStatus`/`installHermesSystemPromptPlugin` helpers, and `agentproto adapters hermes-plugin status|install [--enable] [--json]` (enable = explicit consent via `hermes plugins enable`). Delivery budget `MAX_HERMES_SYSTEM_PROMPT_CHARS` = 7500. The driver gains the `env-file` `systemPrompt` channel (writes `<session config dir>/agentproto-system-prompt.md`, a private temp dir when none, removed on close; points the declared env var at it), and the runtime wires it end to end: the hermes resolver entry sets `supportsSystemPrompt` only while the plugin is installed AND enabled (checked per spawn), `systemPromptMaxChars`/`systemPromptUnavailable` degrade an over-limit or unavailable channel to a first-prompt prefix + a warning naming the limit or the install command (session-spawn, workflow agent host, restart, and agent projection).
- 2f4e9d1: Add `turnRetry.action: "migrate"` (with `maxMigrations`): on a matching turn failure the daemon migrates the session to a fresh sandbox box via `migrateSandboxSession`, falling back to a normal retry on failure. Adds `migrated`/`migrate-failed` retry phases and the `turnMigrations` descriptor counter, carried over to the migrated session.
- f776cd2: restartPolicy.on gains "sandbox-gone": a dead box session whose box is gone moves to a fresh box (runtime), new daemon.sandboxGoneRestartDefault wired through `serve` (cli), and the vscode RestartPolicy type accepts the new value.
- 65cd742: Add typed `SessionRestartError` (with helpers and types) to the runtime, and surface the typed restart failure reason through the apps panel bridge, the CLI `describeRestartFailure` output, and the VS Code extension.
- 2f4e9d1: `session_migrate` (MCP, `POST /sessions/:id/migrate`, `agentproto sessions migrate`) resumes a sandbox session on a new box: it takes a final checkpoint of the old box when it is still reachable, boots a fresh box from the workspace remote, restores the work branch and the pushed uncommitted snapshot (commits stay commits, the snapshot stays uncommitted), carries the transcript over via the context checkpoint, then stops the old box. A shared `restoreCheckpointSteps` planner now backs spawn, restart and migrate.
- c1e3dfd: Harness-neutral system-prompt channel for AIP-42 AGENT.md projection. An adapter whose manifest declares `systemPrompt` now receives the projected AGENT.md text through that channel instead of as a first-prompt prefix, and no `session:harness-warning` is raised for it. Three `via` channels: `acp-meta` (claude-code — ACP `_meta.systemPrompt.append` on `session/new` and `session/load`), `inline-config` (opencode `instructions` file path and codex `developer_instructions`, layered into the CLI's inline JSON config env var) and `argv` (pi's `--append-system-prompt`, on every spawn including resume). Every other adapter keeps today's prefix + warning behaviour, and a sandbox spawn still warns — the box owns its own adapter configuration.

### Patch Changes

- 50d43af: A2A push delivery no longer blocks the JSON-RPC answer, sends a finished task's final event only to the new config, delivers to every config in parallel, serializes config writes and logs only the webhook origin.
- 55a7a96: A sandbox checkpoint now carries the adapter's own conversation store: the box's isolated adapter-config dir for this session is archived next to `checkpoint.json` as `adapter-store.tar.gz` (20 MiB cap, recorded on the checkpoint record, never failing the checkpoint), and a restart onto a FRESH box uploads and extracts it before the adapter starts — then passes the restored id through the box `agent_start`'s resume field so the conversation resumes natively instead of starting blank.
- 189a0f8: A session restarted on its still-alive sandbox box now resumes the adapter's own conversation inside the box (`agent_start` gained an internal `resumeSessionId` resume target; a rejected id falls back to a fresh in-box spawn plus the transcript digest, as before).
- 0f7808d: Sync the published package READMEs with the latest A2A push-notification and session-migration behavior.
- dc01c8b: Sandbox boxes no longer expire under a busy turn that streams nothing: while a turn is in flight the session proxy re-arms the box lifetime every 10 minutes, on top of the per-prompt and per-event renewals. About 5 minutes before the box's known deadline the proxy renews once more if a turn is still in flight, and otherwise (idle, or the renewal failed) runs a final checkpoint while the box is still reachable, instead of probing it after it is gone. Heartbeat and guard stop on close and on detach.
- dc01c8b: Sandbox session proxy re-arms the box lifetime every 10 minutes while a turn is in flight and runs a pre-deadline guard (final renewal or checkpoint). Docs and provider comments updated.
- 5109708: Review verdict recovery now fails closed. A complete, schema-valid verdict the reviewer itself stated as JSON in its own final message is extracted deterministically from its typed transcript (`events.jsonl` assistant records only, never tool output) before any recovery model is spawned; conflicting, templated, contradictory or errored-turn approvals are not extracted. The recovery model can no longer approve or be satisfied by a 12-character quote: it may only lift blocking findings whose title, detail, full file path, line and severity are grounded verbatim in the reviewer's prose, and it asks for one follow-up to the original reviewer otherwise. A follow-up turn that errors never earns an approval, and a failed turn's provider error text is kept in `recovery.reason`. Recovery stays inert unless `review.recoveryPresets` is configured.
- de86dfe: A restarted session that could not resume natively (a box restart — re-attach
  to a live box or a fresh box after the old one died — or a local blank
  fallback) now gets the FULL prior conversation instead of a 7k-char digest.
  On every box restart the prior session's daemon transcript is exported to
  Markdown (tool bodies capped at 2000 chars) and written into the box at
  `/home/user/.agentproto/prior-sessions/<sessionId>.md` (ancestors of a
  restart chain too, up to 5 hops; via the host's `writeFile` or base64 chunks
  over `exec`). The injected first-turn context is a structured handoff — a
  frame stating what happened / what was restored / what was lost, a
  deterministic-extractor checkpoint (`renderCheckpointPrompt`, no LLM handoff
  turn: the prior agent is dead), the most recent turns (~24k chars), and the
  transcript path(s) with an instruction to read them before redoing anything).
  Local blank-fallback restarts write the transcript into the new session's
  host dir and get the same frame; the old `buildResumeContextDigest` stays as
  the fallback when the export or write fails, and a handoff failure never
  fails the restart. Restart results now carry
  `handoff: { transcriptPath, checkpointId, recentChars, totalMessages }` so
  CLI/VS Code/session-chat can say "conversation restored from transcript
  (N messages)".
- 65cd742: Session restart failures are now typed: a restart that cannot complete throws `SessionRestartError`, carrying a stable `code` (`sandbox_gone`, `sandbox_unreachable`, `sandbox_provider_missing`, `sandbox_box_start_failed`, `no_workspace`, `no_workspace_remote`, `no_known_branch`, `adapter_not_found`, `unsupported_strategy`, `retired`, `override_invalid`), a human `reason`, and an optional `action` hint (`fix-config` / `spawn-fresh` / `spawn-on-branch`) that a client can turn into a button. Transports surface these as a nested `{ error: { code, reason, action?, message }, message }` payload, so the HTTP route, the `session_restart` MCP verb and the CLI all report _why_ a restart failed and what to do next instead of leaking provider-internal strings. The session-chat bridge rejects a typed `session_restart` failure with its `reason` sentence rather than the raw payload, and `agentproto sessions restart` prints the `reason` first with the technical detail underneath.
- f302725: Sandbox checkpoint and teardown-delivery pushes (work branch, uncommitted-work snapshot, snapshot cleanup) now run with `--no-verify`, so a repo's `pre-push` hook (e.g. a changeset gate) can no longer block the safety-net backup.
- 7fb3f52: The always-on MCP tool list budget is now 63 KB: the box-login and sandbox-gone restart fields landed together at 62.17 KB.
- 1318308: `turnRetry.action: "migrate"` follow-ups: the migrated session now inherits the `turnRetry` policy itself (so its first migration no longer drops the rule) and the migration cap is enforced across sessions; `maxMigrations` accepts `0`; a give-up after migrations says so in the `[turn-retry] gave up after` notice; a failed migration with a spent retry budget gives up instead of booking an over-budget retry. `--turn-retry` (CLI) validates and documents `action` / `maxMigrations`.
- Updated dependencies [24f1cf5]
- Updated dependencies [0f7808d]
- Updated dependencies [5d2f4b3]
- Updated dependencies [e1a291b]
- Updated dependencies [dc01c8b]
- Updated dependencies [5109708]
- Updated dependencies [65cd742]
- Updated dependencies [65cd742]
- Updated dependencies [c1e3dfd]
  - @agentproto/secrets@2.0.2
  - @agentproto/driver-agent-cli@2.13.0
  - @agentproto/a2a@0.2.1
  - @agentproto/sandbox@0.11.1
  - @agentproto/review@0.6.1
  - @agentproto/apps@0.23.1
  - @agentproto/acp@0.11.0
  - @agentproto/workflow-runtime@0.19.0
  - @agentproto/pairing-host@0.2.7
  - @agentproto/eval-reporters@0.2.25
  - @agentproto/telemetry-langfuse@0.2.23

## 5.20.0

### Minor Changes

- 1bfce97: `ListTasks` on the A2A app task endpoint pages through an app's tasks newest first, with `contextId` / `status` / `statusTimestampAfter` filters, `pageSize` (1–100, default 50) + opaque `pageToken` paging, `historyLength` trimming, and artifacts kept only when `includeArtifacts` is true.
- 22cfadd: A2A app tasks support push notifications: the four config methods store per-task webhooks, task updates are delivered to them as `StreamResponse` POSTs (also from `SendMessage`/`SendStreamingMessage`'s `configuration.pushNotificationConfig`), and the Agent Card advertises `capabilities.pushNotifications`.
- 8ad6546: Stream A2A tasks over SSE with `SendStreamingMessage` and `SubscribeToTask`, and advertise `capabilities.streaming` on the Agent Card.
- 834ec33: Run exposed workflow skills as A2A tasks.
- fe3c879: An AIP-42 AGENT.md now reaches every harness, not just mastra-agent. `app_run` and workflow agent refs share one projection (`projectAgentToSpawn`): body, persona, boundaries and traits become the first prompt's prefix, declared tools scope a daemon gateway mount (`allowTools`) for any adapter, declared skills reach the spawn's `skills`, and each gap the harness can't honour raises a `session:harness-warning`. `composeInstructions` moves to `@agentproto/agent`. `app_run` spawns now get the daemon `/mcp` URL, workflow host spawns deliver session skills, and the AGENT.md path goes only to adapters whose manifest declares `metadata.agentManifestOption` (mastra-agent), so antigravity's `agent` option (an `agy` agent name) is no longer handed a path.
- acb8329: App agents now resolve their spawn adapter from AGENT.md metadata or a model route (claude-* → claude-code, opencode/* and opencode-go/* → opencode) and fail with a clear error instead of silently falling back to mastra-agent.

  Behavior change: an agent with no `metadata.adapter`/`metadata.harness` and a model outside those routes (for example `openrouter/...` or `gpt-5`) used to run on mastra-agent. It now fails: `app_run` lists it in `errors`, and workflow agent-ref resolution throws for the whole app. Add `metadata: { adapter: mastra-agent }` to its AGENT.md, or pass `adapter` to `app_run`, to keep the previous behavior.

- ddc14a6: Box (sandbox) sessions on a workspace with a remote now get a `wt/<slug>` work branch by default (`worktree: false` opts out), so they always have a delivery target recorded on the session. At each turn end the checkpoint hook adopts a different `wt/` branch the agent moved to as the delivery target. `session_restart` on a dead box now restarts on a fresh box from the workspace's base branch when no work branch was recorded, and when it truly cannot proceed the error says why and points at `agentproto workspace remote set <slug> --url … --token-stdin`.
- cedd329: Sandbox deliveries now delete the `agentproto-checkpoint/<branch>` remote branch once the work it rescued is safe (clean checkout, work branch pushed or nothing ahead): a session no longer leaves a stale checkpoint branch on the remote forever, and branch GC reclaims leftovers whose work branch is merged (`checkpoint-superseded`).
- 27700c4: Size presets for the e2b workstation: `config.size` (`nano`, `small`, `medium`, `large`, `x-large`, `xx-large`) boots that preset's published `agentproto-workstation-<size>` template. `config.template` still wins, and with neither set the bare `agentproto-workstation` template boots, now built at the default `large` (4 vCPU / 8 GB). An unknown size fails with the list of valid sizes; a size e2b refused to create (today `x-large` / `xx-large`, over the plan's 8 vCPU / 8192 MB cap) fails with the recorded e2b error. Exports `SIZES`, `DEFAULT_SIZE` and the `WorkstationSize` type. The workstation templates now bake the GitHub CLI (`gh`, pinned and checksum-verified).

  Sandbox agents can open PRs themselves: a spawn whose workspace has a remote token now also gets that same daemon-derived token as `GH_TOKEN`, next to `AGENTPROTO_GIT_TOKEN`, so `gh pr create` works in the box (the token needs Contents + Pull requests write). `GH_TOKEN` is reserved like `AGENTPROTO_GIT_TOKEN`: it is stripped from caller-declared `env.passthrough` / `env.auth.state.env` / `join.tokenEnv`, and it never resolves to the daemon's own `GH_TOKEN`. A caller that used to pass `GH_TOKEN` through `env.passthrough` no longer gets it in the box.

- e8da13a: Stop the prior box session before a sandbox `session_restart` starts a replacement, and persist `sandboxRemoteSessionId`; adds `SessionsRegistry.releaseSandboxSession`.
- ff572e6: Model role presets: switch the repo-maintenance reviewers between five named model sets with one key.

  - `@agentproto/runtime`: `MODEL_ROLE_PRESETS` (`opus`, `sonnet`, `haiku`, `go-free`, `free-sonnet`) and a new `modelRolePreset` config key (hot), a layer between the daemon's `models` and the built-in defaults. `model_roles` takes a per-call `preset`, reports the preset in effect and each role's required `adapter` (`opencode/…`/`opencode-go/…` → `opencode`, `claude-*` → `claude-code`, via `adapterForModelId`).
  - `@agentproto/workflow-runtime`: an `entry.mjs` agent step may pass `adapter` as a run-time selector; a selector that returns undefined keeps the agent ref's adapter.
  - `@agentproto/apps`: the `maintain` workflow takes `reviewPreset` and spawns each reviewer on the adapter its model needs, so an OpenCode Go free model runs on opencode instead of claude-code.
  - `@agentproto/cli`: `agentproto maintain --review-preset <name>`.

- c6f1288: Sandbox sessions survive a box that dies outside `close()`. The host now checkpoints a box's work branch periodically (every 5 min, `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`, `0` = off) and at each turn end: it pushes `wt/<slug>` when ahead and force-pushes a snapshot of uncommitted work (built through a throwaway index) to `agentproto-checkpoint/wt/<slug>`, falling back to a host-side `checkpoint.bundle`. A watchdog probes the box daemon's `/health` and, after 3 failed or 10 unanswered probes, takes a last checkpoint and marks the session crashed so it can be restarted. `session_restart` on a session whose box is gone now boots a fresh box, re-clones the workspace remote, checks out the pushed branch and re-applies the snapshot, instead of failing. The e2b provider enables a 4 GiB swap file on fresh boots (`config.swapMb`, `0` = off).
- f4d5fbb: Make the sandbox checkpoint safety net configurable instead of one env var: `defaults.sandbox.checkpoint` (`enabled`, `on: ["turn-end","teardown"]`, `refPrefix`, `minIntervalMs`, `timeoutMs`) in config.json, overridable per spawn via `agent_start({ sandboxCheckpoint: false | {...} })`. The spawn's override is kept on the session descriptor so a restart or a boot-time re-attach resolves the same policy. `"teardown"` absent from `on` reverts the teardown delivery to only counting uncommitted files. A checkpoint's commit message and record now carry the turn number it was taken after, and a session whose box ended with uncommitted work in it now sends its parent an explicit notice naming the rescue branch and a `git fetch` command, instead of only writing it into its own transcript. `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS` keeps working as the fallback for `minIntervalMs`.
- 060dea8: `session_migrate` (MCP, `POST /sessions/:id/migrate`, `agentproto sessions migrate`) resumes a sandbox session on a new box: it takes a final checkpoint of the old box when it is still reachable, boots a fresh box from the workspace remote, restores the work branch and the pushed uncommitted snapshot (commits stay commits, the snapshot stays uncommitted), carries the transcript over via the context checkpoint, then stops the old box. A shared `restoreCheckpointSteps` planner now backs spawn, restart and migrate.
- 795c382: Sandbox sessions now survive a host daemon restart. Shutdown detaches provider-box sessions instead of killing them: the host closes its connection only, leaves the box and its agent session running, persists a re-attach record (`sandboxReattach`, row stays `running` with `hostDetached`), and asks the provider to extend the box lifetime to 60 minutes (`BootedSandbox.extendTimeout`, implemented for e2b via `setTimeout`; providers cap it, a rejected request leaves the existing lifetime). At boot, before eager resume, the daemon reconnects through `SandboxProvider.connect`, replays the events the box produced meanwhile from the saved transcript seq, and re-binds the same session id without re-prompting the agent. A box that no longer exists ends the row with the new `sandbox_gone` end reason and a `gone` ledger entry. `/health` and `daemon_health` gain `sandboxSessions`, and `agentproto daemon restart`/`stop` report how many sandbox sessions were detached and re-attached. Explicit kill, idle reap and cost kill still tear the box down; device-paired sandboxes and local sessions are unchanged.
- e74439f: Sandbox sessions are now recoverable for workspaces with no `remote` in workspaces.json. The clone source is derived from the checkout's git `origin` (ssh forms normalized to https, public repos only, cloned anonymously and read-only with no credential attached, never persisted); a workspace with no usable origin has its box working dir checkpointed to the host as a size-capped, owner-only tarball at turn end and teardown, and `session_restart` on a fresh box extracts it. Missing pieces are reported with how to fix them. The sandbox agent-session host also forwards the provider's `writeFile`.
- 19c82a5: `turnRetry` can now rotate to another model instead of retrying the throttled one. `turnRetry.rotate` is an ordered list of `{ model, profileRef? }` fallbacks: on a rate-limit or no-output stall (`rotateOn`, add `upstream-5xx` to opt in) the live session is switched to the first eligible target before the continuation prompt, and the `[turn-retry]` notice and a `session:turn-retry` `rotated` event (with `fromModel`/`toModel`) record it. A daemon-wide model cooldown (Retry-After honoured, else `cooldownMs`, default 10 min) keeps every session off a throttled model and is exposed read-only as `modelCooldowns` in `daemon_health` and `/health`. Targets must pass the profile `models` allow-list and the spawn adapter/wallet checks; with none eligible the retry falls back to the same model. A free OpenCode model (`-free`, `big-pickle`) only rotates to free ids: `agent_start` rejects a paid id with `turn_retry_rotate_invalid`, as do user and harness presets. Harness presets (`harness_preset_create`) can now carry `turnRetry`. v1 rotates within the session's current profile only. The CLI `--turn-retry` JSON validates `rotate`, `rotateOn` and `cooldownMs`.

### Patch Changes

- c209fa3: A2A tasks completed by turn end now report FAILED when a session's turn ended in error, and carry the turn-end timestamp
- 36dac26: Sandbox boxes are kept alive while their session is working: the proxy re-arms the box lifetime (throttled to once per 60s) when a prompt is dispatched and as box events stream back, never while idle. The e2b `extendTimeout` clamps to the 1h account cap, and `BootedSandbox`/`SandboxAgentSessionHost` expose the box's configured `lifetimeMs`.
- 2dda22e: Rebuild the `agentproto-workstation` e2b templates (stable and dev) on `@agentproto/cli` 1.20.0 with the latest adapters, so boxes apply the sub-account env forwarded from the host (#1890) and the sandbox exec fix (#1886).
- 3c5c88f: Add the `chrome-live` browser provider (attaches to the user's running Chrome via the remote debugging toggle) and register it in the `@agentproto/adapter-browser` facade. `@agentproto/runtime` only gets docs and test updates.
- e8da13a: `session_restart` stops the prior in-box session before re-spawning, so two adapters never run in the same sandbox box.
- ffc3208: Seq-aware transcript export and checkpoint cutoff: `ExportedMessage.seq` carries the `events.jsonl` seq of the record that started the message (a batched assistant turn carries its first record's seq), `exportDaemonEventsSession` takes an `untilSeq` option that skips records past the cutoff so a transcript can be cut at a message boundary, and `splitMessagesAtSeq` splits an exported message list into head/tail at a cutoff. `buildContextCheckpoint` takes the same `untilSeq`, passes it through to the export, and records it as `cutoffSeq` on the checkpoint (`checkpoint-schema.ts` / `schemas/checkpoint.v1.json` updated).
- Updated dependencies [22cfadd]
- Updated dependencies [8ad6546]
- Updated dependencies [fe3c879]
- Updated dependencies [3c5c88f]
- Updated dependencies [36dac26]
- Updated dependencies [3c5c88f]
- Updated dependencies [ff572e6]
- Updated dependencies [795c382]
- Updated dependencies [e74439f]
  - @agentproto/a2a@0.2.0
  - @agentproto/workflow-runtime@0.18.0
  - @agentproto/agent@0.3.0
  - @agentproto/adapter-browser@0.4.0
  - @agentproto/sandbox@0.11.0
  - @agentproto/apps@0.23.0
  - @agentproto/review@0.6.0
  - @agentproto/app-kit@1.7.5
  - @agentproto/mcp-server@0.6.4
  - @agentproto/eval-reporters@0.2.24
  - @agentproto/telemetry-langfuse@0.2.22

## 5.19.0

### Minor Changes

- 0922fcf: Every installed app now owns a registered workspace (`app-<slug>`, marked with `ownerApp` in `workspaces.json`). `app_install`/`app_apply` register it (WORKSPACE.md `local-fs.mount_path` / `dev-local.root` when present, else the app dir), `app_uninstall` removes it only when that app owns it, and `app_run` plus app-attributed workflow runs spawn sessions into it instead of `default` unless the caller passes an explicit `cwd`. Apps installed earlier are backfilled lazily at `app_run`. App-owned entries never become the implicit active workspace, and a user workspace with the same slug is never overwritten.
- c0c2fd8: Session follows take an optional `urgency` (`"next-turn"` default, or `"fyi"`). An `fyi` follow parks its digests in the follower's inbox without starting a turn, so a supervisor following many sessions is no longer woken for every digest. Existing follows keep `next-turn`.
- ebfbfe2: Add bounded verdict recovery (`recovery` lane provenance, `review.recoveryPresets` config) and shared reviewer execution across lanes (`sharedExecution` provenance); attestation schema and AIP-62 draft extended with the new optional fields.
- ebfbfe2: Review reliability: a reviewer that ends its turn without a valid verdict file now gets one bounded, passive recovery step inside the review workflow (`review.recoveryPresets` + the `review.recovery` model role; inert unless configured). A small tool-less model may recover the reviewer's own conclusion and findings (the daemon validates and writes the verdict file, never fabricates an approval from partial or errored analysis) or classify why the review failed; it is bounded by the lane's original deadline and cancel, keeps the OpenRouter guard, and is recorded apart from the reviewer as the lane's `recovery` field. Lanes whose fallback chains resolve to the same actual reviewer, rubric bytes, effective frozen range and options now share one run-scoped reviewer execution, marked with `sharedExecution` so they are not read as independent agreement. The agent-lane prompt states one consistent verdict rule with a schema-valid example. AIP-62 attestation lanes gain optional `recovery` and `sharedExecution`.
- 877bc60: `sandbox_exec` can take secrets without the caller holding them: `envProfiles: { ENV_NAME: authProfileId }` has the daemon read the profile's credential (keychain, or its sub-account provider) into the command's env. Exec errors are now cut to ~200 chars of the command (`…(N chars)`) and resolved secrets are redacted from errors, stdout and stderr; commands over 16 KB / env over 32 KB are rejected with an actionable error, and an optional `files` input uploads scripts via the new optional `BootedSandbox.writeFile` (implemented for e2b). New `agentproto sandbox exec` CLI and daemon route `POST /sandboxes/exec`, whose exit code is the box command's exit code.
- d7e24ba: Sandbox spawns can now work from a workspace's git remote. `agentproto workspace remote` (with `--token-stdin`) registers an https clone URL and a keychain credential for a workspace; `agent_start({ workspaceSlug, sandbox, worktree })` then clones it into the box, cuts `wt/<slug>` from `worktree.base`, and starts the session there with the token injected only as the `AGENTPROTO_GIT_TOKEN` env var behind a credential helper. When the box is torn down, the work branch is pushed to `origin` if it is ahead of its base, with a `git bundle` fallback saved to `~/.agentproto/sessions/<id>/delivery.bundle`, and the outcome is recorded on the session descriptor (`sandboxDelivery`). `BootedSandbox` gains an optional `readFile`, implemented for E2B.

  Behaviour changes to be aware of:

  - With `env.autoPassthrough` on a sandbox spawn that uses a Claude subscription profile (claude-code), the profile's long-lived `CLAUDE_CODE_OAUTH_TOKEN` is now resolved from the OS keychain and sent into the box. Previously it was only forwarded when it was already present in the daemon's environment, so the credential now reaches a third-party box where it did not before. Sub-account pins are unaffected.
  - `AGENTPROTO_GIT_TOKEN` is an ordinary environment variable inside the box, so the agent running there can read it (and `sandbox_exec` can print it). Register a token scoped to the one repository and revoke it when the work is done. A box booted with a workspace's token can only be reused by that same workspace.

- 245ece0: Skill imports: a per-session skill registry + delivery, mirroring the MCP-import model.

  - `@agentproto/runtime` gains `skill-imports.ts` (`~/.agentproto/imported-skills.json`; import COPIES a `SKILL.md` folder into `~/.agentproto/skills/<id>/` with a content sha, snapshot-not-symlink), the `skill_import` / `skill_imported_list` / `skill_imported_remove` / `skill_resync` MCP tools, and spawn-time resolution (`resolveSessionSkills`) that turns the resolved `skills` list into concrete `sessionSkills` entries — non-imported ids warn (never throw) and stay in the adapter-facing list unchanged.
  - `@agentproto/driver-agent-cli` gains `AgentCliStartOptions.sessionSkills` and the adapter-manifest `metadata.sessionSkills` field (`{ dir, env? }`); before the child starts it copies each resolved skill into `<session configDir>/<dir>/<alias>/`, wiping stale entries first.
  - `@agentproto/adapter-claude-code` delivers into `$CLAUDE_CONFIG_DIR/skills/` (no env needed). `@agentproto/adapter-opencode` delivers into `<configDir>/skills/` and points `OPENCODE_CONFIG_DIR` at it — the only route that survives `lean` mode's `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, which gates opencode's auto-discovery but not its config-dir skill scan.
  - `@agentproto/cli` (`serve`) forwards `sessionSkills` to the driver and reports `deliversSessionSkills` from the adapter manifest's `metadata.sessionSkills`, so the daemon's adapter resolver no longer drops per-session skill delivery.

- 54a63fb: Store listings: optional `publisherUrl` (https) next to `publisher`, carried to app-catalog/v1 entries and checked by `catalog verify`.

### Patch Changes

- 34f035b: Agent Cards and app UI URLs now keep the public host behind a private tunnel: the link guard forwards the client's Host as `X-Forwarded-Host`, and the request base URL honors it (the configured public origin still wins).
- 66fc997: A2A GetTask completes when the agent's turn ends and returns its answer
- 8f5d7de: `app_run` without an explicit `adapter`/`harness` now resolves each agent's adapter like workflow agent refs do (AGENT.md `metadata.adapter`/`metadata.harness`, then `claude-*` model → `claude-code`, then `mastra-agent`), so A2A `SendMessage` tasks are no longer forced onto mastra-agent.
- f9375e0: Archive one-shot reviewer sessions once their review lane finishes (success, failure, timeout, abort and each retry attempt) so they stop piling up in the session list; the transcript and verdict stay readable. Add `POST /sessions/:id/archive`, the HTTP twin of the `session_archive` MCP verb (404 unknown session, 409 `session_not_terminal` while the session is still running), so HTTP clients can archive their own throwaway sessions.
- 3ce88cc: A session no longer becomes the sentinel owner of a PR it merely mentions: PRs found by the reconciler's output-scan lane are recorded for provenance but never auto-watched. The auto-watch delivery urgency is now configurable via `config.sentinel.autoWatchUrgency` (default `next-turn`).
- ddb440c: An OpenCode console org auth profile (`source: "opencode-console"` with an org sub-account) is now eligible for the opencode adapter on the `opencode` (Zen) route as well as `opencode-go`, injecting the same console token and org config. Because Zen bills the org's pay-as-you-go wallet, the Zen route admits such a profile only when it has an explicit `models.mode: "allow"` list containing the route-qualified id (e.g. `opencode/nemotron-3-ultra-free`); uncurated org profiles and plain api-key profiles stay single-route.
- 3bf44a7: Document that `hardStopAtPct` triggers auto-compaction and context-rescue before a hard stop.
- 0e5a8bc: Fix: `review_run({supersede: true})` no longer cancels a stacked sibling branch's review

  - `supersedeStale` in `packages/runtime/src/review-runner.ts` used to cancel
    any in-flight run with the same repo + binding + base whose head was an
    ancestor of the new run's head, regardless of branch. A stacked branch
    (e.g. `wt/p2` built on top of `wt/p1`) pushed from another worktree would
    then cancel `wt/p1`'s own in-flight review even though `p1` was never
    re-pushed, because `p1`'s head is trivially an ancestor of `p2`'s head.
  - Ancestry now only counts toward "same line of work" when both runs also
    share the same branch name — the intended case (a re-push of the same
    branch from a re-provisioned/another worktree after amend/fixup) still
    supersedes; same-checkout re-runs still always supersede regardless of
    branch; a detached `HEAD` only matches its own checkout.
  - Added `ReviewRun.branch` (the branch resolved in `repoRoot` when the range
    resolves; `undefined` on detached `HEAD`) and updated the `supersede` doc
    comments in `review-runner.ts`, the `review_run` tool description in
    `review-tools.ts`, and `docs/cli/verbs/review.md`.

- d16c74c: Fix: classify `endpoint is unavailable` as `upstream-5xx` transient error

  - Add `endpoint (is currently )?unavailable` pattern to `UPSTREAM_5XX_RE` regex in
    `packages/runtime/src/turn-retry.ts` so that messages like
    `AI_APICallError: Upstream request failed: Endpoint is unavailable` are classified
    as `upstream-5xx` and retried instead of being skipped as `other`.
  - Update doc comment in `packages/runtime/src/turn-retry-policy.ts` to mention
    "endpoint unavailable" as part of upstream-5xx.
  - Add test cases in `packages/runtime/src/__tests__/turn-retry.test.ts`:
    - "Endpoint is unavailable", "Endpoint is currently unavailable", and
      "Endpoint unavailable" now classify as `upstream-5xx`.
    - `missing_required_parameter` message stays as `other` (not retried).

- 0e01bd3: Sandbox spawns now carry a sub-account profile's scoping into the box: the provider's extra env (e.g. an opencode console org's inline `provider` config), the env var its bearer rides in, and the login-less data-home opt-out are forwarded beside the credential in `auth` (`credentialEnv` / `extraEnv` / `isolateDataHome`) and applied by the box's own driver, which layers the extra env over the adapter's lean inline config instead of replacing it — fixes `Workspace selection is required` for `access.profileRef` on a sub-account profile with `sandbox`. Sandbox spawns also never hand the box a host path to `AGENTS.md`: pointer mode is dropped and inline mode omits the host path from the fence header.
- Updated dependencies [ebfbfe2]
- Updated dependencies [ebfbfe2]
- Updated dependencies [877bc60]
- Updated dependencies [d7e24ba]
- Updated dependencies [245ece0]
  - @agentproto/review@0.6.0
  - @agentproto/sandbox@0.10.0
  - @agentproto/driver-agent-cli@2.12.0

## 5.18.0

### Minor Changes

- 94f29e6: Context floor (`hardStopAtPct`) now auto-compacts instead of hard-stopping: the runtime checkpoints, runs `/compact` (`/compress` on hermes), holds incoming prompts with a retryable "mid-turn" error while it works, and only falls back to continue-fresh and then a stop when compaction cannot bring the window down. Autonomous turns now evaluate the policy at turn end, stale hard-stop flags on live sessions are cleared, and every outcome is announced in the transcript and as a `session:context-rescue` event.
- 3f31dfb: Run adapter, capability and model discovery in an isolated short-lived worker process with caching. Add the `daemon.bootResumePolicy` option (`all` | `keepalive`), bound the session replay buffer by character count, and report `memory` in health output.

  Correct macOS process-footprint reporting without double-counting compressed
  memory. Support discovery from both bundled and source-run CLIs, with an explicit
  build/reinstall error for a missing worker.

### Patch Changes

- dee54cb: Stop repeated failed provider imports across the sentinel, tunnel and sandbox families. Discovery can list packages from pnpm's hoisted virtual store that are not resolvable from the runtime's own module base, so every MCP request re-ran dynamic imports that failed with `ERR_MODULE_NOT_FOUND` — each one entering Node 22's async ESM loader, whose error path leaks a MessagePort per failed import. A bounded, coalescing, 60s-TTL probe cache now answers "missing" once per specifier per window, guarded by a synchronous `import.meta.resolve` preflight (import conditions, same resolution base) so provably missing packages never reach the loader; only the credential-independent module namespace is cached, and provider handles are rebuilt per request with that request's own credentials. The discovered-package list is cached the same way.
- 6a9bb92: Clarify provider probe cache retry and explicit invalidation behavior, correct the documented Node error name, and strengthen the LRU eviction regression test.
- Updated dependencies [7609bc1]
- Updated dependencies [dee54cb]
  - @agentproto/model-catalog@0.12.5
  - @agentproto/workflow-loader@0.2.8
  - @agentproto/providers-store@0.3.28
  - @agentproto/app-kit@1.7.4
  - @agentproto/llm-endpoint@0.11.10
  - @agentproto/apps@0.22.1

## 5.17.0

### Minor Changes

- 63f27e8: Bound workflow-run persistence. `workflow-runs.json` is replaced by one file per run (`workflow-runs/<runId>.jsonl`), written asynchronously and only when that run changed; lease heartbeats rewrite a tiny `.lease` sidecar instead of the registry. Step and run outputs over a configurable ceiling (`AGENTPROTO_WORKFLOW_*` env overrides) keep a bounded preview plus a pointer, with the full value kept as a per-run artifact file that `workflow_status full:true` and `workflow_artifact_get` still resolve. Memory holds active runs plus a count/age-capped summary index and lazy-loads older runs; `WorkflowRunner.list()` returns summaries and `flush()` awaits durability. The legacy file is migrated on first boot (idempotent, `.bak` kept). Runs parked at `awaiting-approval` survive a restart as a small envelope and expire after `approvalTtlMs` (default 7 days) with `errorCode: "approval-expired"`.
- 0e8cd2d: Serve stale app UI bundles while rebuilding; skip mtime-only rebuilds
- 1195dd6: Sessions past the boot-history cap are reachable again, and review/workflow noise is grouped.

  **Cold history fallback.** `HISTORY_CAP` bounds how many sessions the registry reinflates at boot; older ones kept their `index.json` sidecar and `events.jsonl` transcript but no tool could return them. `session_list` now serves them with `includeCold: true` (and automatically when a `q` matches nothing live), `session_search` searches them the same way, `session_recap` recaps a cold id, and `conversation_read` resolves a registry miss from disk — enriched by the `conversations.jsonl` link index so the conversation-id ladder binds exactly instead of searching by cwd. Cold rows are terminal records (`pid: null`, `alive: false`, flagged `cold: true`), honour every filter exactly like live rows, are never merged into a non-empty live result, and are skipped for a subtree-scoped caller. Backed by a 30s-TTL scan cache (`session-cold-list.ts`). `session_search`'s cursor also stops returning an empty page 2: the handler no longer pre-slices the rows the `paginated` transformer pages over.

  **Noise-first eviction.** `loadHistorySnapshot` now spends `HISTORY_CAP` per lane — real sessions first, `review:*`/`wf:*` rows last — so a host that blew past the cap on gate-review traffic keeps its real history instead of silently evicting it under the flood.

  **Review grouping.** `session_tree` and the live-session widget's `app_session_tree` collapse review-lane / workflow-stage ROOTS under one synthetic parent per checkout (`{ id: 'reviews:<key>', label: 'reviews · <key>', synthetic: true, children }`, keyed by worktree basename else workspace slug). The node is flagged `synthetic: true` — not a session, never focusable — and the widget renders it as a group header. `byOrigin` is derived from the grouped tree so the companion view mirrors it.

  **Filters.** `session_list` (and `GET /sessions`) gain `label` (exact, case-insensitive) and `cwd` (boundary-aware path prefix); the CLI mirrors them as `--label` / `--cwd`.

- 1255f14: Add on-disk session retention. A new pass deletes terminal session dirs (`~/.agentproto/sessions/<id>/`) past their age: review lanes (`origin: "review"` / `review:` label) after `daemon.reviewSessionRetentionDays` (default 7), every other session only when `daemon.sessionRetentionDays` is set (default off). Live, pinned, keepAlive sessions and ancestors of a live session are never deleted; registry-held rows are forgotten before their dir is removed. The daemon runs it 10 min after boot and every 6 h (async, batched); `session_gc` gains `retention`/`dryRun`/`reviewMaxAgeDays`/`maxAgeDays`, `POST /sessions/gc` accepts the same, and `agentproto sessions gc --retention [--dry-run]` exposes it. The boot index backfill is now async and batched (`backfillSessionIndexesAsync`) and no longer blocks daemon startup.
- f3665ea: session-steward is now a three-step pipeline. `agentproto steward classify` writes a persisted snapshot (rules plus the Jev typed verdict, one recommended action per session from the closed set keep, mark-complete, mark-failed, relaunch, needs-input, close-abandoned, archive). `steward analyze` (or `classify --llm`) adds an LLM pass over the relevant sessions only (reason, question, errorKind, nextStep, relaunchHint). `steward act <snapshotId|latest>` applies the snapshot as a dry run by default, with a per-session staleness re-check, origin bounds, and custom rules from `.agentproto/steward-rules.yaml` or `--rules`. Bare `steward --apply` stays the one-shot.

  `relaunch` is recommended only for work that is not superseded by a later session of the same task, not owned by a workflow/gate/review/cron run, and failed within `--relaunch-window` (default 6h, rules key `failedMinutesAgo`); the rest are `mark-failed` with the reason.

  Fixes: a rule verdict for a stuck session now applies instead of being refused as `ambiguous_needs_judge`, and refusals say why; `model-bench` and other machine origins are no longer treated as user sessions. Session outcomes now carry `reason`, `question`, `errorKind`, `nextStep` and `by`, written by `act` and by `agentproto sessions stop --outcome --reason --error-kind --next-step`. The steward reads sessions through a `fields` projection with filters and pagination instead of `session_list {full:true}`, so hourly runs no longer persist the whole registry as a step output.

- 9c402bb: Add an opt-in `turnRetry` spawn option (`agent_start`, `POST /sessions/agent`, `agentproto sessions start --turn-retry`, user presets). It is off by default. When a turn fails on a transient provider error (`rate-limit` 429, `upstream-5xx`, or a `no-output-stall` where the provider silently retries), the daemon waits an exponential backoff and then sends the same live session a short continuation prompt. It never retries an interrupted turn, a killed or dead session (including the `maxCostUsd` kill), a session whose governance policy failed (e.g. `costBudget`), auth/billing errors (401/402/403), provider usage caps, or a turn that already made a side-effecting tool call (unless `retryAfterToolCalls`). The descriptor exposes the retry counter as `turnRetryAttempts`, plus `lastTurnRetryAt` and `nextTurnRetryAt`. Each transition emits a `session:turn-retry` event and a `[turn-retry]` transcript notice. The retry is marked `sent` only once the continuation prompt has passed admission: a rejected admission (concurrent prompt, kill, failed resume) is reported as a `cancelled` transition with the same `[turn-retry]` notice and costs nothing against `maxRetries`, while a retry whose timer lands on a session that moved on is cancelled with its notice in place. `session_events_poll`'s `types` filter accepts `session:turn-retry`. The CLI's `--turn-retry` parser validates the same numeric bounds as the daemon schema (positive-integer `maxRetries`, integer delays, `factor >= 1`) and fails with a clear message instead of silently dropping the policy. `session:turn-end` now also carries `interrupted` and `toolCalls`. `restartPolicy` is unchanged.

### Patch Changes

- c642dfd: Fix `agentproto app install <dir>` writing a bare `{appId, dir, dataDir}` registry record that made every `workflow_run_file` fail after a daemon restart (`Cannot read properties of undefined (reading 'some')`). The CLI now installs through the daemon's `app_install` when it is reachable and, when it is not, runs the same `performInstall` in-process (new `@agentproto/runtime/app-install-offline`), so both paths write the identical full record; an app that does not load is rejected instead of registered. The registry reader also tolerates partial or legacy records: missing `agents`/`workflows`/`unvalidatedAgentTools` are defaulted on load, unusable records (no `appId`/`dir`) are skipped, the daemon re-resolves partial records from their app dir in the background, and what was found is reported via `app_list` (`registryProblems`) and `daemon_health`/`/health` (`appRegistryIssues`) rather than thrown.
- 2af5732: Seek session event reads via a cached seq-to-offset index
- 05e1710: Review lanes skip an exhausted auth profile instead of spawning a doomed reviewer.

  When the OpenCode Go quota is spent, every Go preset in a lane's `preset -> fallbackPresets` chain died with `Go usage limit exceeded [wallet: profile "opencode-go-local"]` — and each lane still SPAWNED a full agent session for every Go preset before reaching a non-Go one (390 wasted sessions across 2026-10-09..11, each a process + a transcript dir). The host now keeps a per-daemon cooldown map keyed by `profileRef` for wallet exhaustion (`usage limit`, `quota exceeded`, `insufficient credit|balance|funds` — a 15-minute cooldown that blocks every model on the drained profile) and by `profileRef::model` for `rate limit exceeded` (60s, per model: several free models share one profile on purpose, and a chain falls back across them). The next attempt resolving a blocked key returns `skipped: auth profile '<ref>' [(model '<model>')] is exhausted until <iso> (...)` WITHOUT spawning — so the chain falls through to the next fallback instantly. The clock is injectable (`deps.now`) for tests; verdicts, timeouts and `block` results are unchanged and never fall back. The wallet regex is anchored on the provider phrasing (`usage limit (reached|exceeded)`) so an unrelated `context usage limit` no longer cools a healthy profile for 15 minutes, and a lane's own retry is never blocked by the cooldown its failed attempt just recorded (`rate limit exceeded` is transient and retryable via `laneRetries`).

- 73f807e: Sentinel: coalesce queued notices about the same thing (composable `SentinelCoalesceRule` registry; default rules for CI per PR+head and pushes per PR), replace-in-place in the prompt queue with `coalescedCount`, and a per-head CI rollup in the `local-gh` provider (first failure fires at once, success only once every check is done; partial passes are silent). Webhook check-suite summaries now name the app and short head sha.
- Updated dependencies [0c2ea34]
- Updated dependencies [0e8cd2d]
- Updated dependencies [1195dd6]
- Updated dependencies [7eea847]
- Updated dependencies [f3665ea]
- Updated dependencies [4e32602]
  - @agentproto/model-catalog@0.12.4
  - @agentproto/app-kit@1.7.3
  - @agentproto/apps@0.22.0
  - @agentproto/driver-agent-cli@2.11.0
  - @agentproto/workflow-loader@0.2.7
  - @agentproto/providers-store@0.3.27
  - @agentproto/llm-endpoint@0.11.9

## 5.16.0

### Minor Changes

- 6dec0d4: Let Claude Desktop / `claude` CLI sessions the daemon did not spawn own an AIP-46 inbox. An authenticated `/mcp` request whose `callerSessionId` is unknown and which carries `?host=<label>` now registers an `external` session (no process; alive for `daemon.externalSessionLivenessMs`, default 30 min, after its last MCP request or inbox poll), so `sentinel_watch`, `session_follow` and workflow notifications can deliver to it. `workflow_start` / `workflow_run_file` record the calling session and post one inbox item on run succeeded, run failed and approval/input suspension. New `agentproto hook inbox` Claude Code hook injects unread inbox items as untrusted `additionalContext` and acks them.
- 00fed67: Generalize opencode console workspaces into provider-agnostic sub-accounts. An auth profile can pin `subaccount: { kind, id, name? }` (an org / workspace / project of its account); a registry in `@agentproto/auth` (`registerSubaccountProvider`, `SubaccountProvider` with `list(account)` / `resolve(profile)`) applies the pin at spawn, so the runtime and auth packages no longer name any vendor. The opencode console implementation moved from `@agentproto/runtime` to `@agentproto/adapter-opencode` and is registered by the CLI at start-up. New `agentproto auth subaccounts list <profile|account> [--create [--prefix]]` and `auth profile create --subaccount <kind>:<id>`; `auth profile opencode-orgs` stays as a deprecated alias and legacy `source: "opencode-console:<orgId>"` profiles are migrated on read. Usage-limit failures name the profile and sub-account. `@agentproto/runtime` drops the `./opencode-console-source` export added by #1831 (never published in a release); use `@agentproto/adapter-opencode` instead. Consumers of `@agentproto/auth` outside the CLI must call `registerSubaccountProvider` before resolving or validating sub-account profiles (including legacy `opencode-console:` sources). `@agentproto/driver-agent-cli` honours `isolateDataHome: false` from a provider.
- c982376: opencode console workspaces (orgs) are now distinct, truthful wallets. opencode merges the active console org's provider block over every other config on start, so each spawn billed the active org whatever auth profile it named. A new source-backed api-key profile (`source: "opencode-console:<orgId>"`, no stored token) reads the console session read-only from `opencode.db`, fetches that org's provider block and injects the bearer plus block into the spawn; the new driver field `credentialDataHome` (opencode: `XDG_DATA_HOME`) runs an engaged-credential spawn in a login-less data dir, which also makes a plain api-key profile really bill its own key. An expired console session fails loud (never refreshed: the refresh token rotates). `agentproto auth profile opencode-orgs [--create] [--prefix <p>]` lists the console orgs and creates one profile per org. A `Go usage limit exceeded` failure (error event, session output, turn error) now names the wallet profile that hit it. Session usage and transcripts are read from the isolated opencode db when it exists.
- 927b257: opencode executors now start lean by default. A first request for "reply OK" was ~140k input tokens (the global `agentproto` MCP bridge's ~280 tool schemas, the skills list and the repo's `AGENTS.md`); the new `lean` context mode on the opencode adapter disables external skills, project config / `AGENTS.md` autoload and that bridge, bringing it to opencode's own ~8k floor. `defaults.adapters.opencode.contextProfile` (and `contextProfile` per spawn) opts out or in.
- 00fed67: Generalize opencode console workspaces into provider-agnostic sub-accounts. An auth profile can pin `subaccount: { kind, id, name? }` (an org / workspace / project of its account); a registry in `@agentproto/auth` (`registerSubaccountProvider`, `SubaccountProvider` with `list(account)` / `resolve(profile)`) applies the pin at spawn, so the runtime and auth packages no longer name any vendor. The opencode console implementation moved from `@agentproto/runtime` to `@agentproto/adapter-opencode` and is registered by the CLI at start-up. New `agentproto auth subaccounts list <profile|account> [--create [--prefix]]` and `auth profile create --subaccount <kind>:<id>`; `auth profile opencode-orgs` stays as a deprecated alias and legacy `source: "opencode-console:<orgId>"` profiles are migrated on read. Usage-limit failures name the profile and sub-account. `@agentproto/runtime` drops the `./opencode-console-source` export added by #1831; it was never published (absent from 5.15.0), so use `@agentproto/adapter-opencode`. Consumers of `@agentproto/auth` outside the CLI must call `registerSubaccountProvider` before resolving or validating sub-account profiles (including legacy `opencode-console:` sources). `@agentproto/driver-agent-cli` honours `isolateDataHome: false` from a provider.
- fdb7e74: Add `sandbox_exec` MCP tool for sandbox command execution

### Patch Changes

- 120cbbc: Sync generated catalog data from the pinned provider sources.
- 35fffc9: Pin the workstation template to @agentproto/cli 1.16.0 and record the dev template rebake.
- dcf3f33: `run.retry` seeds the retry's workspace with a copy of the original run's `scratch/` and `artifacts/`, so replayed steps' files (and any supervisor fix) are present. Journal output relocation no longer overwrites files already in the destination.
- 35fffc9: Regenerate workstation template pins (cli 1.16.0, refreshed adapter and opencode-ai versions) and the derived baked metadata via `sync-templates`. No API change.
- ecb70c1: sandbox_exec on e2b no longer kills the command after e2b's 60-second default; an omitted timeoutMs now runs as long as the box lives.
- 86f43d7: Session steward: a PR is not proof a session is finished. A would-be `done` close is now downgraded to a flag (`needs-input`) when the last assistant message asks the user a question, announces a next action or leaves work pending — this includes the `parentEnded` path that closed children holding an open question to a dead parent. The terminal-session relabel gains `needs-follow-up` (open PR still awaiting review/merge) and PR numbers are repo-qualified (`owner/repo#N`). The loop rule no longer counts recursive `rg`/`grep` over a directory as a repeated file read, and the zero-candidate report breaks exclusions down per reason.

  Runtime: `session_wrapup_plan` evidence carries `worktree.pr` state (`open`/`merged`/`closed`) and a `worktreePrOpen` signal; a fresh `starting` session that is not stuck is kept instead of sent to the judge.

  Workflow loader: the workflow entry's relative imports are versioned with the entry (`agentproto_v`), so editing a helper next to `entry.mjs` is picked up on the next run instead of being served from Node's module cache.

- Updated dependencies [5c1b40d]
- Updated dependencies [120cbbc]
- Updated dependencies [00fed67]
- Updated dependencies [c982376]
- Updated dependencies [dcf3f33]
- Updated dependencies [00fed67]
- Updated dependencies [fdb7e74]
- Updated dependencies [86f43d7]
  - @agentproto/model-catalog@0.12.3
  - @agentproto/auth@1.2.0
  - @agentproto/driver-agent-cli@2.10.0
  - @agentproto/workflow-runtime@0.17.2
  - @agentproto/sandbox@0.9.0
  - @agentproto/apps@0.21.2
  - @agentproto/workflow-loader@0.2.6
  - @agentproto/providers-store@0.3.26
  - @agentproto/llm-endpoint@0.11.8
  - @agentproto/secrets@2.0.1
  - @agentproto/review@0.5.0
  - @agentproto/app-kit@1.7.2
  - @agentproto/acp@0.10.0
  - @agentproto/pairing-host@0.2.6
  - @agentproto/eval-reporters@0.2.23
  - @agentproto/telemetry-langfuse@0.2.21

## 5.15.0

### Minor Changes

- ab367ec: Narrow `session_list` server-side instead of reading hundreds of sessions. New optional filters, shared by the MCP tool, `GET /sessions` and `agentproto sessions [list]`: `q` (substring over id/name/label/title/cwd), `excludeNoise` (drops `review:*`/`wf:*` sessions and ended command / plain-terminal runs), `excludeLabelPrefix`, `excludeLabels`, `excludeKinds`, `rootOnly`, `parentSessionId`, `updatedSince` and `startedSince` (ISO or relative, e.g. `24h`). Rows now come back newest-activity first and the response carries `total` for the filtered set. `fields` is now honoured without `limit`, and `session_list` errors are returned as tool errors. Without any filter the response only gains `total`. `paginated` in `@agentproto/tool` gains an `includeTotal` option; the long-form help moves to `tool_help {name:"session_list"}`.

### Patch Changes

- 66a2708: Sync generated catalog data from the pinned provider sources.
- 60a1fd2: Session steward: keepAlive sessions idle past `keepAliveAskAfterMinutes` with a merged or clean worktree can now be asked and closed on a declared DONE. Runtime: added tests covering this.
- 1049264: Name the session in turn activity titles instead of its raw id. The activity feed now reads `Turn 3 completed on "Add VAT and discounts"` (session title, else label, truncated at 60 characters) rather than `Turn 3 completed on sess_a2916375`; a session with neither keeps the bare id. Activity ids, `sessionId` and `sourceRef` are unchanged.
- 17c17f5: MCP Events webhook deliveries are now observable: one log line per delivery attempt (sentinel, event, callback host only, HTTP status or redacted error, attempt, final delivered/dead), and `sentinel_list` / `GET /sentinels` report a per-sentinel `deliveryStatus` (`active`, `lastDeliveryAt`, `lastStatus`, `lastError`, `attempts`, `dead`). URL paths, tokens, bodies and secrets never reach logs or status. The `events/subscribe` result is unchanged.
- Updated dependencies [66a2708]
- Updated dependencies [eee0a3c]
- Updated dependencies [68c5ce6]
- Updated dependencies [60a1fd2]
- Updated dependencies [ab367ec]
- Updated dependencies [60a1fd2]
  - @agentproto/model-catalog@0.12.2
  - @agentproto/apps@0.21.1
  - @agentproto/app-kit@1.7.1
  - @agentproto/tool@0.5.1
  - @agentproto/providers-store@0.3.25
  - @agentproto/driver-browser@0.2.2
  - @agentproto/driver@0.3.2
  - @agentproto/driver-http@0.1.12
  - @agentproto/governance-engine@0.1.12
  - @agentproto/mcp-server@0.6.3
  - @agentproto/workflow-runtime@0.17.1
  - @agentproto/llm-endpoint@0.11.7
  - @agentproto/plugin-local-browser@0.3.4
  - @agentproto/adapter-browser@0.3.2
  - @agentproto/eval-reporters@0.2.22
  - @agentproto/telemetry-langfuse@0.2.20
  - @agentproto/workspace-brain@0.5.2
  - @agentproto/review@0.5.0
  - @agentproto/sandbox@0.8.5

## 5.14.0

### Minor Changes

- 4a833e9: Agent steps retry transport failures. A `kind: agent` step whose session dies before its first turn ends (killed or crashed mid-turn, "ACP connection closed") is re-spawned with the same prompt in the same run workspace, instead of failing the run. By default that is one retry after 1 s. A step can set `retry: { max_attempts, backoff, initial_ms }` in WORKFLOW.md, the same block gates take; `max_attempts: 1` turns it off, and a declared `retry` also covers spawn failures. A turn that ended is never retried (empty or errored reply, schema mismatch, input request), and neither is a deliberately ended session, a cancelled run or a `sessionRef` reuse. Each retry is logged as a `step.retrying` run event. New exports: `AgentSessionLostError`, `isAgentTransportFailure`, `DEFAULT_AGENT_TRANSPORT_RETRY`, and the `onAgentRetry` run hook.
- 19a1c97: Serve an app's bundled tools as an HTTP MCP server (`agentproto mcp-app` over HTTP, `@agentproto/runtime/app-mcp-server`). toMcpTool advertises real parameters for manifest-only (TOOL.md, JSON Schema) tools instead of an empty shape that made them uncallable.
- a8df730: `app_tool_call` (and `POST /apps/:appId/tool-call`) can now run an app's own bundled tools: an id in the app's `ui.tools` allowlist that matches one of its `.agentproto/tools/<id>/TOOL.md` contracts is executed through the app's `.agentproto/drivers/*/DRIVER.md` implementations (AIP-30 `runTool`), the same pair workflows already use. Other ids still go to the daemon tool dispatch or `imported:<alias>/<tool>`.
- 5b021a8: `branch_gc` / `worktree_gc` daemon tools: smaller, truthful responses and a faster plan. `branch_gc_status` takes `classes`, `scopes`, `section`, `results`, `limit` and `cursor`, and `full: true` now returns one filtered page (default 100 rows, with `page.nextCursor`) instead of the whole 65k+ character result. An apply result carries a top-level `status` and an `applySummary` (deleted / skipped / failed per scope, plus the restore log path). A running job no longer announces a `resultPath` that does not exist yet. `terminal_sessions_list` called without `limit` is capped at 50 rows with `total` / `truncated` / `nextCursor`; `paginated()` gains a `defaultLimit` option for this. The branch gc ladder computes `git patch-id`s once per commit and reuses merge-bases instead of running `git cherry` per tip (about 2.5x faster on a 374-ref repo, identical classification).
- ca14bc2: Add an opt-in public events origin, `POST /mcp/events/<secret>`, that serves a dedicated events-only MCP surface
  (`events/*` plus one probe tool) over the 2026-07-28 protocol. Disabled unless `AGENTPROTO_MCP_EVENTS_SECRET`
  (32+ chars) is set; subscriptions are limited to `AGENTPROTO_MCP_EVENTS_REPOS`.
- ca14bc2: Add opt-in public `POST /mcp/events/<secret>` events-only MCP surface (`eventsMcp` option) with a repo allowlist on subscribe.

### Patch Changes

- 1dedaaa: Confirming an `app_install` from an app panel's `window.McpApp` bridge no longer fails with an unknown-key error. The second call echoes the preview's `confirm` nonce, and `appInstallInputSchema` is strict, so `dispatchAllowlistedAppTool` now strips `confirm` from the args before dispatching to `dispatchTool` or an imported tool. Direct MCP/CLI `app_install` calls are unaffected.
- e190733: The public MCP events origin now runs as its own principal (`sessionPrincipal("mcp-events-origin")`) instead of the operator's daemon-bearer principal, so a holder of the events URL can no longer see or cancel the operator's subscriptions. A malformed percent-encoding in `/mcp/events/<secret>` answers 404, and OPTIONS on that route answers 405 with `Allow: POST`. `initialize` on the modern core is now a 404 `-32601` (naming the supported versions in `data`). The 2026-07-28 contract rows run as real tests, and `docs/mcp-events-integration.md` documents the events origin.
- 6bcecee: Send `X-MCP-Subscription-Id` (the sentinel id returned by `events/subscribe`) on every signed event delivery attempt; OpenAI rejected deliveries without it (found against ChatGPT).
  `events/subscribe` results now carry `truncated: false` alongside `cursor: null`.
- 36425c9: MCP Events: Agentpush sentinel deliveries are now durable. The webhook outbox enqueue is atomic, synced and awaited before a poll ack or push 2xx; a poll batch ack covers only items that were delivered or quarantined (malformed items are quarantined, not skipped). Providers can `renew(handle, until)` and `events/subscribe` refresh renews the remote subscription, with typed handling for an already expired or deleted backing subscription. Cancellation is tracked in remote-id keyed tombstones that retry until the remote is gone, so an immediate re-subscribe cannot race a cancel. New Agentpush subscriptions reject legacy body-only sha256 signatures.
- 9c8996e: Add a transport-free core for the stateless MCP 2026-07-28 era (not served on any route yet): request validation, an in-process bridge to a fresh legacy server, `server/discover`, result decoration, and `recordResult` on the MCP session observer.
- a116799: Bridge the MCP 2026-07-28 core to the in-process server over raw JSON-RPC instead of an SDK client, so `server/discover` keeps the `events` capability and handler errors keep their exact message.
- e927cb2: Docs: document tunnel private-by-default and revoke, knowledge supersede/explain, pricing tiers, and compaction checkpoint/compactRequiresOperator.
- 8987507: Stabilize session-steward workflow test ordering by using a single shared timestamp for fixture rows.
- 66d076a: Add MCP 2026-07-28 contract fixtures and characterization tests for the `/mcp` endpoint.
- 2eeeb57: Add tests covering codex's confined CODEX_HOME in parallel workflow branches.
- 4c9745d: Add optional `stateHome.seed` (name → content) to the agent-cli driver, written into the isolated per-session home on confined spawns. The codex adapter uses it to ship `project_root_markers = []`. Runtime change is test-only.
- 91630ea: Codex now starts inside an app boundary. Adapters can declare a `stateHome`; an OS-confined spawn gets an isolated per-session home (the session's adapter config dir) with only the declared login files linked back from the real one. Codex declares `CODEX_HOME` / `.codex` sharing `auth.json`, and the codex transcript exporter reads a confined session's rollouts from its own home.
- ef1fb49: Fix the builtin App Store panel showing "No apps installed, and the app catalog is empty" when opened standalone at `/apps/@agentproto/store/ui`. The standalone `tool-call` route wraps a builtin tool's MCP result a second time, and the panel bridge's `callTool` peeled only one layer. It now unwraps nested envelopes recursively, honours `isError` at every layer, and returns non-JSON text as a string, which fixes every builtin panel opened standalone. The store lists builtin panels from the catalog's `category: "builtin"` rows (open by default, each with an Open button, never counted as Available or toward the empty state), and its status bar shows installed / available / builtin counts. `@agentproto/runtime` only gains a comment on the double-wrap; the wire shape is unchanged.
- 81196cb: Stop the workflow runner from starving the event loop. Every step transition rewrote the entire runs file synchronously (228 MB with a few hundred retained runs), which blocked the loop for minutes across a long run so the lease heartbeat never fired and the liveness sweep orphaned healthy runs. Writes that don't change any run's status are now coalesced to at most one per `persistMinIntervalMs` (default 2s, trailing flush, flush on exit); status changes still flush immediately and the file is written compact. The daemon's liveness sweep also skips a tick that fired seconds late, since overdue renewals mean a starved loop rather than dead owners.
- Updated dependencies [4a833e9]
- Updated dependencies [19a1c97]
- Updated dependencies [b7ddf13]
- Updated dependencies [5b021a8]
- Updated dependencies [1645a51]
- Updated dependencies [6cf7140]
- Updated dependencies [e927cb2]
- Updated dependencies [4c9745d]
- Updated dependencies [3e61035]
- Updated dependencies [754a694]
- Updated dependencies [6a86cd8]
- Updated dependencies [91630ea]
- Updated dependencies [2e7d918]
- Updated dependencies [ef1fb49]
  - @agentproto/workflow-runtime@0.17.0
  - @agentproto/mcp-server@0.6.2
  - @agentproto/app-kit@1.7.0
  - @agentproto/tool@0.5.0
  - @agentproto/apps@0.21.0
  - @agentproto/model-catalog@0.12.1
  - @agentproto/driver-agent-cli@2.9.0
  - @agentproto/review@0.5.0
  - @agentproto/sandbox@0.8.4
  - @agentproto/driver-browser@0.2.1
  - @agentproto/driver@0.3.1
  - @agentproto/driver-http@0.1.11
  - @agentproto/governance-engine@0.1.11
  - @agentproto/workspace-brain@0.5.1
  - @agentproto/providers-store@0.3.24
  - @agentproto/eval-reporters@0.2.21
  - @agentproto/telemetry-langfuse@0.2.19
  - @agentproto/plugin-local-browser@0.3.3
  - @agentproto/adapter-browser@0.3.1
  - @agentproto/llm-endpoint@0.11.6

## 5.13.0

### Minor Changes

- 0ea7fe9: Store listing fields on app-catalog/v1 entries (all optional): `tagline`, `longDescription` (markdown), `screenshots` ({url, alt, width?, height?}), `categories`, `homepage`, `repository`, alongside the existing `icon` and `publisher`. Declared in an APP.md `store:` block and written by `agentproto app pack --release --entry`, which checks the media and copies them to `media/<appId>/<version>/` next to the entry (`--media-base-url` relocates them). `agentproto catalog verify` checks the listing (limits, https, alt text, image format and size); `--local-media <prefix>=<dir>` reads media from a checkout. `store/` is left out of release bundles. A relative top-level APP.md `icon` is no longer copied into a public entry.
- 25ffb55: Context-losing steps now write a checkpoint first, and compaction can be reserved to the operator. A `/compact` or `/compress` prompt, the runtime's own auto-compaction and the context hard stop each persist a checkpoint (goal, plan, decisions, changed files, tests, errors, risks, next step) before they act; if the checkpoint cannot be written, compaction is refused (the hard stop still happens, with a loud warning). New `contextContinuity.compactRequiresOperator` policy flag: a compaction prompt attributed to a session (`agent_prompt`, `session_compact`, the session itself) is refused, so only an operator-originated prompt can compact. `session_compact` now attributes its prompt to the calling session.
- 17112d0: `tunnel_create` is private by default: a signed-link access guard (random bearer token, 24h TTL by default, instant revoke, `X-Robots-Tag: noindex`, blocks `/@fs/` and source maps) now sits in front of every tunnel unless `public: true` is passed explicitly. The descriptor's new `url` field is the one to actually share — `publicUrl` alone now rejects every request without a valid token or cookie. New `tunnel_revoke` tool/route/CLI subcommand instantly invalidates the current link without stopping the tunnel.

### Patch Changes

- 796e0f3: Sync generated catalog data from the pinned provider sources.
- ebf8631: `session_continue_fresh` no longer fails with `Cannot read properties of undefined (reading 'includes')` when the daemon's `policies.json` holds terminal policies persisted before fan-in `sessionIds` existed. Reload now normalizes `sessionIds`/`pending` on terminal policies, as it already did for active and awaiting-ack ones, and `policyWatchesSession` tolerates a state without `sessionIds`.
- 31fbe12: session-follow no longer resurrects a dead follower id that already has a live replacement: a digest batch queued before a follow was re-pointed to a revived follower (or whose dead descriptor's `continuedTo` already links to one) now delivers to that live session instead of calling `restartSession` again. Concurrent deliveries racing for the same dead id now share a single in-flight revival instead of each spawning their own.
- badf321: `IKnowledgeProvider` gains `supersede(id, by?)` and `explain(id)`, plus the `KnowledgeProvenance` type and a typed `KnowledgeNotSupportedError`. The corpus adapter implements both for real: `supersede` flips an AIP-10 entry to `deprecated` with a `supersededBy` link and a `deprecated` attestation (CAS write, `curate` capability when a caller is set), and `explain` returns the entry's sources and attestation chain, honoring the same visibility rules as reads. gbrain-doc implements `explain` from `get_page`; files returns file-level provenance; supersede (all three) and qdrant's explain throw `KnowledgeNotSupportedError`. `FederatedKnowledgeProvider` fans `supersede` out with `Promise.allSettled`: a backend that throws `KnowledgeNotSupportedError` is skipped while another succeeds, but a genuine failure on any backend is surfaced (a partial-apply error naming the failing backends) so backends never silently diverge; it answers `explain` with the first non-null result. Existing methods are unchanged.

  Breaking for out-of-tree implementers: `supersede` and `explain` are required members of `IKnowledgeProvider`, so a custom implementation stops compiling until it adds them (throwing `KnowledgeNotSupportedError` is a valid body). This ships as a minor because `@agentproto/knowledge-engine` is pre-1.0 (0.x, where minor is the breaking-change channel); optional methods were rejected because every caller would then need `provider.supersede?.()` guards and a missing implementation would fail at runtime instead of compile time. (runtime: test stub only.)

- 3e46f5a: Prompt-length pricing tiers. `LLMPricing` gains an optional `tiers: [{ aboveInputTokens, inputPer1M, outputPer1M, cacheReadMultiplier?, cacheWriteMultiplier? }]`, and the new `selectPricingTier(pricing, promptTokens)` flattens a row to the rates for a given prompt length. `calculateLLMCreditCost` (and so `calculateCost` and `getCacheStats`) bills the whole request at the tier its prompt falls in, counting cache-read and cache-write input toward that length. Claude Haiku 5.5 is $0.10/$0.50 up to 100k prompt tokens and $0.50/$2.50 over it, so long prompts were priced 5x too low before this. The `llm:openrouter` generator and `scripts/catalog-sync/sync-anthropic.mjs` emit tiers from OpenRouter's `pricing.overrides` (`min_prompt_tokens` entries only; time-of-day discounts are ignored). Runtime session cost picks the tier from the latest request's `contextUsed`.
- 9aed05d: Repo maintenance: reviewers spawn again. A workflow agent step started in a review worktree (`branch_gc_review_worktree`) now gets that worktree and its repo's git dir as read-only zones, so `reviewOne` passes the app boundary check and git can read the branch under the OS sandbox. Before, every reviewer was refused with `app_boundary_cwd_outside` and the run recorded no verdicts. A look-alike directory in the review root is still refused. The maintain report also groups one failure that hit several branches as a single reason. `agentproto workflow status` prints step labels. Compact `workflow_status` folds repeated circuit-open skips into one row and caps large run outputs.
- c5a67f7: Test-only: the mcp-events e2e full-story test now subscribes under a frozen clock and asserts `refreshBefore` exactly, instead of bounding the granted TTL delta by +50 ms of wall clock (which flaked on loaded CI runners).
- dad18f3: Session steward: errored sessions are no longer auto-closed as done, relabel proposes `unknown` instead of `abandoned` without PR evidence, and loop detection ignores anonymous calls and reads the file after the read verb.
- 70b8e9c: Session steward: a dry run (`apply: false`) no longer appends verdict memory to the `app_state` ledger, so its verdicts cannot be served from cache to a later real pass; the report says the memory was read but not written.
- badf321: Add `supersede()` and `explain()` to the knowledge provider contract, with `KnowledgeNotSupportedError` and provenance types. Implemented across the corpus, files, gbrain-doc, qdrant and federated providers.
- ccebf3b: A retired session is never revived by an automated path. One `isRetired` predicate (archived, a deliberate `endedReason`, a `continuedTo` successor, or the new `retiredAt` stamp) gates session-follow digests, sentinel notices, cron `prompt-session` (decided by status, tagged `source: "cron"`), the restart sweep, `continue-interrupted`, and the restart helpers, in place and under a new id. The automated-source allowlist now includes `daemon:*` and `workflow:*` (the workflow agent host tags its prompts `workflow:agent-step`). Notices for a retired follower/target go to the end of its `continuedTo` chain (the follow/sentinel is re-pointed there, same id and cursor) or are parked. An inbound message (a human) follows `continuedTo`, otherwise may revive the row in place, but an archived row is never revived under a new id: the message is parked with a log line.

  A human prompt to a superseded or retired row fails with HTTP 409 `error: "session_not_alive"` (unchanged code) plus `reason: "superseded" | "retired"` and `continuedTo` when set; the MCP `message_send` / `agent_prompt` errors carry the same fields. `forceResume: true` in the body overrides.

  New HTTP-only `POST /sessions/:id/retire { successor?, reason? }` stamps retirement on an alive or terminal row (idempotent), sets `continuedTo`, and re-points follows and sentinels in place. `SessionSummary` now exposes `retiredAt` (and `continuedTo`). Archive stays reversible and no longer touches follows or sentinels; `forget()` / `DELETE /sessions/:id` re-points them to the successor, or deletes follows and cancels sentinels when there is none. Also: a refused restart clears `nextRestartAt`, `continuedTo` is stamped on the prior row only after a pending successor provisions, and the sentinel path decides liveness by status, not `processAlive`.

- 7512f38: Session cost now prices router ids on the router's own rate. `opencode-go/kimi-k3`, `opencode/claude-sonnet-4-6`, `vendor/model@requesty`, `vendor/model@openrouter` and `vendor/model@huggingface` resolve through their route table instead of falling through `resolvePricing`'s substring scan onto the direct vendor row (which priced `opencode-go/kimi-k3` at direct Moonshot rates). A router id missing from its router's table is now reported as `no-pricing` rather than borrowing the vendor's price. Bare ids and OpenRouter-native `vendor/model` ids are unchanged.
- 67104f5: `settlePendingWrites()` now also waits for the transcript-stream closes that `forget()` and `shutdown()` start, so the sessions tests can drain every write before removing their temp dir instead of retrying the removal on ENOTEMPTY.
- 70b8e9c: Session steward: a dry run (`apply: false`) no longer appends verdict memory to the app's `app_state` ledger, so its verdicts cannot be served from cache to a later real pass; the report says the memory was read but not written.
- dad18f3: Session steward: a session whose last turn errored is no longer auto-closed (it goes to the judge); relabel proposes `unknown` instead of `abandoned` when no PR is recorded, and no longer credits a session with a sibling worktree's merged PR; loop detection no longer collapses arg-less in-agent calls into one signature and reads the file after the read verb rather than a leading `cd` path.
- a32538f: Reload the app UI build placeholder page so embedded browsers refresh it
- 87b658a: `transmit_message` no longer re-points a contact binding from a revived session back to its dead ancestor. A revived session keeps quoting its ancestor's id, so each reply used to reset the binding to the dead session and the next inbound message resurrected yet another copy. An ancestor id (via `continuedFrom`) now never overrides a binding already on its descendant.
- Updated dependencies [0ea7fe9]
- Updated dependencies [796e0f3]
- Updated dependencies [a5050a6]
- Updated dependencies [badf321]
- Updated dependencies [3e46f5a]
- Updated dependencies [9aed05d]
- Updated dependencies [7c06811]
- Updated dependencies [5733913]
- Updated dependencies [dad18f3]
- Updated dependencies [70b8e9c]
- Updated dependencies [badf321]
  - @agentproto/app-kit@1.6.2
  - @agentproto/model-catalog@0.12.0
  - @agentproto/workspace-brain@0.5.0
  - @agentproto/apps@0.20.3
  - @agentproto/providers-store@0.3.23
  - @agentproto/llm-endpoint@0.11.5

## 5.12.0

### Minor Changes

- fdaaf7d: Remove every link to the retired cli.agentproto.sh host. The `PAIR_WEB_URL` export is removed from secrets and pair-client (breaking). The daemon no longer trusts the cli.agentproto.sh origin by default, and `remote_enable` only returns a `phoneUrl` when `@agentik/session-chat` is installed. The session-story panel's full-panel link now opens the daemon's live-session panel.
- fdaaf7d: Remove every link to the retired cli.agentproto.sh host. `PAIR_WEB_URL` (the opt-in shared pair page on that host) is no longer exported; the default per-daemon pair page is unchanged, and a self-hosted shared page still works through `pairing.pairPage` / `--pair-page`. The daemon no longer trusts the `https://cli.agentproto.sh` origin by default. `remote_enable` only returns a `phoneUrl` when the `@agentik/session-chat` app is installed (there is no hosted panel fallback anymore; pair a phone through rendezvous with `agentproto pair offer --qr`). The session-story panel's "panneau complet" link now opens the daemon's own live-session panel for that session, and is hidden when the panel is not served by the daemon.
- 468059d: Add a built-in `session` sentinel provider (AIP-60): `sentinel_watch { subject: "session:<id>" }` now watches another session's own lifecycle — turn-end, awaiting-input, exit — and lands matching events into the caller's inbox even if the watched session never calls `message_parent`, self-expiring once it exits (`until` defaults to `subject_terminal` for this subject scheme). `agentproto sentinel watch session:<id>` and its CLI usage text gain the same capability.
- 1e758e6: `agentproto app validate` (and `catalog verify`) checks an app's `ui.tools` against the daemon's real tool surface instead of a hand-kept list of 21 names, which rejected valid apps such as session-chat. The list is `DAEMON_TOOL_NAMES`, exported as `@agentproto/runtime/daemon-tool-names`, generated from a gateway's `tools/list` with every optional surface wired (`pnpm --filter @agentproto/runtime gen:daemon-tool-names`) and kept exact by a runtime test.

### Patch Changes

- c1583a5: session_follow: `excludeFollowerChildren: false` now actually delivers the follower's own descendants (any depth) under a broad selector, bypassing `rootOnly`/`cwdPrefix`. Before, a supervisor following `all` (rootOnly by default) still missed every child it spawned.
- ddbc8ca: Fix `POST /sessions/:id/restart`, the `session_restart` MCP verb, the
  sentinel/inbound restart hooks, and the cron scheduler's `prompt-session`
  auto-resume minting a new session id without carrying forward the prior
  session's `keepAlive` / `notifyParentOnCrash` / `sentinelAutoWatch` /
  `restartPolicy` flags, without re-stamping the daemon's self-mount
  `mcpServers` entry with the NEW session's id (so spawns/commands the
  restarted session made kept attributing to the dead OLD session), and
  without closing the OLD row when it was still alive — leaving two live
  processes on the same conversation. The OLD row is now closed with a
  deliberate `"restarted"` end reason after a successful restart (never
  treated as a crash), except for a sandbox restart, where closing it would
  tear down the box the new session just reconnected to. Every production
  restart path now threads the daemon's own `/mcp` URL through so the
  `mcpServers` re-stamp can actually happen; a path that still doesn't wire it
  falls back to carrying `mcpServers` through untouched (keeping the prior
  identity) rather than stripping it to no identity at all.
- 690f31a: Sentinels: a target session whose row no longer exists (deleted, not merely ended) now parks the event and orphans the sentinel instead of failing the delivery on every poll. Before, the event was never marked seen, so the sentinel never reached its terminal event and retried forever (thousands of `delivery failed: sendMessage: no session` log lines).
- baebdce: session-steward: the "terminal sessions missing an outcome" proposals now use real evidence instead of always falling back to `abandoned`. A session whose list row records an opened PR (`openedPrs` / `outcome.artifacts`) is proposed `done` with the PR in the reason (`PR #1738 merged`, `PRs #1738, #1740 opened`); a merged worktree/PR or an open PR seen through `session_evidence` is proposed `done` too. That lookup runs only for the newest 20 listed sessions; the rest stay `abandoned`.
- Updated dependencies [8e87002]
- Updated dependencies [fdaaf7d]
- Updated dependencies [fdaaf7d]
- Updated dependencies [11d503f]
- Updated dependencies [baebdce]
  - @agentproto/app-kit@1.6.1
  - @agentproto/secrets@2.0.0
  - @agentproto/apps@0.20.2
  - @agentproto/acp@0.10.0
  - @agentproto/pairing-host@0.2.5
  - @agentproto/sandbox@0.8.3

## 5.11.1

### Patch Changes

- d147f9f: `session_capabilities`'s `mcpServers[].error` no longer reports a false positive for the daemon's own `/mcp` mount: a harness probing the deregistered `server/discover` method (removed in #1684) and falling back to `initialize`/`tools/list` is normal negotiation, not a failed mount, and a successful `tools/list` now clears any earlier handshake error instead of leaving it stuck in the response.
- 9018b92: session-steward: a 0-token session is only "never ran" (stuck) when it is not busy, not starting/provisioning, has no queued first prompt, and is both older and idler than `idleMinutes` (a just-started busy session used to be flagged), and the "terminal sessions missing an outcome" section now lists only sessions that ended within the new `relabelWindowHours` input (default 24), at most 20 newest first, with a per-label count and an "… and N more" line instead of hundreds of lines.
- Updated dependencies [1130a2d]
- Updated dependencies [1130a2d]
- Updated dependencies [9018b92]
  - @agentproto/apps@0.20.1

## 5.11.0

### Minor Changes

- ce27b0d: `session_capabilities` now reports what a session's harness actually loaded from the daemon's own `/mcp` mount: optional `status` (`declared` | `connected` | `listed` | `error` | `never-contacted`), `toolCount`, `tools`, `deferred`, `protocolVersion`, `lastSeenAt` and `error` on `mcpServers[]`. The daemon also emits an `mcp:degraded` session event (visible in `session_events_poll`) when a turn ends with the mount never listed, listing zero tools or failing.
- f3e06dc: Add the App Store builtin panel (`@agentproto/store`, tool `agentproto_store`): the browse/install surface over `app_catalog` / `app_list` / `app_updates`, with confirmed installs (`app_install` issued from an app panel's tool-call surface now answers a `{needsConfirmation}` preview first and installs only on a second call echoing the preview's `confirm` token; direct MCP/CLI calls are unchanged), `app_resync` / `app_uninstall` actions, install-from-URL, catalog sources warnings, builtin panels, and `GET /store` redirecting to `/apps/@agentproto/store/ui` with the query preserved. VS Code: `agentproto.openStore` command.
- 2ed619f: Publishing pipeline for agent apps: `agentproto app pack --release --entry` writes a validated catalog entry (`<slug>-<version>.entry.json`) beside the release bundle, with the bundle's sha256/size and a GitHub Releases asset URL (overridable via `--asset-url`); the new `agentproto catalog build` verb merges entry files into the deterministic published `apps.json` (base merge by appId, higher version wins, `--check` drift guard, `--emit-ts` for the embedded fallback; explicit `.json` files of any name and recursively walked directories, duplicate appId among the inputs is an error); the new `agentproto catalog verify` verb downloads an entry's bundle (https only, the same caps as `app_install`, local substitution via repeatable `--offline-file <appId>=<path.agentapp>`), checks `source.size`, unpacks and reconciles the manifest digest with `source.sha256`, checks the unpacked APP.md (id, version, no `ui.build`) and runs the `app validate` checks. The default catalog source URL is now `https://agentproto.sh/catalog/v1/apps.json`, and `pnpm --filter @agentproto/runtime catalog:first-party` re-syncs the embedded first-party catalog from it (also wired into the catalog-sync workflow).

### Patch Changes

- 6c6cbd3: Handoff and checkpoint fixes from the cold-run review. `sessions handoff --dry-run` stays read-only but now says its content is an approximate extraction (`approximate` and `approximateNote` in the response) because the real handoff interrogates the source session. The handoff question, the source session's JSON reply to it, and the daemon-composed role/AGENTS.md preamble are tagged in the transcript export (`internal`) and left out of `recentDigest`, the fallback `nextStep` and the resume prompt. `nextAction: "compact_then_continue"` is now only suggested inside the compact band (`compactAtPct` up to `continueFreshAtPct`), not at low context. The 401 `sessions_unauthorized` message names `<workspace>/.agentproto/runtime.json` as the token source and how to send it, and the CLI's fallback 401 explanation no longer says it cannot tell where the token came from.
- a55c647: Test-only: the session activity-phase test now retries its temp-dir teardown instead of racing the transcript stream's async close (fixes an intermittent ENOTEMPTY in CI).
- 3ea7d79: session-steward: the workflow now reads the un-paged `{sessions}` shape from `session_list` (a dry run over 545 sessions used to report "0 live, 0 terminal"), defaults its verdict-memory `appId` to the installed `@agentproto/session-steward` (resolved through `app_list`, so a missing app turns memory off with a report note instead of failing a step; `appId: ""` really disables it), and waits for `session_wrapup_plan` instead of accepting the `{jobId}` fallback.
- Updated dependencies [5f4f30d]
- Updated dependencies [3ea7d79]
- Updated dependencies [f3e06dc]
  - @agentproto/model-catalog@0.11.4
  - @agentproto/apps@0.20.0
  - @agentproto/providers-store@0.3.22
  - @agentproto/llm-endpoint@0.11.4

## 5.10.0

### Minor Changes

- 702899a: Catalog-tracked updates: `app_install {catalogUrl}` records `source.catalogId`; the new `app_updates` tool reports catalog entries newer than the installed app (different digest/commit, version not lower); `app_resync` on a catalog-tracked app installs its catalog's current entry from the entry's own URL, verified against its digest; `app_catalog` marks such entries `updateAvailable`.
- 9455c0e: App catalog v1: remote catalogs follow the `app-catalog/v1` format (optional `version`, `tier`, `icon`, `publisher`, `license`, `requires`, `minAgentprotoVersion`, `featured`, bundle `size`); `app_catalog` always queries a default public catalog (config `catalog.defaultSource`, `false` to turn it off) to which `catalog.sources` are added; each source's last good copy is cached under `~/.agentproto/cache/catalog` and served `stale` when the source fails, with an embedded first-party list as the default catalog's offline fallback. Remote entries now report `origin` and `catalogUrl`.
- 530c3ec: App runtime output moves out of the app's code dir: `ui.build` logs are written to `~/.agentproto/logs/app-ui-build/<app>-<hash>.log` (honors `AGENTPROTO_HOME`) instead of `<appDir>/.agentproto/ui-build.log`, and apps installed from a git URL or `.agentapp` default their `dataDir` to `~/.agentproto/app-data/<appId>` instead of `<appDir>/data`. Existing installs keep their recorded `dataDir`.
- c72bbd4: Apps can call each other. `requires.apps` entries may now be objects
  (`{ id, version?, workflows? }`) next to bare ids, and `exposes.workflows`
  declares which workflows an app lets other apps run. A new `app_call` MCP verb
  runs an exposed workflow on behalf of an installed consumer app, checking the
  declared dependency, the workflow allowlist, the provider's exposed workflows
  and its installed version range, and returns the workflow's output with a
  distinct error code per refusal. `app_apply` also refuses an app whose declared
  dependency version range is not satisfied. The daemon is local-trust:
  `callerAppId` is a declaration check, not an authentication boundary.
- 9391218: Restart ended-but-resumable agent-cli sessions in place on the same id. An inbound message (a human writing to the session) also revives a deliberately-ended session (operator-completed / steward-*) in place; the sentinel, as an automatic path, still never does.
- 5983ec5: Record real cron run outcomes and auto-pause unhealthy jobs
- f4ac811: The daemon's default self-mount `deferredTools` now depends on the harness: an adapter declaring the new manifest capability `nativeToolSearch` (claude-code, which defers MCP tools behind its own `ToolSearch`) gets the eager `/mcp` surface instead of a second deferral layer. Precedence: `agent_start.deferredTools` > `?deferred=` > native tool search ⇒ eager > role default > `defaults.mcp.deferredTools`. No tool is removed.
- 2049adb: Bound the session-steward's apply by session origin: a pure origin policy (`origin-policy.mjs`) classifies each candidate as user-origin (chat-starter, vscode, or a root with no origin and no parent — flag-only, never closed) or closable (cron:*, gate, executors), configured by new `userOrigins` / `closableOrigins` workflow inputs. `SessionWrapupEntry` carries `origin` / `parentSessionId` through, and the steward report gains an `origin` column with the retained action.
- 2346c07: Stable, manually reorderable pinned order. Pinned sessions now carry a daemon-persisted `pinnedOrder`: new pins append at the end and a new message or update never reorders them. `POST /sessions/pinned/order` and the `session_reorder_pinned` MCP verb (subtree-scoped) set the order, emitting `session:pinned-reordered`; `agentproto sessions` sorts the pinned group by it. Legacy pins without an order sort after ordered ones, oldest first.
- 58d5a41: Surface silent provider stream errors as turn errors. `@agentproto/driver-agent-cli` adds a stderr logfmt parser (`parseStderrStreamError`, `_onStderrLine` push subscription) so opencode's silent 429/usage-cap retry loop surfaces as a turn error instead of a hung session, and the opencode adapter spawns with `--print-logs --log-level ERROR`. `@agentproto/runtime` exports `NO_OUTPUT_STALL_TURN_ERROR` (new export ⇒ minor) and attaches it via the stall watchdog for zero-output turns. `@agentproto/apps` (session-steward) gains the `session-steward` skill, a session snapshot script, and APP.md skill wiring.
- 2049adb: Bound the session-steward's apply by session origin: a pure origin policy (`origin-policy.mjs`) classifies each candidate as user-origin (chat-starter, vscode, or a root with no origin and no parent — flag-only, never closed) or closable (cron:*, gate, executors), configured by new `userOrigins` / `closableOrigins` workflow inputs. `SessionWrapupEntry` carries `origin` / `parentSessionId` through, and the steward report gains an `origin` column with the retained action.
- 5cd6c9b: Verify expected sha on app_install and gate remote ui.build behind allowBuild
- be03ed4: Add sessions checkpoint/handoff HTTP routes and CLI verbs
- 7ff4ece: Agent review lanes retry once in a fresh reviewer session on transient reviewer errors (configurable via `review.laneRetries`, `0` disables; credential, quota and unknown-model errors are never retried) and report the adapter's own error text. The daemon reviewer host also fails closed on OpenRouter: a lane whose preset, model or auth profile resolves to OpenRouter is refused with a pointer to opencode-go / Claude-subscription presets.
- 7ff4ece: Retry agent review lanes on transient reviewer errors (review.laneRetries)
- ed6c48b: Don't hard-stop a session on a self-contradictory usage frame
- ef89993: Session steward: port the `kill-idle-sessions` cron prototype's mechanical
  rules into pure, unit-tested functions wired into the workflow — loop
  detection, stall, never-ran, fast-path done, terminal relabel, self-exclusion,
  apply-time re-check, explicit 0-candidate reporting, host-saturation header,
  and verdict memory in `app_state` — and enrich `session_evidence` (origin,
  outcome, tool stats, last tool call, tokens, live children, previous verdict)
  with a rewritten concrete-signal wrap-up verdict criteria. Loop/stall nudges
  are reported only, never sent; user-origin sessions are never nudged or closed.
- 42de70d: `agent_prompt` (and `POST /sessions/:id/prompt?wait=false`) to a mid-turn session no longer just queues until turn end. When the adapter supports steering (`capabilities.steering`, e.g. claude-code over ACP), the prompt is injected into the running turn at the next safe point (FIFO kept; `interrupt: true` unchanged; `steer: false` opts out). The result now says exactly what happened: `delivery` (`delivered` | `steered` | `queued-mid-turn`), `deliveredAt` when known, and a top-level `pending` boolean (`true` = not yet delivered); `queued: true` and `queueId` stay for compatibility. A prompt that stays queued shows up as `pendingPrompts` (id, origin, preview, `ageMs`, `stale`) in `session_list` and `session_recap`, and once it is older than `defaults.messaging.pendingPromptStaleMinutes` (new, hot, default 5) a one-shot `notice` lands in the sender's inbox (else the target's parent). New `deliverWithin` (seconds) + `deliverWithinVia` (`auto` | `steer` | `interrupt`) on `agent_prompt` make the daemon steer or interrupt a still-queued prompt after a timeout.
- 15d4c6f: feat(runtime): context checkpoints now carry real content instead of "(… captured in recent digest)" placeholders. `goal` is the session's initial prompt; `tests` comes from the last completion-policy gate (new `lastGate.command`) or the last test-like tool call; `nextStep` from the session's open tasks or last agent message; `errors` from the last `[error]`; `plan` from the last plan notice. `decisions`, `risks` and a better `nextStep` come from an optional handoff turn to the live idle source session (zod-validated JSON, 60s timeout, falls back to extraction; `askSource: false` disables it). `session_checkpoint` and `session_continue_fresh` accept `notes` and `askSource`. Checkpoints gain `schemaVersion: 1`, a `handoffTurn` status, and a published JSON Schema at `@agentproto/runtime/schemas/checkpoint.v1.json`.
- 41917fd: feat(review): per-lane reviewer fallback. An agent check may declare `fallbackPresets: [...]` (also on a `uses[]` entry and in `uses[].overrides.<id>`); when the lane's reviewer is unavailable — spawn failure, a turn that ends in an error, an empty turn, or a session that exits early, after the per-preset retries — the lane runs on the next preset instead of settling `skipped`. Never after a verdict (a `block` is final), a timeout, a cancel, or an OpenRouter refusal; the chain shares the lane's single `timeoutMs`. The lane records the reviewer that actually ran (`preset`/`model`/`sessionId`) plus `fallbacks: [{ preset, error }]` for each unavailable one, shown in `agentproto review` output and the review panel; an exhausted chain settles the lane `skipped` listing every error.
- c8d918f: feat(sentinel): `local-gh` can watch a whole repository. A sentinel on the bare subject `github:owner/repo` (`until: never`, e.g. `POST /sentinels {subject, sessionId, provider:"local-gh", until:"never"}` or `sentinel_watch`) delivers, for EVERY PR of the repo and without any LLM polling: `pull_request.opened`, `pull_request.ready_for_review`, one CI verdict per head (`check_suite.completed`, on the first failure or once all checks settle), reviews, and merge/close. One GraphQL call per repo per tick; the first poll only records existing PRs. This gives a supervisor session a second subscription on PRs whose author session is the only target of the per-PR auto-watch.
- 7677a5c: Session-follow: a session can now follow other sessions it did not spawn and be woken when they end a turn, await input, exit, crash, or get a PR opened/merged. New `session_follow` / `session_unfollow` / `session_follows` MCP tools and `POST|GET /follows`, `DELETE /follows/:idOrKey` routes; follows persist in `~/.agentproto/follows.json`. Events are coalesced per follower (`batchMs`, default 15s) into one `system`/`notice`/`next-turn` digest that never interrupts a busy follower.
- be03ed4: Suggest a cross-harness handoff at the context or quota limit: `ask`-mode context questions gain `handoff:<harness>` options, a provider usage-limit error and the new `contextContinuity.handoffAtQuotaRemaining` threshold emit a `session:handoff-suggested` event with the `agentproto sessions handoff` command. Suggestions never switch harness on their own.
- 953ce06: `agent_start` (and `POST /sessions/agent`) accepts an optional `notifySecret` (`whsec_...`) alongside `notifyUrl`: when set, every session-event webhook POST (turn-end/awaiting-input/exited) is signed with Standard Webhooks headers (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256), reusing the existing `webhook-egress/signing.ts` contract. The global notify target (`~/.agentproto/notify.json` or `AGENTPROTO_NOTIFY_URL`) gains a matching optional `secret` field / `AGENTPROTO_NOTIFY_SECRET` env var. A target with no secret is posted exactly as before — unauthenticated, `Content-Type` only — so every existing caller sees zero behavior change.

### Patch Changes

- 7d5a6c6: A prompt delivered by interrupting the in-flight turn (`session_queue_deliver` deliver-now, or `agent_prompt`/`sendPrompt` with `interrupt: true`) now opens with a one-line `[agentproto]` notice telling the model its previous turn was cut to deliver this message (naming the origin) and that it is NOT a stop request. Previously the model saw only a cancelled turn followed by a new prompt — indistinguishable from a human Esc — and a supervisor could park itself waiting for a go-ahead. A bare stop (`agent_interrupt`) adds no notice. The events-log `notice` is unchanged.
- d7986c9: Stop answering `server/discover` with the unserved 2026-07-28 protocol version. Claude Code 2.1.280 switched to the "modern" era on it, got an invalid `tools/list` and mounted 0 tools; the SDK now answers `-32601` so clients stay on 2025-11-25. `events/*` methods and the `events` capability at `initialize` are unchanged.

  `agent_start` docs: a `mcpServers` descriptor does not guarantee the child loaded any tools.

- cf17fd2: Tell the model a deliver-now interrupt is a delivery, not a stop
- 5787677: Declare own-login auth for copilot-cli, antigravity, mastracode-inprocess
- ef4523f: Review lanes fail closed on OpenRouter: the daemon reviewer host now refuses to spawn a lane whose preset, model, or auth profile (billing endpoint) resolves to OpenRouter, returning a failed review with a message pointing at opencode-go / Claude-subscription presets instead of silently spending pay-per-token credit.
- 603aad9: fix(sentinel): `local-gh` now emits the terminal `pull_request.closed` event for a PR that was already merged/closed on its baseline poll (sentinel created after the close, or the PR closed before the first tick). Previously no open-to-closed transition was ever observed, so `until: subject_terminal` sentinels stayed `active` forever; existing stuck sentinels heal on their next poll.
- 9c7f686: Bring the always-on MCP `tools/list` back under its 60 KB budget: `agent_start`'s `notifySecret` field is now a one-line description pointing at `tool_help {name:"agent_start", topic:"notifySecret"}` (full text moved to the help doc), and `agent_prompt`'s description is tightened without changing its contract.
- 205bade: `agentproto steward` goes back to the end-of-session wrap-up as its default:
  judge idle agent sessions, then close or flag them (dry run unless `--apply`).
  The attention-digest workflow (`session-attention`) and its `--wrapup` /
  `--include-children` / `--format` flags are removed from the open-source
  steward; the open-source steward keeps the minimal idle / done / errored policy
  with explicit close.
- Updated dependencies [1487de1]
- Updated dependencies [c72bbd4]
- Updated dependencies [0dd095d]
- Updated dependencies [d7986c9]
- Updated dependencies [f4ac811]
- Updated dependencies [2049adb]
- Updated dependencies [58d5a41]
- Updated dependencies [2049adb]
- Updated dependencies [530c3ec]
- Updated dependencies [38b5538]
- Updated dependencies [5787677]
- Updated dependencies [ef89993]
- Updated dependencies [41917fd]
- Updated dependencies [205bade]
  - @agentproto/app-kit@1.6.0
  - @agentproto/pairing-host@0.2.4
  - @agentproto/mcp-server@0.6.1
  - @agentproto/driver-agent-cli@2.8.0
  - @agentproto/apps@0.19.0
  - @agentproto/secrets@1.3.0
  - @agentproto/review@0.5.0
  - @agentproto/acp@0.10.0
  - @agentproto/sandbox@0.8.2

## 5.9.0

### Minor Changes

- a75032a: Add per-session index sidecar and `sessions find`/`recap` commands
- c2472bf: Add session_mark_completed tool to close a session with a verdict
- 22f58a7: Expose `origin` on the compact `session_list` rows and `wrapupFlag` on the session summary. Both are already on the session descriptor; surfacing them in the summary/compact projections lets UIs (session tree grouping, session-steward) read them without opting into `full: true`.
- a8d3495: Add MCP Events adapter and native events/* JSON-RPC transport

### Patch Changes

- 20dd08f: Session-index follow-up fixes that missed the #1665 squash: capText slices by code point (no lone-surrogate split at the 500/300 boundary), backfilled `startedAt` uses the transcript's birthtime, and `sessions find --limit` is capped at 200 to match the MCP surface.
- 3959962: fix(runtime): detect a dead ACP connection instead of reporting it alive — a
  second, independent liveness axis (`adapterConnected`) so a row whose ACP
  transport died is no longer reported as running/Idle forever.
- 1a2ca41: Retry tmp-dir cleanup in session tests to deflake ENOTEMPTY
- 16a3b8f: Base catalog_models eligibleProfiles on the queried adapter's auth
- a8d3495: fix(webhook-egress): `ssrfFetch` now defaults the HTTP `Host` header to the original hostname (with `:port` on non-default ports) instead of letting the socket derive it from the connect IP, and the test seam receives the same final wire headers. Prevents name-based vhosts (e.g. CF edge / cloudflared) from answering a literal-IP `Host` with 403/421, which mis-categorised subscribers as `non_2xx` instead of `challenge_failed`. Explicit caller `Host` headers are preserved verbatim.
- 6ccad21: docs: sentinel webhook target, MCP Events integration + test checklist
- Updated dependencies [3959962]
- Updated dependencies [a8d3495]
  - @agentproto/acp@0.10.0
  - @agentproto/mcp-server@0.6.0
  - @agentproto/driver-agent-cli@2.7.1
  - @agentproto/pairing-host@0.2.3

## 5.8.0

### Minor Changes

- a878968: OpenAI MCP-extensions carriage (W-B): `AgnoMcpApp` gains an optional namespaced
  `openai` descriptor (§3.2 tool/resource metadata + icons); `performInstall`
  carries the app-kit-normalized `ui.extensions.openai` through `InstalledApp.ui`
  structurally; `registerMcpApps` serializes the declared entrypoints and icons
  under the generated UI tool's `_meta["openai/ui"]` and the display
  available/preferred modes under the `ui://` resource's `_meta["openai/ui"]`;
  `registerUiResource` accepts extra namespaced `meta` refused for the canonical
  `ui` key. Apps without `ui.extensions.openai` install and serve byte-identically.
- a878968: PR provenance reconciler: a third, TEXTUAL attribution lane — at each executor
  session's turn-end/exit, PR urls printed in the session's own ASSISTANT output
  (bounded transcript-tail read, same window `session_evidence` uses) are
  recorded on `SessionDescriptor.openedPrs` with adapter `"output-scan"` when no
  other lane already carried them. A mention never stamps a footer or opens a
  sentinel footgun by itself: dedupe is per-url (in-memory for the run,
  `openedPrs` across restarts), and the lane is in-process with zero network —
  it reads the session's existing events.jsonl tail only.
- d0be488: List installed adapters in the generic adapter_not_found error

### Patch Changes

- 0b76d49: fix(device-spawn): retry a flapping host channel once, and surface the host's
  first-turn failure. Two device-spawn UX defects from cross-device field
  dogfood (Mac Studio → Windows 11 / Mac Pro hosts):

  - **Silent spawn hang.** A `device:<fp>` spawn whose E2E channel to the host
    was flapping failed with a transport-class error and surfaced as a bare MCP
    `Request timed out` — no retry, no actionable message. The inner
    `agent_start` over the host channel is now wrapped in ONE automatic retry
    with a ~2s back-off on transport-class failures (`device_unreachable`,
    `transport closed`, `handshake timed out`, `ECONNRESET`, …); on a spent
    budget it returns `device_spawn_unreachable` (HTTP 400) naming the target,
    the attempts, and the guidance to retry / run `agentproto devices status`.
    Non-transport failures (the host's own `adapter_not_found`, a bad model id)
    still fail immediately, and local/e2b/Box spawns are unchanged.
  - **Silent empty turns on a bad model id.** A device spawn whose model id did
    not resolve on the host completed its first turn EMPTY, leaving a
    healthy-looking `running` session while the adapter's real
    "model not found"/"invalid model" line sat only in the host's ring buffer.
    The sandbox proxy now surfaces that raw host line as a `notice` on a
    failed/empty FIRST turn (rendered into `agent_output`), and the descriptor
    is stamped `firstTurnFailed: true`.

- 2d4457e: Send a device spawn's first prompt inside agent_start, in one dial

  `StartAgentArgs.prompt` now accepts a content block / block array (not just a
  string), exposing the inner `agent_start` schema's existing verbatim-prompt
  capability to harness callers; the device-sandbox bridge uses it to carry the
  controller-composed prompt in the spawn dial.

- Updated dependencies [a878968]
- Updated dependencies [a878968]
  - @agentproto/apps@0.18.0
  - @agentproto/mcp-server@0.5.0
  - @agentproto/driver-agent-cli@2.7.0
  - @agentproto/sandbox@0.8.1

## 5.7.0

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

- 662ce60: Add webhook-egress primitives + sentinel webhook target/outbox (signing, SSRF gate, challenge verify, bounded-retry delivery, persisted dispatch/resume)
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

- 399fd2a: Device spawn must name where to land: an `agent_start({ sandbox: "device:<fp>" })` with neither `cwd` nor `workspaceSlug` now fails 4xx with `device_spawn_requires_repo_identity` (issue #1647 field report — it used to silently land in the target daemon's active workspace, wrong files/wrong AGENTS.md). An explicit `workspaceSlug` on a device spawn is forwarded over the bridge (marked `deviceBridge: true`) so the TARGET daemon resolves it against its own registry: there it fails 4xx with `device_bridge_workspace_unknown` naming the slug and the target's known slugs instead of falling back to the active workspace. Local spawn semantics are unchanged. `adapter_not_found` for a route-like slug (e.g. `opencode-go`) is now actionable — it names the corrective `adapter`/`model`/`route` usage. `StartAgentArgs` gains the internal `deviceBridge` bridge marker.
- Updated dependencies [f6b1555]
- Updated dependencies [f6b1555]
- Updated dependencies [85051ab]
  - @agentproto/sandbox@0.8.0
  - @agentproto/driver-agent-cli@2.6.4

## 5.6.0

### Minor Changes

- 76876bc: Add webhook-egress primitives: signing, SSRF-guarded POST, challenges

### Patch Changes

- 11c1e09: Controller→host-session prompt path + E2E channel flap diagnostics (BOOTSTRAP P4)

  - `runtime`: `device_prompt` MCP tool + `POST /devices/:id/sessions/:sessionId/prompt` —
    write a turn to a session on a registered HOST device (the write counterpart of
    `device_sessions`), forwarded over the host's E2E channel with `agent_prompt`'s
    queueing rules (fire-and-forget default, FIFO behind an in-flight turn,
    `interrupt`/`force`; `wait` blocks until the turn drains). The host side serves
    `POST /device-prompt/:sessionId`, self-proxying onto its own
    `POST /sessions/:id/prompt`, gated by the same two gates as `/device-spawn/*`
    (host-scoped pairing + `features.deviceSpawnAllow` — a plain remote-control
    pairing never gets it). CLI: `agentproto devices prompt <fp|name> --session <id>
--prompt <text> [--wait]`.
  - `runtime`: post-handshake E2E diagnostics in `HostRegistry.connectToHost` —
    each failed attempt logs the host name/fingerprint, attempt number, and the step
    it died at; a host that closes AFTER completing the Noise handshake now fails
    immediately with the remote close reason instead of masking it behind a 10s
    tunnel-hello timeout (the step the observed flaps break at), and the re-pair
    hint now also fires on a hello timeout.
  - `pairing-host`: the daemon's pairing accept-loop no longer swallows handshake
    failures silently — the gated log names the step (`transport closed during
handshake: <reason>` vs a hello timeout), and the channel-closed log carries the
    remote close reason.
  - `acp`: `daemonHandshakeOverSink` takes an optional `log` hook that surfaces the
    remote's POST-REPLY close reason — the exact step the observed E2E flaps break
    at (Noise OK, reply sent, controller hangs up). Wired into the pairing accept
    loop (gated, labelled with the loop key) and the join-token accept loop; the
    reason was previously captured at this layer and discarded.

- 8e00a1a: Suppress controller-side AGENTS.md/RULES.md composition on device-sandbox spawn
- Updated dependencies [11c1e09]
- Updated dependencies [eb3d4d5]
  - @agentproto/pairing-host@0.2.2
  - @agentproto/acp@0.9.2
  - @agentproto/app-kit@1.5.0
  - @agentproto/driver-agent-cli@2.6.3
  - @agentproto/apps@0.17.2

## 5.5.0

### Minor Changes

- a4f3130: Add cron job updates and paginated, durable run history

### Patch Changes

- 6bace2a: win32 field fixes (BOOTSTRAP P3, reproduced 2026-09-30 on Windows 11 / Node 26.10.0)

  - `driver-agent-cli`: `resolveWindowsBatchSpawn` now probes for the npm shim's real
    node entry with the actual filesystem when called without injected deps. The
    shipped dist evaluated a placeholder `() => false`, so the stage-1 rewrite never
    returned and every `bin: "npx"` spawn fell to `shell: true` — where cmd.exe
    mangled the quoted `C:\Program Files\nodejs\...` path, every `agent_start`
    failed with "ACP connection closed", the VS Code terminal with "pty failed to
    spawn", and chat with HTTP 500. Regression-tested against a real fs fixture
    under a path containing a space.
  - `cli`: the scheduled-task launcher `~/.agentproto/agentproto-daemon.cmd` now
    starts with `cd /d` to the configured `daemon.workspace` (otherwise
    `%USERPROFILE%`). The task used to run from `C:\Windows\System32`, where the
    daemon died EPERM creating `.agentproto/runtime.json`. `agentproto daemon stop`
    no longer trusts `schtasks /End` alone: it probes `/health`, and when the port
    still answers kills the recorded PID tree (`taskkill /PID <pid> /T /F`) and
    re-probes — the node child used to keep listening, so a later `start` reused a
    zombie daemon and new code never loaded.
  - `runtime`: after 5 consecutive failed host dials the controller logs the
    one-line remediation "host handshake failing — the controller should re-run
    `agentproto devices add` with a fresh `pair offer --host`" (classically: a
    Windows reboot invalidated the old host registration and nothing in the log
    pointed at the fix). `agentproto doctor`'s devices check flags a host whose
    channel is failing its handshake recently and prints the same hint. No
    pairing-protocol change.

- Updated dependencies [6bace2a]
  - @agentproto/driver-agent-cli@2.6.2

## 5.4.1

### Patch Changes

- 91d29b3: Windows P1 onboarding fixes (recap D7/E9/B4): the auth key store grows a Windows backend (one DPAPI-protected file per slot under `~/.agentproto/keychain-dpapi/`, .NET `ProtectedData` at `CurrentUser` scope via PowerShell — zero npm deps); `agentproto setup`/doctor gains a "Connect machines" step that prints the exact pairing commands for the chosen direction (pilot vs be piloted), and `/health` now reports the daemon's start-time PATH so the doctor's agents step can diagnose "installed in your shell but not visible to the daemon" with a `agentproto daemon restart` hint; the "no host matched" device error carries a pairing-direction hint.
- Updated dependencies [91d29b3]
  - @agentproto/auth@1.1.2
  - @agentproto/llm-endpoint@0.11.3
  - @agentproto/secrets@1.2.1
  - @agentproto/acp@0.9.1
  - @agentproto/pairing-host@0.2.1
  - @agentproto/sandbox@0.7.4

## 5.4.0

### Minor Changes

- 5b6f5d7: Add a `jev` config section (`jev.apiKey`, `jev.model`, `jev.baseUrl`) to `~/.agentproto/config.json`. `resolveJevApiKey` reads `jev.apiKey` before the `JEV_API_KEY` env var, giving agentproto's first-party judge secret a home in its own config instead of a workspace env file.
- 5b6f5d7: Add a `jev` config section to the runtime. `jev.apiKey` becomes the primary source for the Jev judge API key (falling back to `JEV_API_KEY` and the host secret resolver), and new `jev.model` / `jev.baseUrl` entries let users pick the judge model and endpoint override; both flow into the session steward's Jev judge tool via the new exported `resolveJevConfig()`.

### Patch Changes

- Updated dependencies [3d9626a]
- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
- Updated dependencies [c0101dd]
  - @agentproto/driver-agent-cli@2.6.1
  - @agentproto/driver-browser@0.2.0
  - @agentproto/pairing-host@0.2.0
  - @agentproto/adapter-browser@0.3.0
  - @agentproto/driver@0.3.0
  - @agentproto/secrets@1.2.0
  - @agentproto/workflow-runtime@0.16.0
  - @agentproto/tool@0.4.0
  - @agentproto/apps@0.17.1
  - @agentproto/plugin-local-browser@0.3.2
  - @agentproto/app-kit@1.4.1
  - @agentproto/driver-http@0.1.10
  - @agentproto/governance-engine@0.1.10
  - @agentproto/mcp-server@0.4.2
  - @agentproto/acp@0.9.1
  - @agentproto/sandbox@0.7.3
  - @agentproto/review@0.4.0
  - @agentproto/eval-reporters@0.2.20
  - @agentproto/telemetry-langfuse@0.2.18
  - @agentproto/workspace-brain@0.4.10

## 5.3.0

### Minor Changes

- 003d217: Add A2A 1.0 task ingress: `POST /a2a/apps/:appId` speaks JSON-RPC 2.0 (`SendMessage`, `GetTask`, `CancelTask`) with 1.0 shapes (flat parts, `ROLE_*` roles, `TASK_STATE_*` states, `{task}` response wrapper) and `A2A-Version` / `?version=` negotiation (defaults to `1.0` when neither is sent; an explicit unsupported version such as `0.3` gets `-32009`). `SendMessage` starts an `app_run` for an agent the app lists under `exposes.agents` and requires `accepts.tasks: true` in the manifest (otherwise error `-32004`); the task id is the app run id, task state is derived from the run, and `GetTask` returns the app's artifact once the run completes. The app id in the path may be URL-encoded or literal-slash. Created tasks are recorded in an append-only ledger at `<stateDir>/a2a-tasks/<appId>.jsonl`.
- e0e7f09: Add the `agentpush` sentinel provider (AIP-60 step 10). A sentinel can now be backed by a hosted agentpush subscription (`POST /subscriptions`, `consumerRef = agentproto:sentinel:<id>`): events queue server-side and survive daemon downtime. Delivery is by poll (default, no public URL; the seq cursor is persisted in the sentinel store and acked only after the batch is delivered, so a restart resumes without loss or redelivery) or, opt-in with `delivery: push` and a public https daemon URL, by push through the sentinel inbound route, verified with agentpush signature v2 (`X-Agentpush-Timestamp` + `v2=HMAC(ts.body)`, 5-minute skew) or the legacy `sha256=` header. The workspace API key comes from `setup_sentinel_provider` (stored 0600, never returned) or an imported `agentpush` MCP alias; `list_sentinel_adapters` reports `agentpush` ready or not ready with the reason. Provider auto-selection is now `agentpush` (when set up) > `webhook` (stable public URL and ready) > `local-gh`, shared by `sentinel_watch`, `POST /sentinels` and the PR auto-linker (which retries once on `local-gh` if the preferred provider fails). The `webhook` provider's attach now verifies the repo hook on boot and recreates it on a 404. PR auto-watch is now considered available when either `local-gh` (`gh` authenticated) or `agentpush` (API key set) is usable.
- d9cd5d7: Install apps from a git URL or a `.agentapp` and keep them in sync. `@agentproto/app-kit` now exports the AIP-53 bundle core (`packApp`, `unpackApp`, `aggregateSha256`, `collectFiles`, `isManifest`, `AgentAppPackError`), lifted out of the CLI with no behaviour change (unpack additionally refuses a manifest listing paths outside the bundle root). The runtime's `app_install` accepts exactly one of `{dir}`, `{url, ref?, subdir?}` (shallow git clone) or `{url}`/`{file}` for a `.agentapp`, installs remote sources under `<state dir>/apps/<slug>` with an atomic swap that keeps the data dir and survives a failed install, and records `InstalledApp.source` (`local` / `git` sha / `agentapp` sha256+version), surfaced by `app_list` and `app_status`. New `app_resync {appId}` compares the source (`git ls-remote` / re-downloaded bundle digest) and reinstalls when it changed. The CLI gains `agentproto app install <dir|url|file.agentapp> [--ref] [--subdir]` (URL/bundle installs are executed by the daemon) and `agentproto app resync <appId>`; `app pack`/`unpack` are now thin wrappers over app-kit.
- c86b801: The daemon, the `POST /sessions/browser` route and the CLI now resolve browser adapters through one shared table, `defaultBrowserAdapterResolution()`, backed by the `@agentproto/adapter-browser` facade (`camofox`, `bureau`, `chromium`). The "Available adapters" hints derive from that table instead of hardcoded copies. `start_browser`, `stop_browser`, `list_browsers`, `browser_status`, `browser_adapter_list`, `POST /sessions/browser` and every `agentproto browser` / `agentproto serve` flag keep their request and response shapes.

  New `projectBrowserTools(instance, { provider })` in `@agentproto/runtime` projects a `@agentproto/driver-browser` `BrowserInstance` onto the page-level MCP tools (`browser_navigate`, `browser_evaluate`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_get_dom`, `browser_list_requests`, `browser_get_request_body`, `browser_cdp_send`). A tool whose capability the provider lacks answers with a typed `browser:unsupported` result naming the capability (for example `cdp` for `browser_list_requests`), before any driver is attached.

- b31de6f: Cron jobs with an unresolvable agent adapter now fail at create time instead of silently failing at fire time. `CronScheduler.create()` is now async: for `kind:"agent"` (and `kind:"tool"` → `agent_start`, what a routine's `target.agent` lowers to) with an explicit `adapter`/`harness` and no `sandbox`, it resolves the adapter and refuses the job if it doesn't resolve. When the slug is an auth profile id, the error explains to use a real adapter with `access.profileRef`; otherwise it lists installed adapters. Jobs rehydrated from disk are not re-checked. `RoutineRegistrar.reconcile()` is now async and reports a refused routine in `errors` without aborting the rest of the pass. `agent_start`'s `adapter_not_found` error uses the same shared hint (`adapter-slug-hint.ts`) when the slug is an auth-profile id, instead of advising `agentproto install <profile-id>`. The compact `cron_list` projection now includes `lastOk` so a failed last run is visible without `full: true`.
- 2977214: feat(host): host-level load report. New `agentproto host load [--full] [--json] [--watch <s>] [--budget <ms>]` prints loadavg vs core count, CPU user/sys/idle, RAM (used/wired/compressor/free) and swap, per-disk transfers/s and MB/s, and the top 10 processes by CPU and by memory footprint (compressed pages included), each tagged with its owning session or `orphan`/`system`, plus a WARNINGS section: swap above 50%, old busy or serving orphans (ppid 1), deleted-cwd processes, filesystem-wide `find`/`bfs`/`du` scans, duplicate servers on one port, load above 4x cores. The same JSON is served by `GET /host/load` and the `host_load` MCP tool (`detail: "summary" | "full"`). macOS uses `vm_stat`, `sysctl`, `iostat`, `top`, `ps`, `lsof`; Linux reads `/proc`; no sudo. Every probe runs under a timeout so the call stays around 2 s on a saturated host, and a slow probe is named in `partial`. The collector (`getHostLoadService`, `createHostLoadService`, `collectHostSample`) is exported from `@agentproto/runtime` for schedulers that gate heavy jobs on host load.
- 7130165: Imported MCPs link to their source and keep secrets out of `imported-mcps.json` (P1). Entries gain additive optional fields (`origin`, `resolve: "live" | "snapshot"`, `secretRefs`); the file stays `version: 1`. A single `resolveImportConnection` chokepoint (shared by the proxy and the MCP-Apps host) resolves `live` entries against discovery (exact id, else same source+scope url/command+args match; missing source falls back to the snapshot and reports `stale`) and resolves `secretRefs` from the OS keychain into the same header/env key, dropping rather than leaking bound secrets when a live source re-points to a different upstream. On import (`mcp_import`, `POST /mcps/imports`) literal header/env values are stored via `storeMcpSecret` and replaced by refs (literal + warning when no store). `McpProxyRegistry` reconnects when a live source file's mtime changes; `stale`/`resolve`/secret key names surface in `mcp_imported_status`, `capabilities_inventory` and `/mcps/proxy/status`.

  New `agentproto mcp migrate-secrets [--apply]` (dry-run default) migrates existing literal-secret entries to secret refs.

  New `agentproto mcp mount-default <adapter> <importId...>` (P2) lets an adapter natively mount imported MCPs via a managed `harness-<adapter>` bundle, so the adapter spawns with those MCPs mounted by default instead of proxied.

  `capabilities_inventory` now reports `alsoNativeIn` (P3): other harness configs that already natively mount the same upstream, identified by normalized url/stdio matching (absolute-path args stripped) with no upstream url/header material leaking into the report.

  Settings bundles export secret key names only and report dangling secrets on apply.

- 428f72f: Joined CI hosts now report real liveness and are cleaned up. Every successful contact bumps `lastSeen` (persisted throttled) and `online` covers an active channel or a contact within the 2 min grace; joined hosts are probed in the background with bounded concurrency and exponential backoff (never giving up), resumed after a daemon restart, and record `lastProbeAt`/`lastError`. A joined host unreachable past a TTL (default 2 h, `AGENTPROTO_HOST_ENDED_TTL_MS`) or that says goodbye is marked `ended` and hidden from `device_list` / `GET /devices` / `devices list` unless `includeEnded` / `--include-ended`; ended hosts are deleted after a retention (default 7 d, `AGENTPROTO_HOST_ENDED_RETENTION_MS`). Manually added hosts and client devices are never ended or deleted (a manual host past the TTL only shows `stale`). The sweep runs every 60 s in `agentproto serve`.
- b63c311: Model roles: one config for which model the reviewers and judges use. The daemon config gains a `models` map (role → model id, or `{ model, route?, profile? }`), resolved as explicit input > repo `agentproto.json` `models` > daemon config `models` > built-in default (`DEFAULT_MODEL_ROLES`: `review.small`, `review.large`, `review.pr`, `judge.session`). `config_set models.<role>` warns (does not block) on a model id the catalog does not know, `config_get` lists the roles, and the new read-only `model_roles` tool reports each role's resolved model and source. An AGENT.md `model: role:<name>` is resolved before adapter selection and `app_run` spawn. The repo-maintenance `maintain` workflow (`reviewModelSmall`/`reviewModelLarge`) and the session-steward (`judgeModel`) now default to their roles instead of hard-coded ids; explicit inputs still win.
- 7a5c2d1: Add AIP-7-backed human approvals engine with task-board integration
- 3cf99c3: **@agentproto/runtime:** Adds the `webhook` push sentinel provider (AIP-60 §5): one refcounted GitHub repo hook per repo pointing at `POST /inbound/sentinel-<hookKey>`, HMAC-gated and delivered through a new `SentinelRuntime.deliverPushed()` path that reuses the poll pipeline (seen-dedup, match, `until`). Also adds public-URL resolution (`AGENTPROTO_PUBLIC_URL` / stable-tunnel detection), an optional `readiness()` probe on `SentinelProviderHandle` surfaced by `list_sentinel_adapters`, a new exported `deliveryPreferenceFor()` helper, and provider auto-select in `createSentinelWatch` (push fields on `DeliveryPreference` are now optional).

  **@agentproto/cli:** Updates `sentinel watch` help text for the new `webhook` provider option and its auto-select default.

- 14e2494: Refactored branch_gc's background-job machinery into a shared `createBackgroundJobRegistry` (`background-jobs.ts`) and extended background mode + `*_status` polling to `worktree_gc` and `session_wrapup_plan`: new `worktree_gc_status` / `session_wrapup_status` tools, new optional `wait`/`waitMs` params on `worktree_gc` and `session_wrapup_plan`, and new `worktreeGcJobsDir`/`sessionWrapupJobsDir` runtime options (`@agentproto/runtime`).

  `removeWorktreeFast`'s cleanliness gate is now re-derived from git's real worktree-removal refusal rule (ignored files tolerated, untracked files refused even under `status.showUntrackedFiles=no`, locked worktrees refused), and trash deletion is serialized into a single detached deleter per pool: new exported `ensureTrashDeleter` / `WORKTREE_TRASH_PIDFILE`, new `spawnDeleter` options, and changed non-force removal-refusal semantics (`@agentproto/worktree`).

- a48ec1f: New `session-steward` built-in app: a workflow that classifies idle agent sessions, closes rule-certain ones, judges the ambiguous ones (Jev when `JEV_API_KEY` resolves, else a one-shot agent judge), and closes or flags only confident verdicts — a dry run by default. `@agentproto/cli` adds the `agentproto steward` command over it. `@agentproto/runtime` adds the read-only `session_evidence` and `session_judge_jev` MCP tools plus the exported `jev-client` and `session-evidence` modules behind them.
- af001c6: Merge remote catalog sources into app_catalog with caching, dedup, and warnings-on-failure
- 6a1bedc: App-spawned sessions (`app_run`, and workflow agent steps whose workflow carries an `appId`) now get filesystem zones: the installed app source is read-only, the run workspace and app `data/` dir are writable, everything else is denied. Enforced on the daemon's own file/command tools always; on the harness's native tools (claude-code) via `@agentproto/command-sandbox` zoned mode plus host `CLAUDE.md`/`AGENTS.md` exclusion when the adapter and OS sandbox support it. Apps opt into `boundaries: { enforce: "required" }` in `defineApp`/`APP.md` to refuse a spawn instead of silently downgrading when native enforcement isn't available.
- 439110f: `@agentproto/runtime`: new exports `projectBrowserTools` and `defaultBrowserAdapterResolution`/`defaultBrowserAdapterResolutionIds`, shared browser adapter resolution used by the CLI and MCP surface.

  `@agentproto/cli`: `serve.ts` now resolves browser adapters through `defaultBrowserAdapterResolution` instead of a local mapping.

- e00ee6d: feat(sessions): per-session process-tree resource stats. The daemon samples the host process table (ps, with a /proc fallback on Linux) and attributes RSS, %CPU, process count and top commands to each live session by descending from its adapter pid, with separate buckets for the daemon and for worktree provisioning work, and a report-only list of agentproto-looking orphan processes (never killed). New surfaces: `agentproto sessions --stats[=full] [--json]` (RAM-sorted table, totals row, host load and free memory), `GET /sessions/stats`, a `session_stats` MCP tool, and `stats: true | "full"` on `session_list` and `agent_sessions_list`.
- 78cd278: feat(worktree): throttle heavy worktree provisioning through a daemon-wide FIFO queue. `depsCmd`, `cloneGlobs` and setup hooks now run at most `worktrees.provisionConcurrency` (default 2, `0` = unlimited, env `AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY`) at a time, fair across callers, with optional per-repo caps and a `provisionLoadFactor` load guard. Killing a `starting` session drops its queued provisioning or terminates a running install's whole process tree and removes the half-made worktree. Sessions report `provisioning: { state, position, phase, startedAt }` in `agent_sessions_list`, `session_list` and `agentproto sessions`, and the event bus emits `session:provisioning` events.

### Patch Changes

- 3bab874: New `@agentproto/a2a` package: hand-written A2A (Agent2Agent, protocol 1.0) `AgentCard` types (`supportedInterfaces`, `securityRequirements`, oneof `SecurityScheme`) plus `buildAppAgentCard` / `buildDaemonAgentCard`. The runtime serves them at `GET /a2a/apps/:appId/.well-known/agent-card.json` (one card per installed app) and `GET /.well-known/agent-card.json` (daemon index aggregating every app that exposes something), behind the daemon's existing auth. Skills come only from an app's `exposes`; an app that declares none exposes nothing.
- 0329a22: Harden imported-MCP connections (P0). `imported-mcps.json` is now written mode 0600 by every writer (runtime `saveImportedMcps`, plugin-local-browser register/unregister). The daemon proxy expands `${VAR}` in upstream headers (parity with the apps-host pool). A 401/403/unauthorized/forbidden failure now drops the upstream client so the next call reconnects, in both `McpProxyRegistry` and `McpClientPool`. New shared `resolveImportConnection` (`mcp-import-resolve.ts`) feeds both the proxy and the apps-host resolver. `McpCredentialDeps` gains `resolveMcpSecret` / `storeMcpSecret` seams (wired to the keychain in `serve`, unused until a later phase).
- d13db8f: Joined CI hosts stay visible after they exit: the home daemon now snapshots a joined host's sessions plus an output tail on connect and every ~15s (5s while a session runs), and serves them `stale: true` with `capturedAt` once the host is gone. A joining daemon sends a goodbye on shutdown so the home side takes a final snapshot. `online` now reflects recent successful traffic (45s grace), `lastSeen` is bumped on every successful forward (persisted throttled), and the 7-day join TTL prune also covers pre-#1542 unlabeled fingerprint-named join hosts (never `pair offer` pairings or clients).
- 7130165: `capabilities_inventory.mcp.imported[].alsoNativeIn` (P3, report only): lists other discovered harness-config entries (`{ source, scope, name, sameName }`) that point at the same upstream as an import (url: query/trailing slash stripped, `localhost` = `127.0.0.1`; stdio: command basename + non-absolute args), so a double mount is visible. Identity fields only. Limitation: only host configs and registered workspaces are scanned. Nothing is rewritten.
- 51561f3: Model roles no longer default to Haiku: `review.small` and `judge.session` now default to `claude-sonnet-5-5`, and `review.large` (and the retry reviewer) to `claude-opus-5-5`. Override any role via `models` in `agentproto.json` / the daemon config as before.
- 7130165: Native imported-MCP mounts via default bundles (P2): `Bundle.mcpImports` may be `"*"` (expands to the current import set at spawn), the bundle expansion loop is extracted into the pure `mountImports`, `agentproto mcp mount-default <adapter> <importId…>` creates/extends bundle `harness-<adapter>` and links it into `defaults.adapters.<adapter>.bundles` (default stays empty), and `capabilities_inventory` reports per-import `reach` (`native` | `indirect` | `none`) per adapter. New `@agentproto/runtime/bundles` export.
- f058a9b: Extract the host-side pairing registry into a new `@agentproto/pairing-host` package so a non-daemon host can embed AIP-59 pairing without depending on the runtime. The package also ships a default `dialRendezvous`, `serveLoopbackHttp` (forward a paired channel to a local HTTP app with injected headers and an optional path allow-list), and an optional local-device credential (`mintLocalDevice` / `verifyDeviceBearer`, revocable like any pairing, stored as an optional `localDevices` field in `pairings.json`). `@agentproto/runtime` re-exports the registry unchanged and `@agentproto/cli` imports `dialRendezvous` from the package; daemon behaviour is identical.
- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).
- e9400e1: Algorithm-tag the review pack digest (agentproto-pack-digest/v1)
- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
- db1205c: Revived sessions record continuedFrom/continuedTo; sentinel stops waking deliberately-closed sessions
- 388555e: Report a cancelled run's stage as cancelled, not failed, when nothing in it actually failed
- 9a6da77: Read opencode's { output } tool-result shape in ring/artifact-ledger passthrough
- 9002043: `@agentproto/runtime`: the session list projections (`GET /sessions` summary and the compact `session_list` item) now carry `lastError` (capped at 2000 chars), so list views can show why an errored session died.

  `agentproto-vscode`: the sessions webview derives a short, readable failure cause from `lastError` (`failureCauseFor`), renders it error-styled with the full error as a row tooltip, and splits errored sessions into a dedicated "Failed" section — "Attention" now holds stalled sessions only.

- 6ffa227: Merge host snapshot captures so an empty session list never wipes prior history
- 7b442f7: Align @agentproto/review with AIP-62: add defineReview, generate the manifest, pack and attestation zod schemas from the spec's JSON schemas, and split git pack pins at the first '#' (the runtime pack loader used the last).
- 2973a57: repo-maintenance: the review agents (the maintain workflow's large-residual reviewer and the repo-maintenance reviewer agent) now default to `claude-sonnet-5-5` instead of `claude-sonnet-5`. Override per run with the workflow's `reviewModelLarge` input as before.

  @agentproto/runtime: test-only update asserting the new default review model id in the repo-maintenance workflow routing tests.

- e9f2a56: Approvals: readable approval card and human-readable error copy; `PATCH /tasks/:id` now forwards `approvalIds` and `artifacts`.
- 9002043: The session list projections (`GET /sessions` summary and the compact `session_list` item) now carry `lastError` (capped at 2000 chars), so list views can show why an errored session died.
- Updated dependencies [3bab874]
- Updated dependencies [d9cd5d7]
- Updated dependencies [dfeebb6]
- Updated dependencies [84f5782]
- Updated dependencies [f2678e0]
- Updated dependencies [439110f]
- Updated dependencies [a09c448]
- Updated dependencies [f2678e0]
- Updated dependencies [0aa2d28]
- Updated dependencies [0329a22]
- Updated dependencies [7130165]
- Updated dependencies [51561f3]
- Updated dependencies [b63c311]
- Updated dependencies [c86b801]
- Updated dependencies [f058a9b]
- Updated dependencies [88f2836]
- Updated dependencies [e9400e1]
- Updated dependencies [461df5e]
- Updated dependencies [a48ec1f]
- Updated dependencies [036c9df]
- Updated dependencies [6a1bedc]
- Updated dependencies [1f789a2]
- Updated dependencies [7b442f7]
- Updated dependencies [2973a57]
  - @agentproto/a2a@0.1.0
  - @agentproto/app-kit@1.4.0
  - @agentproto/adapter-browser@0.2.0
  - @agentproto/driver-browser@0.1.0
  - @agentproto/plugin-local-browser@0.3.1
  - @agentproto/apps@0.17.0
  - @agentproto/pairing-host@0.1.0
  - @agentproto/app-client@0.4.1
  - @agentproto/llm-endpoint@0.11.2
  - @agentproto/mcp-server@0.4.1
  - @agentproto/provider-kit@0.4.6
  - @agentproto/review@0.4.0
  - @agentproto/redaction@0.2.3
  - @agentproto/routine@0.3.1
  - @agentproto/workflow-runtime@0.15.0
  - @agentproto/driver-agent-cli@2.6.0
  - @agentproto/command-sandbox@0.3.0
  - @agentproto/workspace-brain@0.4.9
  - @agentproto/eval-reporters@0.2.19
  - @agentproto/sandbox@0.7.2
  - @agentproto/acp@0.9.1
  - @agentproto/agent@0.2.5
  - @agentproto/auth@1.1.1
  - @agentproto/driver@0.2.5
  - @agentproto/governance@0.1.5
  - @agentproto/manifest@0.2.3
  - @agentproto/secrets@1.1.1
  - @agentproto/tool@0.3.2
  - @agentproto/workflow@0.7.1
  - @agentproto/governance-engine@0.1.9
  - @agentproto/driver-http@0.1.9
  - @agentproto/workflow-loader@0.2.5
  - @agentproto/telemetry-langfuse@0.2.17

## 5.2.1

### Patch Changes

- Updated dependencies [d2df24b]
  - @agentproto/model-catalog@0.11.3
  - @agentproto/providers-store@0.3.21
  - @agentproto/llm-endpoint@0.11.1

## 5.2.0

### Minor Changes

- 8c5ee51: `device` sandbox provider (DEVICES-PLAN PR-D): a paired HOST device (reverse pairing, `HostRegistry`) is now usable as an `agent_start({ sandbox: "device:<name>" })` target, spawning and proxying an agent session on that device's own daemon exactly like `sandbox: "e2b"` proxies a cloud box today — prompt/output/events/kill all work from the driving daemon, and the session shows up in `session_list` with its device.

  On the receiving device, this is opt-in and off by default: `agentproto devices allow-spawn on|off` (`features.deviceSpawnAllow`) gates a new `/device-spawn/*` route family, reachable only over a pairing the other side registered as a host (`pair offer --host` + `devices add`) — mirrors `devices share-inference`'s gate shape. A device's own filesystem is unrelated to the driving daemon's, so a spawn with no explicit `cwd` is no longer forwarded as a host-shaped path that would ENOENT remotely; the box's own `agent_start` resolves its own default instead (new `SandboxProviderHandle.omitCwdWhenImplicit` flag, additive for every other provider).

- 5ce6cdc: Join-token host visibility follow-ups (SANDBOX-VISIBILITY-JOIN, stacked on #1517/#1535): a CI-joined box's `AGENTPROTO_JOIN_PROVIDER`/`AGENTPROTO_JOIN_LABELS` env are now forwarded into the sandbox the same gated way `AGENTPROTO_JOIN` already is, and `join-token-registry.ts` synthesizes `"<token name> #<pr>"` for a box that doesn't self-report a name (it never knows the token's own name — only the home daemon does).

  A failed `addHost()` round trip (the daemon dialing back into a joined box's self-minted offer) is now recorded on the join token as `lastJoinError`/`lastJoinErrorAt` instead of only logging it — `useCount` bumping with no matching device update is no longer silent. The box's self-offer TTL widened from 60s to 3min to give that round trip more slack under real broker latency.

  `HostRegistry` now caches the last successful `GET /sessions*` response per host and serves it (`stale: true`, with a capture timestamp) when a subsequent forward to an offline host fails — wired through `device-registry.ts`'s `forwardHttp`, the `device_sessions` MCP tool, and `GET /devices/:id/sessions[/:id/output]`. A join-token-added host is now tagged (`HostRecord.addedVia`) and pruned after `joinedHostTtlMs` (default 7 days) of no `lastSeen` activity; a manually paired host (`pair offer --host` + `devices add`) is never auto-pruned.

- 21a117c: Add session inference-binding (agent_start.inference) with harness fit-check, relocate pi models sync into llm-endpoint
- de2decc: Review attestation signing and composition: `@agentproto/review` gains `canonicalJson`, `canonicalAttestationBytes`, and `attestationSha256` plus optional `Attestor.signature` and `LaneResult.composedFrom` fields. `@agentproto/runtime` adds `review-signing.ts` (SSH-keygen-based `signAttestation`/`verifySignedAttestation`, key management, `ReviewConfig`) and `review-compose.ts` (delta re-review composition). `@agentproto/cli` adds the `review key` subcommand and `verify --allowed-signers/--require-signed` (exit code 6). The review panel shows signed/unsigned badges.
- 6f53567: Review panel: the agent-lane reviewer-session link now deep-links the live-session widget as a real per-session URL (`/apps/@agentproto/live-session/ui?sessionId=<id>`), opened via `openLink` with a `window.open` fallback — the same convention session-chat's card link uses. Runtime's `handleAppUiPage` reads the `sessionId` query param, validates it (`isValidDeepLinkSessionId`), and bakes it into the live-session widget's `window.__APP_INIT__` so it boots already pinned to that session; invalid or absent ids are ignored and every other builtin's html is served byte-identical. `REVIEW_PANEL_UI_TOOLS` keeps only the review tools (the deep link is a navigation, not a `tools/call`), and the panel exports `liveSessionUrl`.
- f3f632a: Add UserPreset.lastUsedAt stamping, user_preset_* MCP tools, and includeRecent spawn-config candidates

### Patch Changes

- 2d8c803: Fix `workflow_cancel` crashing the whole daemon when it lands on a run whose agent step is mid-turn: `SessionsRegistryAgentHost.sendPromptAndWait` (and `onAwaitingInput`'s auto-allow branch) now await `registry.sendPrompt` and `waitTurnEnd` together via `Promise.all`, so a session killed mid-turn rejects cleanly instead of producing an unhandled rejection. Also finalizes any step left `running`/`pending` on a persisted terminal (cancelled/failed/done) run found at daemon boot, so a run interrupted mid-finalization no longer reports a stuck step forever.
- 8c03fe2: Fix message_reply race where a just-acked message could miss its unflushed transcript record
- d4ac86e: Sync generated catalog data from the pinned provider sources: refreshed pricing (moonshot kimi-k2.6, minimax M2.7, deepseek/openrouter rows), removed delisted models (zai-org GLM-4.5/4.6-FP8/5.1-FP8, several opencode-go routes, baseten provider rows), and updated catalog-sync snapshot fixtures. Also replaces retired-id test pins (opencode-go `minimax-m2.5`/`omen-alpha`) with structural bounds in the claude-code, claude-sdk, and runtime model suites.
- c463221: Cache parsed review-ledger entries keyed by `stat` (mtimeMs + size) so repeated `session_tree` polling no longer re-reads and re-parses unchanged attestation files. Own writes invalidate the cached path immediately, reads always guard against writes from other `ReviewLedger` instances over the same root, and annotations (`getAnnotations`) are deliberately excluded from the cache so `pr`/`prState` are never served stale. Also adds a `bench:review-ledger` script for steady-state before/after numbers.
- c6e3989: Pack rubric paths are now confined to the pack's own root in the runtime loader: `PackSource.readRubric` realpaths both the resolved path and the pack root and refuses to read anything that resolves outside it — covering `../../` escapes, absolute paths, and same-directory symlinks pointing elsewhere — regardless of whether the pack is trusted. `resolvePacks` now eagerly reads every selected agent check's rubric at resolve time and wraps any loader failure in a `ReviewManifestError` naming the pack and check, so a violating pack fails the review up front instead of mid-session.
- Updated dependencies [d4ac86e]
- Updated dependencies [d000369]
- Updated dependencies [d4ac86e]
- Updated dependencies [21a117c]
- Updated dependencies [de2decc]
- Updated dependencies [6f53567]
- Updated dependencies [c6e3989]
  - @agentproto/model-catalog@0.11.2
  - @agentproto/llm-endpoint@0.11.0
  - @agentproto/review@0.3.0
  - @agentproto/apps@0.16.0
  - @agentproto/providers-store@0.3.20
  - @agentproto/sandbox@0.7.1

## 5.1.0

### Minor Changes

- 3619a5f: Device inference over pair/v2: a controller can address a paired host's local models transparently as `<endpointId>@<device>` (e.g. `ollama@work-mac/llama3.1:8b`), routed over the paired E2E channel with no open inbound port. Includes the opt-in `features.deviceInferenceShare` flag + `agentproto devices share-inference on|off` (gated by host-scoped pairings via a daemon-injected `x-agentproto-host-scope` header), the streaming `POST /devices/:id/exec-stream/<subpath>` relay, corporate-proxy support (`HTTPS_PROXY`/`NO_PROXY`) for rendezvous dials, and a `doctor` rendezvous reachability step.
- a3ec1d6: Add capability bundles (bundle_list/create/update/delete, /mcp/imported/<id> passthrough), agent_start.daemonMount, and opencode install-mcp/skills support
- 54e1f3b: Add session-scoped artifact store: session_artifact_add/_list/_get/_pin tools, /sessions/:id/artifacts* HTTP routes, and outcome file refs
- b7b85d6: Auto-join wiring for sandbox boxes: optional `join: { tokenEnv: string }` on the AIP-36 `SandboxDefinition` (`@agentproto/sandbox`) names a host env var whose value (a join-token URL) is forwarded into the box under the same name at boot — sugar over `env.passthrough`, self-documenting for the auto-join case, and a no-op (never a boot failure) when the named host env var isn't actually set. `@agentproto/runtime`'s sandbox-boot slug collection (`bootSandboxAgentSession`) now includes `join.tokenEnv` in the resolved secret set whenever it's present and resolvable.
- b7b85d6: Join tokens (SANDBOX-VISIBILITY-JOIN): a daemon can now mint a long-lived, revocable, reusable credential (`join_token_create`/`join_token_list`/`join_token_revoke` MCP tools, `POST/GET /devices/join-tokens` + `DELETE /devices/join-tokens/:id` REST routes, `agentproto devices join-token create|list|revoke` in `@agentproto/cli`) that a box daemon reads from its `AGENTPROTO_JOIN` env var at boot to auto-register itself as a host (`HostRegistry.add`, DEVICES-PLAN PR-C) with no offer URL to relay by hand — new `createJoinTokenRegistry`/`JoinTokenRegistry` in `@agentproto/runtime`, wired into `createGateway`'s `joinTokens` option, and boot-time `AGENTPROTO_JOIN` handling in `agentproto serve`. `HostRecord`/`Device` gain optional self-reported `provider`/`sandboxId`/`labels`, set via `HostRegistry.add`'s new optional `meta` parameter. New `device_sessions` MCP tool + `GET /devices/:id/sessions[/:sessionId/output]` REST routes + `agentproto devices sessions` (and the new `DeviceRegistry.forwardHttp`/`GET /sessions/:id/output` it's built on) let one daemon read another registered host's session list and tail a session's output over the same E2E channel `/devices/:id/exec` already uses. `@agentproto/apps`'s builtin Session Chat launcher additionally allowlists `device_list`/`device_sessions` for its UI.
- 4ecd91b: `local-gh` sentinel provider: check-completed and closed events now key off the PR's head sha, so a new push whose CI concludes the same way as the last one (e.g. lint fails again) is no longer dropped by the delivery dedup, and a check that finishes between two polls on a new head is no longer masked by the old head's already-seen conclusions. `PrStatusSnapshot` gains an optional `headSha` field, and a new `github.pull_request.synchronize` event (now in the PR default type set) is emitted for the push itself.
- 3dc5a8b: feat(runtime): session steward runtime — wrap-up plan, per-session RAM, close with outcome. Adds `processTreeRss` (per-session process-tree RSS via `ps`) and `session_list`'s `withMemory` input; `planSessionWrapup`, a deterministic (zero-LLM) close/stuck/judge/keep classifier for idle agent-cli sessions; `SessionOutcome` Level 2 fields (`source: "judged" | "declared"`, `verdict`, `judgedBy`, `note`) alongside two new `SessionEndReason` values (`steward-completed`, `steward-abandoned`); `registry.closeWithOutcome` (verdict `"done"`/`"abandoned"` closes the session lazy-resumably, `"blocked"`/`"needs-input"` records `SessionDescriptor.wrapupFlag` instead without touching liveness); and the `session_wrapup_plan` / `session_wrapup_apply` MCP tools. The judge-agent workflow for the ambiguous class is a separate follow-up.

### Patch Changes

- Updated dependencies [83ffc2d]
- Updated dependencies [b7b85d6]
- Updated dependencies [b7b85d6]
  - @agentproto/apps@0.15.0
  - @agentproto/sandbox@0.7.0

## 5.0.0

### Major Changes

- 52e286a: Sentinel: replace `SentinelSpec.subject` with a required multi-clause `spec.match` (OR semantics across `{subject, types?}` clauses; new `singleMatch()` helper). Dedup is now applied only after delivery (at-least-once) via the new read-only `SentinelStore.isSeen`. `SentinelTarget` gains frozen (not-yet-delivered) `routine` and `webhook` variants, rejected at create time with the new `SentinelTargetNotImplementedError`. `Sentinel` records gain a persisted `terminalSubjects` list for multi-clause `until: subject_terminal` expiry.

### Minor Changes

- fee6123: feat(runtime): sentinel primitive (AIP-60 step 1/2) — persisted watch registry (`sentinel-store`), poll/delivery engine (`sentinel-runtime`), pluggable provider contract + registry, GitHub webhook → CloudEvents normalizer, and `list_sentinel_adapters` / `setup_sentinel_provider` MCP tools. No built-in provider ships yet; the feature is inert until a sentinel exists on disk or a third-party provider package is installed.
- eba403e: Add the read-only `capabilities_inventory` MCP tool and its `GET /capabilities/inventory` HTTP twin (shared builder in the runtime), plus exported `CapabilitiesInventory*` types. Add a Capabilities (MCP & Skills) section to the `@agentproto/config` app, including the new `capabilities` deep-link fragment section.
- 8277109: Combine stdout+stderr in HookError, add setup-hook log persistence and bounded retry
- 753bfc7: `review_ledger` gains `includeRunning`, `requesterSessionId`, and `subtree` (backed by a lazy, incrementally-updated ledger index, never a full re-scan), and `ReviewRunner.list()` surfaces in-flight and settled-in-this-process runs. `session_tree` nodes that requested a review now carry a `reviews` badge (latest 3, newest first). A settled review with a known requester writes a display-only `notice` into that session's transcript (never a prompt, never a wake) via the new `SessionsRegistry.recordNotice`. New builtin panel `agentproto_reviews` (`packages/apps/src/review-panel`) — a verdict list + detail view over the review ledger, mounted alongside sessions-panel/work-board, with cancel / re-run-fresh / PR-status / export actions over the existing `review_*` tools.
- 5b80cb5: AIP-60 step 3/4: add the `local-gh` sentinel provider (zero-infra PR polling over the host's authenticated `gh` CLI), sentinel auto-link (a PR opened by a session is auto-watched, gated by `config.sentinel.autoWatchPrs` and the per-spawn `agent_start.sentinel: false` opt-out), `sentinel_watch`/`sentinel_list`/`sentinel_unwatch`/`sentinel_poll_now` MCP tools, `/sentinels` daemon HTTP routes, a new `agentproto sentinel` CLI subcommand, and a `SentinelSpec.subject` → `match[]` (OR multi-clause) contract with at-least-once delivery in the sentinel runtime.
- 7727cbe: Add session_capabilities read surface (MCP tool + GET /sessions/:id/capabilities)
- 8518b3f: Fix workflow_cancel: a still-running step is finalized to a `cancelled` status instead of being left `running` forever, an in-flight agent session that was still spawning when cancel fired is killed immediately, and a step interrupted mid-flight is never journaled as succeeded so `workflow_retry` re-executes it.

### Patch Changes

- f731f49: Fix continue-interrupted: only the last restart's rows, truthful send failures
- 11e917c: Tolerate newer-than-known mcp-protocol-version headers on /mcp instead of 400ing
- Updated dependencies [eba403e]
- Updated dependencies [753bfc7]
- Updated dependencies [8518b3f]
- Updated dependencies [afe8324]
  - @agentproto/apps@0.14.0
  - @agentproto/workflow-runtime@0.14.0
  - @agentproto/app-kit@1.3.1
  - @agentproto/sandbox@0.6.2
  - @agentproto/review@0.2.0
  - @agentproto/eval-reporters@0.2.18
  - @agentproto/telemetry-langfuse@0.2.16

## 4.1.0

### Minor Changes

- 663f9ec: `branch_gc` background jobs are now visible to `branch_gc_status` from any MCP connection (the job registry was per server instance, so a job started on one connection was "not found" on the next). `branch_gc_status` also reads a finished job back from its result file, and a background `branch_gc` response now carries `resultPath` plus a `followUp` block (tool, args, poll interval) telling the caller how to follow up.
- 1f03bf3: `branch_gc` can run in the background (`wait: false`, or `waitMs` to block at most that long) and be polled with the new `branch_gc_status` tool, so a multi-minute plan no longer times out an MCP call. Branch gc also answers "contained in a remote ref" and "merged into base" from one `git rev-list` each instead of one git call per ref (109 s → ~78 s on a 900-ref repo).
- 37ca1e3: Add cache/reasoning token detail and session_usage subtree rollup
- b0b5fd5: Slim MCP tool schema descriptions into short contracts with on-demand `tool_help` pointers; add the always-on `tool_help` MCP tool and the `agentproto help <tool>` CLI verb, ship `docs/mcp-tools/` in the runtime package, and add a tool-schema budget guard test plus a measuring script.
- a693944: Device registry (DEVICES-PLAN PR-A): new `createDeviceRegistry` / `registerDeviceTools` / `readPairingsSnapshot` exports and `rename`/`isOnline` on `PairingRegistry` in `@agentproto/runtime`; new `agentproto devices list|rename|revoke` CLI verb and a `devices` step in `doctor` in `@agentproto/cli`, with matching `/devices` REST routes and `device_*` MCP tools over the shared pairing registry.
- 8a29038: Add AIP-58 §6 run.retry (workflow_retry) — journal-sourced replay, no re-execution
- c0fed50: Surface in-band turn errors end-to-end: a turn whose adapter stream ends after an `error` event (no explicit turn-end) is now classified `reason: "error"` instead of `"exited"`. Adds `SessionTurnEndEvent.error`, `SessionWaitResult.error`, `lastTurnErrorMessage` on the descriptor/compact list projection, and forwards `reason`/`error` on webhook payloads; `sessions wait` and `session_monitor` diagnostics fold in the captured message.
- 332aebf: Reverse pairing (DEVICES-PLAN PR-C): optional `scope: "host"` on pair/v2 offer URLs in `@agentproto/secrets` (`encodeOfferUrl`/`parseOfferUrl`, additive — a plain offer's URL is unchanged); new `createHostRegistry`/`HostRegistry` in `@agentproto/runtime` (the daemon-side pair/v2 client for registering and driving another daemon as a host), merged into `createDeviceRegistry`/`device_list` as `role: "host"`, plus the `device_add` MCP tool and `/devices/add` + `/devices/:id/exec` REST routes; new `agentproto pair offer --host` and `agentproto devices add|status` in `@agentproto/cli`.
- 7e38e0a: Daemon-supervises the llm-endpoint gateway: crash-restart policy for `LlmEndpointRegistry`, boot autostart + `ensureLlmEndpointRunning` self-heal hook for spawns, `GET /llm-endpoint/status` + `POST /llm-endpoint/restart` REST routes, and the `resolveEffectiveLlmEndpointFlag` smart-default resolver (new exports).
- 9a5730d: `agent_prompt`/`agent_start` (MCP) now accept the same content-block prompt shape the HTTP `POST /sessions/:id/prompt` route already did (new shared `promptInputSchema`). Print-arm adapters (`@agentproto/driver-agent-cli`) fail loudly with a turn error on non-text blocks instead of silently dropping them. `transcript-writer` materializes inline-bytes blocks (pasted images) into a content-addressed attachment store, and a new `GET /sessions/:id/attachments/:filename` route reads one back (new `AttachmentEntry`/`mimeTypeForExtension`/`sessionAttachmentsDir` exports).
- 474a1a7: Add SessionsRegistry.readBackgroundTaskTail with HTTP + MCP (session_bg_task_tail) surfaces
- aa8c64f: New continue-interrupted feature: `session_continue_interrupted` MCP verb, `POST /sessions/continue-interrupted`, `agentproto sessions continue-interrupted`, and the opt-in `daemon.continueInterruptedOnBoot` boot pass.
- 7f50ff6: Branch gc prunes stale remote-tracking refs (`git fetch --prune`) before classifying and reports it as `plan.fetched`; its delete pushes skip git hooks (`--no-verify`) and a refused batch is retried as a batch before falling back to one push per ref. The `maintain` workflow now applies worktree gc before branch gc.

### Patch Changes

- 651d266: `ui://app_ui_<id>/view` and `GET /apps/:appId/ui` no longer block on a full `ui.build` run or serve raw `{"error":...}` JSON as page text. A build in flight now serves a self-refreshing "building" placeholder; a missing bundle, missing `ui.build`, a failed build, or a removed app dir now serves a readable HTML error page. `app_list`/`app_status` also report `dirMissing: true` for an installed app whose `dir` no longer exists.
- 350df7e: Docs: document cache/reasoning token fields on `usage_snapshot` transcripts and the new `GET /sessions/:id/usage` REST endpoint in the runtime README.
- 114d4e9: Allow vscode-file: in default app-ui frame-ancestors CSP
- b9f9bb6: Fix two dogfood frictions: `tool_search` now weights a query term matching a tool's own name far above an incidental mention in another tool's description, so a real `workflow_*` tool can no longer be crowded out of a capped result by an unrelated tool's prose (F39); and `workflow_run_file` now resolves a `kind:"tool"` step's TOOL.md/DRIVER.md bundle from the given WORKFLOW.md's own directory (walking up to its app root) instead of always the `app_install` registry's dir, so running a WORKFLOW.md from a worktree copy of an installed app no longer silently executes the installed copy's scripts (F40).
- 632f16a: Fix the `@agentproto/runtime` build on main: `run.retry` now passes the WORKFLOW.md path to `compileWorkflow`, whose signature gained that second argument in a concurrently merged change.
- Updated dependencies [fa1bfdd]
- Updated dependencies [68ffab8]
- Updated dependencies [b0eeee7]
- Updated dependencies [8a29038]
- Updated dependencies [b9f9bb6]
- Updated dependencies [b297612]
- Updated dependencies [332aebf]
- Updated dependencies [9a5730d]
- Updated dependencies [7f50ff6]
  - @agentproto/model-catalog@0.11.1
  - @agentproto/workflow-runtime@0.13.1
  - @agentproto/secrets@1.1.0
  - @agentproto/driver-agent-cli@2.5.1
  - @agentproto/apps@0.13.1
  - @agentproto/providers-store@0.3.19
  - @agentproto/sandbox@0.6.1
  - @agentproto/review@0.2.0
  - @agentproto/acp@0.9.0
  - @agentproto/eval-reporters@0.2.17
  - @agentproto/telemetry-langfuse@0.2.15

## 4.0.0

### Major Changes

- f70d919: Retire pair/v1 with a route/auth token split (pair/v2): broker-visible tokens no longer authenticate; a distinct sealed-hello auth token is checked instead. v1 offers, pairings, credentials, and wire hellos are refused with an actionable `pairing_protocol_outdated` re-pair error, and daemons answer legacy v1 hellos with a notice-only re-pair channel. Breaking: `PAIR_VERSION` 2, `ClientHandshakeParams.offerToken`→`authToken`, `PairingOffer.token`→`secret`, `verifyOfferToken`→`verifyAuthToken`, `CreatedOffer.token`→`secret`, pairing/credentials files version 2 (v1 files load flagged `legacy`), new exports `respondToLegacyHandshake`, `deriveEpochAuthToken`, `deriveEpochTokens`, `deriveOfferTokens`, `RouteAuthTokens`.

### Minor Changes

- eaa50f8: Add `branch_gc`, the sibling of `worktree_gc` for refs. It classifies local branches, the base remote's branches and orphan tracking refs (from removed remotes) as `reclaim` (provably in base: merged, squash-merged, patch-merged or content-merged), `review` or `hold` (protected, worktree plus its remote twin, open PR, PR check unavailable, too young). It's a dry run unless you pass `apply` with explicit `scopes`. Each ref is re-classified right before it's deleted, and every apply writes a restore log. `branch_gc_verdict` stores reviewer verdicts by tip sha, so `includeReviewed` can reclaim a ref once a gate has agreed. New CLI commands: `agentproto branch gc` and `agentproto branch review-queue`; new HTTP routes: `POST /branches/gc[/verdict]`. `worktree_gc` also changes: a noise allowlist (`noisePaths`, default `.opencode/package-lock.json`), status reads that take no optional locks, and clean idle worktrees whose branch content is squash/patch/content-merged now reclaim.
- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.
- 4e398a9: Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
- c3314bd: AIP-58 conformance harness (V1 green, V2-V8 tracked as `it.todo`) plus workflow input validation: a `WORKFLOW.md`'s shorthand `inputs` map now normalizes to JSON Schema, and a run with missing/invalid required input is rejected as `error.code = "invalid-input"` before any step runs.
- cd00daa: Apps may now bundle their own AIP-14 `TOOL.md` contracts and AIP-30 `DRIVER.md` implementations (`kind: cli`/`http`) under `.agentproto/tools/<id>/TOOL.md` and `.agentproto/drivers/<id>/DRIVER.md`. `loadAppHandle` (app-kit) discovers and loads them; the runtime's `compileWorkflow` seam merges an app's own tools/drivers over the daemon passthrough registry for every `WORKFLOW.md` `tool` step it owns, with an app tool id winning over a daemon tool of the same id. `driver` gains `driverDefinitionFromManifest`, factored out of `driverFromManifest` so kind-specific sugars can build from a DRIVER.md manifest directly. `driver-http`'s non-2xx errors now include a body excerpt, not just the status code.
- 7c059bc: AIP-58 §3 Outcome rule (P2): an agent step's session can now call the `run_request_input` MCP tool to explicitly suspend the step as `input-required` — the turn simply ending, or its final message reading like a question, never suspends it. A declared-but-unsatisfied `outputSchema` now fails as `error.code = "missing-output"` (replacing a bare thrown error) with a `hint: "possible-input-request"` triage aid when the final message looked like a question; a step declaring no contract at all still succeeds unconditionally, with one load-time warning per step. Suspended workflow runs resume via the existing `workflow_escalation_resolve { runId, payload }`, validated against the suspend's own JSON Schema before the transition.
- 24467af: Deferred/lazy MCP tool loading: add per-mount `?deferred=1|0` query override, per-spawn/role `deferredTools` (executor defaults ON), and daemon-wide `defaults.mcp.deferredTools` config; extend the claude-code `lean` mode with native `ENABLE_TOOL_SEARCH`.
- 579227e: AIP-58 §5/§9: per-run append-only event logs (`run_events` MCP tool with `sinceSeq` paging), real step visibility in `workflow_status` (tool/gate/map-item steps, compact by default with `full: true`), and indexed `<id>[<index>]` map/pipeline step hooks.
- dc2a7c7: `remote_enable` (MCP tool and the new `POST /remote/enable` REST route) now returns a `phoneUrl` — the installed `@agentik/session-chat` app's UI, or the hosted panel fallback — with the token in a URL fragment; adds `GET/POST /remote/*` REST twins of the remote tools and a new `agentproto remote enable|disable|status [--qr]` CLI verb; `printQr` is extracted from `pair.ts` into a shared `util/qr.ts`.
- 8fe9f81: Add @agentproto/review primitive + review_* daemon tools (run/status/cancel/ledger/export)
- 8c74864: stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
- dc87d79: Track claude-code's background-task wake instead of dropping it
- e7a2958: Per-session headless browser: `agent_start`/HTTP/CLI spawns accept `browser: "headless"` (off by default), mounting an isolated chrome-devtools-mcp stdio server with a per-session Chrome profile that is swept on session exit; `buildHeadlessBrowserMcpEntry` gains an optional `userDataDir`.
- b50e61c: Support cross-harness handoff overrides on session_continue_fresh
- e412bd8: Sandbox spawn defaults cwd to the box's home, kills by default on close, and reconciles the ledger against the real provider
- a16be06: Compress + etag the app-UI shell/assets via a shared delivery module
- 6c68009: Cache tool steps, key map items by index, surface cache hits as steps
- 1e871ec: AIP-58 §2 run liveness: workflow runs interrupted by a daemon restart now fail with `host-interrupted`, and a periodic sweep fails runs whose owner lease expired with `orphaned`. App runs now report `succeeded`/`failed`/`cancelled` instead of `ended`/`stopped`, zombie app runs are swept to `failed` (`orphaned`), and `app_status` is compact by default (`full: true` for everything). `workflow_status` now fails only the step that actually failed (F29), caps errors in compact output (F30), lists branch-arm steps only once they run and in execution order (F31), and shows a running agent step's `sessionId` as soon as its session spawns (F34).
- 5a466d6: Mount daemon /mcp gateway on workflow agent steps; fix prompt sections, map scheduling, run output persistence, maintain --wait
- 583ee19: Live-session teardown fixes: `DELETE /sessions/:id` (and `registry.forget`) now tears a still-running session down through the full kill teardown (adapter close, PTY/child SIGTERM, `session:exited` emit) before dropping the row, returning an additive `killed` field; adapter closes in the agent CLI now terminate the whole child process tree (SIGTERM → grace period → SIGKILL) so `npx` wrappers, MCP servers, and headless Chrome can no longer outlive the session.
- ea5e30d: Add typed SessionMessage envelope + session-message transcript record for inter-session reports
- 5f923bb: Durable inter-session messaging inbox (AIP-46 §Session messages): new `message_send`, `message_reply`, `inbox_list`, `inbox_ack`, `inbox_wait` tools, `POST /sessions/:id/messages` / `GET /sessions/:id/inbox` / `POST /sessions/:id/inbox/ack` HTTP routes, `sessions inbox` / `sessions message` CLI commands, and a re-routed `message_parent` through `registry.sendMessage`.
- 3ad0b83: Add urgency-tier delivery routing (fyi/next-turn/steer/interrupt) to session messaging with gated interrupt-grant
- 6a1dd7a: Add strong ETag / if-none-match conditional-GET (304) and an optional ?since= delta view to GET /sessions
- dd5bf7d: Add an MCP Apps host service with three daemon tools (`mcp_app_ui_index`, `mcp_app_ui_read`, `mcp_app_tool_call`) that resolve a session's server alias (session → project → user → imports) and proxy app-UI resources and iframe-initiated tool calls through a new config-keyed MCP client pool. Also adds codex `config.toml` MCP discovery (`~/.codex/config.toml`, `<cwd>/.codex/config.toml`) and exports the shared client-pool / codex-config / resolver helpers.
- bdb5830: repo-maintenance: missing-verdict retry ladder (same-session nudge + large-model retry) via the new read-only `branch_gc_verdict_get` tool (`BranchGcVerdictReader` port); fixed the maintain report's worktree classification counts; `tool_search` option for the claude-code adapter, auto-disabled for allowlisted agent steps; `{{index}}` support in agent-step `sessionRef` for fan-out session reuse; step session descriptors now echo the pinned model/effort.
- 4612eda: Add `updateAuthProfile` (metadata-only patch for `label`/`costBudget`) to @agentproto/auth, exposed as the `auth_profile_update` MCP tool and a `PATCH /auth/profiles/:id` HTTP route in @agentproto/runtime. Tri-state per field: omit to leave, `null` to clear. Never touches credentials or `credentialRef`.
- b61405e: Worktree status now carries base divergence (`dirty`/change counts, ahead/behind vs the default branch), PR web URLs built from a GitHub `origin` (including ssh host aliases), a per-session `worktree_status { sessionId }` / `GET /worktrees?sessionId=` narrow read, and new session descriptor fields `mainRepoPath` and `commandSandbox`. Adds `computeBaseDivergence`/`BaseDivergence` and `githubPrUrlBuilder` exports; `listWorktreeStatuses` accepts a `paths` filter.
- c671e27: Add derived session outcome (L1) and `sessions show` CLI command
- 713d8bd: Add config.json zod schema + CONFIG_KEYS registry; CLI config set/unset now type-validate values (writable/secret gating stays CLI-exempt, reserved for a future config_set)
- 219e8cf: Additive engine features for tolerant fan-outs and cleanup: a spawn circuit breaker for `map`/`pipeline` with `onError: "collect"` (`maxConsecutiveSpawnFailures`, `AgentSpawnError`, `skipped` outcomes, `onStepFailed` hook), workflow-level `finally` cleanup steps, per-step agent `cwd` resolution against the run cwd, the `branch_gc_review_worktree` tool (disposable detached review worktrees), and parallelized/memoized `merge-base` sweeps in branch gc. The maintain workflow caps reviews per run (`maxReviews`, default 40) and runs every reviewer in its own detached worktree.
- 1098eb1: Add the config surface: `config_get`/`config_set` MCP tools over the config key registry, a `config:changed` runtime event, and REST twins `GET /config` / `PATCH /config` on the runtime HTTP server. Registered on the root `/mcp` server only; secret values are always redacted.
- 5f0f9d1: Add web-fragment pair offers, browser pair-client tunnel, and pairing revocation signalling
- 515352b: Cron kind:"agent" and routine target.agent now accept agent_start's full input shape
- be22e9f: Add optional view deep-link input to app_ui_* panel tools, routed via bridge tool-input
- ef9f57e: Widen the daemon identity fingerprint from 64 to 128 bits and default `pairing.pairPage` to the new per-daemon `{fingerprint}.agentproto.cloud` pair page (`DEFAULT_PAIR_PAGE`); offer URLs now require the 32-hex fingerprint id.
- 07e8751: Surface WHY a session ended: add a single-source `SessionEndReason` enum (`SESSION_END_REASONS`, `isKnownSessionEndReason`, `isProviderLimitError`), thread a `reason` through `SessionsRegistry.kill()` (operator-completed/operator-stopped/policy-cleanup/parent-exited/forgotten), tag cost-cap and provider-usage-limit teardowns, add an idempotent "mark as completed" outcome relabel on already-terminal rows (`termination.previousReason`), and a `sessions stop --completed` CLI flag.
- a519173: Review primitive CLI and provenance: new `agentproto review run|verify|init` verb (daemon-backed or headless runs, attestation verification, REVIEW.md + pre-push hook + Actions scaffold); attestations gain optional `requester` and `pr` provenance and agent lanes record the reviewer's model; the runner gains `supersede` and head-aware dedupe; the ledger gains a mutable PR annotations sidecar with a new `review_pr` MCP tool that links attestations to GitHub PRs via `gh` and snapshots PR status.
- c9e8318: F34b: exec a pinned `npx -y pkg@x.y.z` adapter's cached bin directly instead of paying `npm exec`'s tree scans and locks (fail-closed to a plain npx spawn otherwise), and mark a running workflow agent step whose session is still booting as `phase: "spawning"` in `workflow_status` until its session id attaches.
- 502f4c9: Add AIP-58 §4 per-run workspace + artifacts (kind:"artifact", outputsFiles.required, run.publish/readArtifact)
- 8dc445b: branch_gc: reclaim merged-PR-head tips without review; review queue groups by branch name
- 54abf58: Role text now matches the delegation tools a session can actually reach. A spawn with no daemon/orchestrator mount, or whose mount strips `agent_start` (`denyTools`), gets the executor disposition and no "Roles you may spawn" line instead of a supervisor promise of a tool it doesn't have — and a depth-0 spawn with no `role` defaults to executor in that case. The supervisor text now names `agent_start`/`agent_prompt` as MCP tools on the `agentproto` server, points at `tool_search` when that mount is deferred, and gives the `agentproto sessions start`/`prompt` CLI equivalents. `agent_start`/`agent_prompt` are always-on under deferred tools even with a custom `alwaysOn` set (a deny-role mount still strips them).
- 4a68dd5: `GET /sessions` and `GET /sessions/:id` accept `?fields=a,b,c` (same allowlist semantics as the `session_list` MCP tool; `id` always kept). `SessionDescriptor.archivedAt` is set by `archiveSession` and cleared by `unarchiveSession`; the `GET /sessions?since=` delta now lists in `removed` only the ids archived at or after `since`. On `GET /apps/:appId/ui/assets/:file`, `sw.js` is served with `service-worker-allowed: /apps/:appId/ui` and `cache-control: no-cache`; `.webmanifest` gets `application/manifest+json`.

### Patch Changes

- 0b68419: Follow-up to the MCP Apps host's app-UI `callTool` gate (#1459), which now needs the hosting server's FULL tool list to decide app-visibility. Two gaps in getting that list: `PooledMcpClient` read only the first `tools/list` page, so a server that paginates (`nextCursor`) would have every page-2+ tool refused as "does not exist" — it now loops on `nextCursor` until exhausted (capped at 50 pages). And an executor session's daemon self-mount carries `?deferred=1`, which makes the daemon's own `tools/list` return only its always-on subset (`tools/call` is unaffected — deferred is listing-only); the host built its own connection from that same session config and inherited the restricted listing, so every deferred tool also read as nonexistent. The host now strips `deferred` from a session entry's url before connecting — only its own listing changes, the agent's mount is untouched.
- c530745: `McpAppsHostService.callTool`'s app-UI allowlist now follows the MCP Apps spec (ext-apps `_meta.ui.visibility`): any tool of the hosting server is callable from its app UI unless the tool's `visibility` array explicitly excludes `"app"` (the default `["model", "app"]` applies when unset). Previously only a server's UI tools, its app-only tools, or the tool whose card hosts the app were allowed, so a widget's own plain data-fetch tools (no `_meta` at all) were wrongly refused with `is not callable from an app UI`.
- 4bcb241: Serve `GET /apps/:appId/ui/` (trailing slash) in the app UI host so a reload after the SPA router rewrites the address bar no longer 404s.
- 556ebef: "@agentproto/tool": patch
  ---

  `paginated` now applies an explicit `fields` allowlist to the full record on the paginated branch instead of the compact projection (unless `compact: true` is explicit), so requested fields outside the compact set are no longer silently dropped.

- 8dc2478: feat(mcp-server): `toMcpTool` / `buildMcpTool` gain a `ui` option (definition-level `_meta.ui.resourceUri`) and opt-in `annotations` derived from the contract; call results carry `structuredContent`; new `registerUiResource` helper and `MCP_APP_MIME_TYPE` for MCP Apps `ui://` panels.

  refactor(runtime): reuse `@agentproto/mcp-server`'s `registerUiResource` in the mcp-apps adapter instead of duplicating resource registration.

- 582b79c: App workflow agent steps get three defaults they were missing (F25-F27 from the agent-apps-dogfood friction log). `workflow_run_file`/`startFromFile` without an explicit `cwd` now defaults agent-step (and run-level) spawns to the owning app's root, falling back to the daemon's active workspace — never a bare `/` — and records the resolved cwd on the run. `resolveAgentRefsForWorkflow` now honours, in order, a step's own `adapter:`, the AGENT.md's `metadata.adapter`/`metadata.harness` override, a model-based default (`claude-*` models run on `claude-code`), then the old blanket `mastra-agent` default, and forwards the AGENT.md's `model` to the spawn when the step sets none; a step-level adapter override no longer leaks `options` shaped for a different adapter. A declared `outputSchema` is now announced on an agent step's FIRST prompt (compact JSON Schema, or a short field list when unconvertible), not only on a rejected-reply retry.
- 965e84d: fix(runtime): require the tunnel bearer on every non-loopback route — a forged `Origin` no longer grants tunnel access; `/health`, `/inbound/:slug` (HMAC), and `GET /apps/:appId/ui` remain exempt.
- 48da1d4: Add repo-maintenance app (maintain workflow + reviewer agent) and agentproto maintain CLI shortcut
- 8514ac6: Stop draining the prompt queue when a turn is daemon-interrupted
- ebbb00c: Forward commandSandbox/skills/contextContinuity/deferredTools/attach/notifyUrl on POST /sessions/agent + /sessions/chat
- add6813: Deliver child message_parent reports and crash notices as their own queued turn instead of gluing onto the parent's next prompt
- 9a5d311: Fix branch arms to be exclusive with an explicit join (F22); untaken arms surface as step.skipped
- e03a69f: Harden remote-provider file permissions (tunnel config and cloudflared log files are now owner-only, 0o600) and lower quick-tunnel log level from debug to info to avoid leaking Authorization headers and token query params into logs. Also deduplicate SSE response headers into a shared helper that adds `x-accel-buffering: no` to all SSE routes.
- 525f8e8: Fix restart eligibility projection drift so prefix-routed model adapters resume
- 476b1ca: Crypto portability refactor: `@agentproto/secrets` gains a `CryptoProvider` seam (node:crypto / WebCrypto) and a browser-safe `@agentproto/secrets/pairing/browser` entry; all public crypto APIs (`seal`/`unseal`, identity, pairing handshakes, offer URLs, pair-root/epoch-token derivation) are now async and take an optional trailing `crypto` provider — a breaking change. `@agentproto/acp` gains an `E2eAead` seam, a browser-safe `@agentproto/acp/tunnel/browser` entry, `holdFrames`, and async-derivation callbacks in the handshake-over-sink helpers, with the Node entry keeping its `Buffer`-typed `decodeData`. `@agentproto/cli` and `@agentproto/runtime` adapt call sites to the async APIs.
- 83de717: Thread profile-aware gateway route through auth spec, launch config and descriptor
- 05c8b0e: Hot-apply defaults.agentPromptInterrupt / defaults.messaging.* without a daemon restart
- 1e24258: Poll live-usage readers mid-turn and derive a running computed cost so hermes/opencode/claude-code sessions show cost while busy
- 3168e74: Key installed-app UI HTML cache on the file's own mtime/size, not just app.updatedAt
- Updated dependencies [ab7970c]
- Updated dependencies [8dc2478]
- Updated dependencies [0179144]
- Updated dependencies [65777ee]
- Updated dependencies [4e398a9]
- Updated dependencies [54983df]
- Updated dependencies [c3314bd]
- Updated dependencies [cd00daa]
- Updated dependencies [7c059bc]
- Updated dependencies [d6d86b6]
- Updated dependencies [582b79c]
- Updated dependencies [579227e]
- Updated dependencies [48da1d4]
- Updated dependencies [8fe9f81]
- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [7d825ff]
- Updated dependencies [e7a2958]
- Updated dependencies [e412bd8]
- Updated dependencies [6c68009]
- Updated dependencies [1e871ec]
- Updated dependencies [5a466d6]
- Updated dependencies [583ee19]
- Updated dependencies [ea5e30d]
- Updated dependencies [5f923bb]
- Updated dependencies [535779b]
- Updated dependencies [9a5d311]
- Updated dependencies [bdb5830]
- Updated dependencies [4612eda]
- Updated dependencies [eabdd3c]
- Updated dependencies [476b1ca]
- Updated dependencies [219e8cf]
- Updated dependencies [f70d919]
- Updated dependencies [5f0f9d1]
- Updated dependencies [515352b]
- Updated dependencies [8de3a66]
- Updated dependencies [be22e9f]
- Updated dependencies [ef9f57e]
- Updated dependencies [a519173]
- Updated dependencies [c9e8318]
- Updated dependencies [502f4c9]
- Updated dependencies [8dc445b]
  - @agentproto/model-catalog@0.11.0
  - @agentproto/mcp-server@0.4.0
  - @agentproto/acp@0.9.0
  - @agentproto/apps@0.13.0
  - @agentproto/app-client@0.4.0
  - @agentproto/app-kit@1.3.0
  - @agentproto/workflow-runtime@0.13.0
  - @agentproto/driver@0.2.4
  - @agentproto/driver-http@0.1.8
  - @agentproto/review@0.2.0
  - @agentproto/driver-agent-cli@2.5.0
  - @agentproto/plugin-local-browser@0.3.0
  - @agentproto/sandbox@0.6.0
  - @agentproto/workflow@0.7.0
  - @agentproto/auth@1.1.0
  - @agentproto/secrets@1.0.0
  - @agentproto/routine@0.3.0
  - @agentproto/providers-store@0.3.18
  - @agentproto/workflow-loader@0.2.4
  - @agentproto/eval-reporters@0.2.16
  - @agentproto/telemetry-langfuse@0.2.14
  - @agentproto/workspace-brain@0.4.8

## 3.6.1

### Patch Changes

- Updated dependencies [c5b9e2b]
  - @agentproto/model-catalog@0.10.3
  - @agentproto/providers-store@0.3.17

## 3.6.0

### Minor Changes

- a93da92: Support native and proxied app origins: `AGENTPROTO_PUBLIC_HTTP_ORIGIN` env override, `X-Forwarded-Proto` awareness in `requestHttpBaseUrl`, and injection of `window.__AGENTPROTO_BASEURL__` (with `__AGENTPROTO_UI_TRANSPORT__` tags) so standalone app bridges can reach the daemon through proxies.
- f26e334: Add the opt-in daemon-side session titler (`titler.enabled` in config): after the first completed turn of an `agent-cli` session with a default spawn label, generate a short prosaic title (OpenRouter by default, local first-line fallback) and rename the session. User-created labels are never overwritten; disabled by default.

### Patch Changes

- 7f9497d: Resume native PTY conversations and redact resume env from HTTP
- Updated dependencies [2aadecc]
- Updated dependencies [cbb8743]
- Updated dependencies [41b8b76]
- Updated dependencies [854db1f]
  - @agentproto/model-catalog@0.10.2
  - @agentproto/workflow-runtime@0.12.0
  - @agentproto/providers-store@0.3.16
  - @agentproto/sandbox@0.5.3
  - @agentproto/eval-reporters@0.2.15
  - @agentproto/telemetry-langfuse@0.2.13

## 3.5.0

### Minor Changes

- b8fdbc6: Fix transmit_message/sendOutbound reporting sent:true on a blocked/failed agentpush send; surface message_id, blocked_reason, and suggestion
- fc14c4c: Add queued-mid-turn delivery hint + configurable interrupt default for agent_prompt/message_parent
- ec66e92: Ship a live, boot-stable embed token with each session-chat tool result so host-cached widgets re-arm after a daemon restart: new exported `stableAppEmbedToken()` in runtime, and new optional `SessionChatOutput.embedToken` / `SessionChatOps.mintEmbedToken` in apps.

### Patch Changes

- f6f2d75: Mint per-boot embed tokens so MCP-Apps widgets render in opaque hosts
- f6f2d75: MCP-Apps hosts with opaque widget origins (e.g. Claude Desktop) can now mount an app's `/ui` page: a per-boot embed token is baked into panel bridge scripts at registration and accepted (alongside `vscode-webview:` and `csp.frameDomains`) as a trusted-embedder proof by `handleAppUiPage`/`applyCors`, layered under the existing bearer-auth and `sec-fetch-dest: iframe` gates.
- d388a08: Accept a valid per-boot app embed token (`?et=`) as an allowlisted Origin equivalent on the browser-facing gates (`guardBrowserOrigin`, `authorizeMcp`, `checkSessionsToken`), so MCP-Apps widget blob: documents with opaque `Origin: null` can reach the daemon.
- bdbe806: Type session-resumer test mocks to AgentSessionResumer after vitest bump
- 5380278: Add regression tests for conversation-terminal linking, ambiguity, and title-once derivation
- a25a86f: Type agent-start test mocks for bumped vitest mock-widening
- a373209: Bind agent_start to session-chat widget via self-bootstrapping bridge
- Updated dependencies [5aad102]
- Updated dependencies [e3054e1]
- Updated dependencies [f84c972]
- Updated dependencies [f6f2d75]
- Updated dependencies [a169e72]
- Updated dependencies [f6f2d75]
- Updated dependencies [f30c959]
- Updated dependencies [ec66e92]
- Updated dependencies [a373209]
- Updated dependencies [54e8f28]
- Updated dependencies [4b31967]
  - @agentproto/model-catalog@0.10.1
  - @agentproto/apps@0.12.0
  - @agentproto/provider-kit@0.4.5
  - @agentproto/providers-store@0.3.15
  - @agentproto/eval-reporters@0.2.14
  - @agentproto/telemetry-langfuse@0.2.12
  - @agentproto/workspace-brain@0.4.7

## 3.4.0

### Minor Changes

- 42fffb9: Surface the tool-call route's human-readable `message` (not the machine `error` slug) in both UI bridge scripts on non-ok responses, and reword the `daemon_unreachable` advice so it does not assume the target is the local daemon. Exports `STANDALONE_REST_BRIDGE_SCRIPT` from `@agentproto/runtime`.
- 9a59225: Add a `lane` filter (`agents` | `auto`) to `listSummaries` and `GET /sessions/summaries`, and make the sessions webview lane-aware (server-side lane filtering, stale-lane response discard, and reload-after-lane-switch handling).
- ef59d39: Echo the harness's currently-active native ACP mode id (currentModeId) alongside availableModes on session read

### Patch Changes

- ea6757f: Add OpenCode's two hosted endpoints as first-class billing providers: `opencode-go` (OpenCode Go, the flat subscription, 36 models) and `opencode` (OpenCode Zen, pay-as-you-go, 102 models). Two new catalog-sync generators (`llm:opencode-go`, `llm:opencode-zen`) source both from models.dev and emit `OPENCODE_GO_ROUTES` / `OPENCODE_ZEN_ROUTES`, each with a pruned per-provider snapshot rather than the 4.6 MB whole-ecosystem payload. Prices are used verbatim (models.dev already publishes USD per 1M tokens); zero-priced `-free` variants are kept, and cache multipliers are omitted where the base input price is 0.

  Route tables are keyed `<provider>/<bare-id>` (`opencode-go/glm-5.3`) — opencode's own config spelling, and the same string the runtime derives the billing endpoint from — so `resolveLlmModelRoute` resolves the OpenCode branch ahead of the direct-vendor branch. Neither table is spread into `LLM_PRICING_CATALOG`, so a bare `claude-sonnet-5` keeps meaning direct Anthropic rather than Zen pricing.

  Two Anthropic gateway presets (`opencode-go`, `opencode`) put each endpoint's Anthropic-surface models behind claude-code / claude-sdk — Zen's subset is the whole Claude family. Preset ids deliberately match the catalog route ids, since `resolveAuthSpec` resolves a spawn's base URL by route id. The opencode adapter now offers both endpoints in full in its generated model menu.

  Fixes two spillovers found along the way: `serviceableModelRoutes` no longer reports a spurious direct-vendor route for a self-routed id (`opencode/claude-sonnet-4-6` had picked up `anthropic` via `resolvePricing`'s substring fallback, loosening the money-safety guard and mis-routing the Configuration Lab), and `injectProviderKeysIntoEnv` now visits providers in sorted order so two providers sharing one env name (both OpenCode endpoints read `OPENCODE_API_KEY`) resolve deterministically instead of by `providers.json` write order.

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [9c31c86]
- Updated dependencies [4ade388]
- Updated dependencies [f89414a]
- Updated dependencies [7941fc7]
- Updated dependencies [13858b8]
- Updated dependencies [bced1de]
- Updated dependencies [7473ccd]
- Updated dependencies [ea6757f]
- Updated dependencies [c27f0b8]
- Updated dependencies [9c31c86]
  - @agentproto/model-catalog@0.10.0
  - @agentproto/apps@0.11.0
  - @agentproto/auth@1.0.3
  - @agentproto/provider-presets@0.7.0
  - @agentproto/providers-store@0.3.14
  - @agentproto/acp@0.8.2
  - @agentproto/agent@0.2.4
  - @agentproto/app-client@0.3.3
  - @agentproto/app-kit@1.2.1
  - @agentproto/driver@0.2.3
  - @agentproto/driver-agent-cli@2.4.4
  - @agentproto/driver-http@0.1.7
  - @agentproto/eval-reporters@0.2.13
  - @agentproto/mcp-server@0.3.1
  - @agentproto/provider-kit@0.4.4
  - @agentproto/routine@0.2.3
  - @agentproto/sandbox@0.5.2
  - @agentproto/secrets@0.2.6
  - @agentproto/tool@0.3.1
  - @agentproto/workflow@0.6.1
  - @agentproto/workflow-loader@0.2.3
  - @agentproto/workflow-runtime@0.11.1
  - @agentproto/workspace-brain@0.4.6
  - @agentproto/telemetry-langfuse@0.2.11

## 3.3.0

### Minor Changes

- f83a177: Serve builtin panels at GET /apps/:appId/ui and POST /apps/:appId/tool-call
- e759d6d: Classify a prunable worktree without crashing the gc plan

### Patch Changes

- Updated dependencies [fee0522]
  - @agentproto/command-sandbox@0.2.2
  - @agentproto/driver-agent-cli@2.4.3
  - @agentproto/sandbox@0.5.1

## 3.2.0

### Minor Changes

- 2125685: Add work-board builtin kanban panel over the Task ledger
- daf1d09: Add sandboxProvider to SessionDescriptor/SpawnAgentInput for sandboxed sessions
- 764dd75: Add unambiguous session liveness signal: `alive` field + GET /sessions/:id/alive probe
- 39b0ac5: Queue agent_prompt/inbound routing by default instead of rejecting mid-turn
- 5c0acd2: Reap sandboxes left behind by failed boots and add `sandbox gc`
- d3f0e0d: Expose sandbox liveness separately from session liveness: optional `SandboxProvider.probe()` with `SandboxProbeResult`, a portable `SandboxBoxGoneError` sentinel (e2b maps provider 404s to it), a `GET /sandboxes/:id/alive` runtime route, a new `"gone"` sandbox-ledger state with `sandboxAlive`/`sandboxCheckedAt` projected onto session summaries, and a LIVE column plus `--no-probe` flag for `sandbox list`.
- 48a1201: Worktree spawns now default to async provisioning, and label+cwd worktree collisions are refused instead of warned about. Provisioning spawns return immediately with status `"starting"` (resolved `cwd` backfilled when ready); `worktree: { async: false }` restores the old blocking contract, and `wait: true` falls back to the synchronous path by default (explicit `wait` + `async: true` remains rejected). A spawn landing in a worktree already occupied by a live session under the same label is refused — the sync path returns the existing session's descriptor (`dedupeSource: "worktree-cwd"`), the async path settles as a readable error — instead of forking a second live agent. `dedupeSource` gains the new `"worktree-cwd"` value.
- 79991e7: `app serve` now honours APP.md frontmatter `ui.path` when resolving the UI root (falling back to the legacy `.agentproto/ui/`), fails with a clear exit-2 error when the resolved UI root is missing, and sandbox app serves carry the in-box serve-log error text on `SessionAppServeInfo.message`. Adds exported `resolveAppUIRoot` (app-kit), `createAppServeRequestHandler` (cli), and `serveLogPath`/`extractServeError` (runtime).
- 2f57feb: Opt-in inbound sender attribution: new `displayName`/`surface` fields on `InboundMessage`, new exported `attributeInboundText` helper prefixing routed turns as `[Name · surface]`, HTTP `display_name`/`surface` pass-through with validation, and Telegram `from.first_name`/`username` extraction. 1:1 bindings keep receiving raw text.

### Patch Changes

- f81bd81: Gate /mcps/proxy/call and /mcps/imports mutating routes behind the per-boot token
- Updated dependencies [264c4c7]
- Updated dependencies [264c4c7]
- Updated dependencies [2125685]
- Updated dependencies [5c0acd2]
- Updated dependencies [d3f0e0d]
- Updated dependencies [79991e7]
  - @agentproto/app-kit@1.2.0
  - @agentproto/apps@0.10.0
  - @agentproto/sandbox@0.5.0

## 3.1.0

### Minor Changes

- 32b58b1: Add discoverable, configurable session events paths (sessions.eventsDir, descriptor.eventsPath)
- 2e1f93c: Wrap multi-line terminal_input in bracketed-paste markers when PTY paste mode is on
- 84a451d: Add web.search AIP-14 tool with Brave/Serper AIP-30 HTTP drivers
- d0cd06e: Add federated GET /brain/query HTTP route and agentproto brain query CLI command
- c809f12: Add optional model field to kind:agent workflow steps (same semantics as agent_start.model)
- 648e789: Add semantic config.installAdapters field to sandbox specs
- 2d87474: Add sandbox ledger + list/rm CLI and label/prefix reuse resolution
- 87a2814: feat: opt-in `env.autoPassthrough` on sandbox specs. `@agentproto/sandbox` declares the optional flag on `SandboxDefinition.env` (+ zod schema, default strictly absent); `@agentproto/runtime` implements it: when the flag is set and the spawn's host-side billing-credential resolution produced a credential, the credential's env-var NAME (its `setEnv`, e.g. `ANTHROPIC_API_KEY`) is injected into `spec.env.passthrough` before the sandbox box boots, so a fresh box inherits host auth without the caller naming vars. Only the name is injected — the value travels via the existing passthrough mechanism (host secrets broker → box env) and is never read, logged, or echoed by the flag. Billing credential only; explicit `env.passthrough` entries are unioned (deduped, caller entries kept). When no credential resolved — or the host process cannot resolve the var — nothing is injected and the spawn proceeds unchanged.

### Patch Changes

- d034471: Auto-install the spawned adapter into sandbox boxes' installPackages
- 834bfb8: Aligns runtime with the new sandbox pause-by-default teardown: updated the sandbox-reconnect regression test to assert that a plain ephemeral spawn (no `lifecycle`, no `reuse`) pauses on close, and refreshed the `lifecyclePolicy` docblock in `sandbox-agent-session-proxy.ts`. No exported surface change.
- f6561a5: Fix `session_restart` on a sandboxed agent session: re-attach the existing box via its provider `connect()` and re-spawn the adapter inside it, failing loud when the box is expired instead of spawning locally against a box cwd.
- Updated dependencies [bb3342f]
- Updated dependencies [b51f116]
- Updated dependencies [d034471]
- Updated dependencies [c809f12]
- Updated dependencies [648e789]
- Updated dependencies [87a2814]
- Updated dependencies [834bfb8]
- Updated dependencies [feffc34]
- Updated dependencies [b51f116]
  - @agentproto/model-catalog@0.9.4
  - @agentproto/app-client@0.3.2
  - @agentproto/sandbox@0.4.0
  - @agentproto/workflow-runtime@0.11.0
  - @agentproto/workflow@0.6.0
  - @agentproto/providers-store@0.3.13
  - @agentproto/app-kit@1.1.1
  - @agentproto/apps@0.9.3
  - @agentproto/workflow-loader@0.2.2
  - @agentproto/eval-reporters@0.2.12
  - @agentproto/telemetry-langfuse@0.2.10
  - @agentproto/workspace-brain@0.4.5

## 3.0.0

### Major Changes

- 4829b7a: Add terminal gate security feature that restricts `terminal_start` command execution through the same allowlist that gates `command_execute`. Introduces three-valued gate mode per workspace ("allowlist"/default, "all", or "off"), resolved from workspace config file or global `AGENTPROTO_TERMINAL_GATE` environment variable. Also exports new symbols: `loadTerminalGateMode`, `TerminalGateMode`, `TERMINAL_GATE_ENV`, and `DEFAULT_TERMINAL_GATE`. The `workspace` parameter is now required on `registerSessionTools` (all call sites updated).

### Minor Changes

- 3baa9b8: Migrate the five `pageParamsShape` tools in `agent-tools.ts` onto the AIP contract layer (`defineTool` + `implementTool` + `toMcpTool`) with the shared `paginated()`/`catchErrors()` transformers (ToolTransformer mission, PR-2 batch): `agent_sessions_list`, `adapter_list`, `catalog_models`, `catalog_provider_models`, `role_list`. All five are now COMPACT BY DEFAULT with a real per-item compact projection; `full: true` (or `compact: false`) returns the old verbose shape. Behavior changes: `adapter_list`'s former `summary: true` projection is the new default (param removed — `full: true` is the opt-out); `catalog_models`' default view is now the flattened per-route rows the paginated branch always used (compact fields only), not the nested vendor/product tree; `catalog_provider_models` drops the redundant `provider` echo (it equals the queried `endpoint`) and its default rows are compact (id/kind/label/route). Errors return the single canonical `{content, isError}` shape via `catchErrors()`.
- be91d9e: Additive limit/cursor pagination for the app/task/misc list tools: task_list, app_list, app_list_applied, app_data_list, app_external_list, role_list, adapter_list (plus a `full:true` alias for `summary:false`), auth_profile_list, harness_preset_list, browser_adapter_list, list_browsers, llm_endpoint_list_links, tunnel_list, worktree_status, session_queue_list, mcp_imported_list, mcp_discovered_list. Calls without limit/cursor are byte-identical to before.
- 543c35f: Migrate the app/task/tunnel batch of list tools onto the `ToolTransformer` mechanism (`defineTool` + `implementTool` + `toMcpTool` with `paginated`/`catchErrors`), replacing hand-rolled `pageParamsShape` handlers whose `compact`/`fields` params were silently ignored:

  - `tunnel_list`, `app_list`, `app_list_applied`, `task_list`, `app_data_list`, `app_external_list` now COMPACT by default via a real per-tool `project()` projection (`full: true` / `compact: false` returns the old verbose records), and `fields` is a per-item allowlist on the paginated branch. `app_data_list`/`app_external_list` entries are already minimal, so their projection is the identity — the win there is `fields` + the contract-layer registration. Error handling on all six is wrapped in `catchErrors()` (unexpected throws become the canonical MCP error result); tool-declared guard/error replies keep their exact legacy shapes.
  - Legacy default envelopes are preserved byte-for-byte: `tunnel_list` → `{tunnels}`, `task_list` → `{boardId, tasks}`, `app_data_list` → `{appId, dir, entries}`, `app_external_list` → `{appId, root, path, entries}`, `app_list`/`app_list_applied` → bare arrays. Pagination (limit/cursor, cursor semantics, maxLimit 200) is unchanged. Tools whose legacy default body isn't `paginated`'s `{items}` wrapper carry a small local `paginatedLegacyList` companion transformer (per file, alongside the plan-noted copy-pasted `textResult`/`errorResult` helpers); hand-rolled scoping logic elsewhere is untouched.

- de87f67: Compact JSON serialization for MCP tool responses (drop pretty-printing whitespace; payload shape unchanged).
- 61415c2: Compact-by-default tool output (MCP-pagination PR-10): `session_list` now
  returns a slim per-item projection by default (id/kind/name/label/status/
  pty/command/cwd/adapterSlug/model/busy/awaitingInput/blockedOn/
  lastActivityAt/startedAt/exitCode/depth/parentSessionId) — pass
  `full: true` or `compact: false` for the complete descriptor.
  `tool_calls_list` defaults to the result-preview posture (~500-char
  `result` truncation); `full: true` restores unfiltered records.
  `terminal_output` caps its read at the last 4096 bytes when `lastBytes`
  is omitted (explicit `lastBytes`, up to 65536, is unchanged). Additionally,
  the shared pagination envelope's `fields` param is now honored generically:
  every `paginate`/`toolText` list tool applies an explicit `fields`
  allowlist per item when supplied (previously accepted but ignored).
- eb85117: Migrate the second half of `orchestration-tools.ts`'s `pageParamsShape` list tools onto the `ToolTransformer` mechanism (`inbound_watcher_list`, `inbound_endpoint_list`, `cron_list`, `routine_list`): `defineTool` + `implementTool` + `toMcpTool` with the shared `paginated()` transformer (real per-tool compact projections, `full: true` escape hatch, `fields` allowlist, unchanged `limit`/`cursor` page semantics) and `catchErrors()` error normalization. Note: the non-paginated output of these four tools changes from a bare JSON array to a wrapped object (`watchers`/`endpoints`/`jobs`/`routines`).
- f500b2d: Migrate the first half of `orchestration-tools.ts`'s `pageParamsShape` list tools onto the `ToolTransformer` mechanism (`defineTool` + `implementTool` + `toMcpTool` + shared `paginated()`): `permissions_list`, `workflow_list`, `policy_list`, and `activities_list` now project COMPACT rows by default (real per-tool compact projections), return the full verbose records behind `full: true` / `compact: false`, honor `fields` on the page envelope, and keep the exact legacy default envelopes (`{permissions}`, bare arrays, `{activities, counts}`) and pagination cursor semantics. The same tools' handlers are wrapped in `catchErrors()` for one canonical error-result shape. Hand-rolled subtree-scoping logic is untouched.
- f500b2d: Complete ToolTransformer migration of remaining list tools: 25+ tools across agent-tools (agent_sessions_list, adapter_list, catalog_models, catalog_provider_models, role_list), app-tools (tunnel_list, app_list, app_list_applied, task_list, app_data_list, app_external_list), session-tools (terminal_sessions_list, command_list, mcp_discovered_list, mcp_imported_list, mcp_imported_tool_list, session_queue_list, worktree_status), and orchestration tiers (inbound_watcher_list, inbound_endpoint_list, cron_list). All tools now COMPACT BY DEFAULT with real per-item projections; `full: true` / `compact: false` restores verbose records. Pagination, field filtering, and consistent error handling via the shared paginated()/catchErrors() transformers. Legacy envelope shapes preserved for backward compatibility.
- bf5cef3: Implement AIP-15 rule 7: durable suspend points in workflows. A `kind: "suspend"` step now parks its run as "awaiting-input" with a persisted `awaitingSuspend` record, enabling resumption through external events via `workflow_escalation_resolve`'s suspend form. Runs survive daemon restarts; resumption after restart is explicit and marked failed with a clear reason.

  New event types: `workflow:suspended` and `workflow:suspend-resumed`. New method: `WorkflowRunner.resumeSuspend()`. New optional field: `WorkflowRun.awaitingSuspend`.

- f597d0b: Migrate the remaining `session-tools.ts` list tools onto the `ToolTransformer`
  mechanism (`paginated()` + `catchErrors()`): `terminal_sessions_list`,
  `command_list`, `mcp_discovered_list`, `mcp_imported_list`,
  `mcp_imported_tool_list`, `session_queue_list`, and `worktree_status`.

  Each tool now returns a COMPACT projection by default (identity/routing fields
  - small scalars); `full: true` / `compact: false` restores the complete
    per-item record and `fields` allowlists per-item keys. Tool-visible behavior
    changes:
  * `mcp_imported_tool_list`: the bespoke `compact`/`schema` params are replaced
    by the shared `compact`/`full`/`fields` params (`full: true` keeps the
    upstream `inputSchema`); the `alias` echo is no longer repeated in the
    response body.
  * `mcp_imported_list`: the top-level `version` field is no longer echoed in
    the default (non-paginated) response.
  * `session_queue_list`: the `sessionId` echo is no longer repeated in the
    default response; `queuedAt` moves behind `full: true`.
  * Error results across these tools collapse onto the canonical
    `{content:[{type:"text"}], isError}` shape (previously a mix of JSON
    `{error}` bodies and plain text).

  Each tool's `project()` function is required by the `paginated()` transformer,
  so there is no code path that accepts `compact` without implementing it.

- 7801cfe: `session_tree`: add navigable `nodeId` + `direction` params (`children` / `parent` / `siblings` / `ancestors` / `descendants`) with an optional `depth` level cap, returning a single slice of the session tree instead of the full dump. Omitting both keeps today's full-tree/`byOrigin` behavior unchanged; passing only one of the two is a validation error, and an unknown `nodeId` returns a clear error.
- e6b77a1: Migrate the remaining misc list tools onto the `ToolTransformer` mechanism (`paginated()` + `catchErrors()` at registration instead of hand-rolled per-handler logic): `auth_profile_list`, `llm_endpoint_list_links`, `harness_preset_list`, `browser_adapter_list`, and `list_browsers`.

  Every migrated tool now has a real compact projection behind the previously dead `compact`/`full`/`fields` params:

  - `auth_profile_list` — compact rows drop `costBudget` (enforced daemon-side, never read by listing callers); `full: true` restores it.
  - `llm_endpoint_list_links` — default rows keep the documented picker shape (`{provider, linkedProfile, eligible: [{id, label, method, endpoint}]}`); `full: true` additionally surfaces each eligible profile's remaining non-secret metadata. The legacy top-level `{ links, upstreams }` envelope is preserved (a `withLinksMap` composition transformer derives the map from the rows, which already carry `linkedProfile`).
  - `harness_preset_list` — rows are pinned to the documented preset shape by an explicit allowlist.
  - `browser_adapter_list` — compact rows are `{id, name, defaultPort, location?}`; the prose `description` and `install`/`config` manifest arrays move behind `full: true`. Default output changed from a bare array to `{ adapters: [...] }`.
  - `list_browsers` — compact rows are the browser identity/routing fields of the session descriptor; `full: true` returns the full descriptors. Default output changed from a bare array to `{ browsers: [...] }`.

  Error handling on the migrated tools is normalized by `catchErrors()` (any thrown error becomes the canonical `{content, isError}` text result). Page-walk pagination (`limit`/`cursor` → `{items, nextCursor?, total}`) is unchanged.

### Patch Changes

- 54c7c76: Enable transcript export for command sessions. Command sessions now export as proper assistant tool-call + tool-result messages instead of empty transcripts. Adds kind-less CommandLogEntry detection and rendering logic, title fallback chain (label > command > default), and explicit tool-call-record skipping to prevent double-counting.
- 2340e23: Fix backward compatibility for legacy persisted supervisor state that predates the fan-in (WP6) feature. Daemon reloads with old policies lacking `sessionIds` and `pending` fields now normalize gracefully instead of crashing. Additionally, per-owner projection errors are now caught and logged, preventing a single malformed owner from taking down the entire Activity read-model.
- 7bb3079: Record parentSessionId and depth on command sessions so they nest correctly in session_tree alongside PTY and agent sessions.
- 1f12336: Add structured event streaming support to sandbox proxy via `/sessions/:id/events/stream` SSE endpoint, preserving tool-call and usage_update fidelity end-to-end. Falls back gracefully to legacy flattened-text poll behavior for older or unreachable box daemons.
- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- e30094e: Add `registerBuiltinTool` to `@agentproto/mcp-server` and retrofit the daemon's migrated builtin MCP tools (agent/app/task/session/orchestration/browser/llm-endpoint/auth/tunnel lists) onto it, collapsing the repeated defineTool + implementTool + defineDriver + toMcpTool boilerplate. Pure refactor — registered tool ids, schemas, transformers, and behavior are unchanged.
- cfb9790: `session_events_poll` now applies WP6 subtree scoping: a scoped child orchestrator polling events only sees lifecycle events for sessions within its own subtree (previously it could observe turn-end/awaiting-input/exited/permission events for sessions outside it). Root/operator callers (no scope) see unchanged output.
- 20ef731: ToolTransformer composition mechanism on the AIP-14 contract layer, proven end-to-end on `session_list`:

  - `@agentproto/tool`: new `ToolTransformer` type (optional `wrapShape`, required `wrapHandler`) + optional `transformers` field on `ToolDefinition`/`ToolHandle`; concrete `paginated({ project, keyOf?, maxLimit?, itemKey? })` and `catchErrors()` transformers; the shared pagination primitives (`paginate`, `pageParamsShape`, `toolText`, cursors) moved from `@agentproto/runtime`'s `tool-envelope.ts` to `@agentproto/tool` (runtime re-exports them verbatim) so the transformer reuses the exact cursor/limit semantics.
  - `@agentproto/mcp-server`: `toMcpTool`/`buildMcpTool` apply `tool.transformers` (or a `transformers` option, which overrides) to the shape/handler at registration, composed left-to-right in declared order (first declared = outermost wrapper); transformers may terminate the pipeline with a pre-serialized MCP text result, which passes through verbatim.
  - `@agentproto/runtime`: `session_list` migrated from raw `server.tool(...)` to `defineTool` + `implementTool` + `toMcpTool` with the `paginated()` transformer (reusing `compactSessionItem` as the required compact projection). Registration-mechanism change only — observable behavior (compact default, `full:true`/`compact:false` escape hatch, `fields` allowlist, pagination envelope, legacy `{sessions:[...]}` wrapper without limit/cursor) is unchanged; the existing PR-2/PR-10 parity tests pass untouched.

- Updated dependencies [b70149b]
- Updated dependencies [66f73d9]
- Updated dependencies [81752fa]
- Updated dependencies [2f37e7b]
- Updated dependencies [e30094e]
- Updated dependencies [20ef731]
  - @agentproto/model-catalog@0.9.3
  - @agentproto/app-kit@1.1.0
  - @agentproto/workflow@0.5.0
  - @agentproto/app-client@0.3.1
  - @agentproto/apps@0.9.2
  - @agentproto/acp@0.8.1
  - @agentproto/agent@0.2.3
  - @agentproto/auth@1.0.2
  - @agentproto/command-sandbox@0.2.1
  - @agentproto/driver-agent-cli@2.4.2
  - @agentproto/driver@0.2.2
  - @agentproto/eval-reporters@0.2.11
  - @agentproto/manifest@0.2.2
  - @agentproto/mcp-server@0.3.0
  - @agentproto/provider-kit@0.4.3
  - @agentproto/provider-presets@0.6.2
  - @agentproto/providers-store@0.3.12
  - @agentproto/redaction@0.2.2
  - @agentproto/routine@0.2.2
  - @agentproto/sandbox@0.3.1
  - @agentproto/secrets@0.2.5
  - @agentproto/telemetry-langfuse@0.2.9
  - @agentproto/tool@0.3.0
  - @agentproto/workflow-loader@0.2.1
  - @agentproto/workflow-runtime@0.10.1
  - @agentproto/workspace-brain@0.4.4

## 2.12.0

### Minor Changes

- a939171: Additive `limit`/`cursor` pagination for the `catalog_models` and `catalog_provider_models` MCP tools: passing either param returns the shared `{ items, nextCursor?, total }` envelope over the filtered route/model array (cursor offset = position in the filtered array); omitting both keeps the byte-identical whole-catalog response.
- dc7729b: Additive MCP pagination/tree params (PR-6): `mcp_imported_tool_list` gains `compact`/`schema` projections and `limit`/`cursor` paging (max 200) over the tool array; `session_tree` gains `groupByOrigin:false` to suppress the `byOrigin` companion view; `session_events_poll` accepts a forward-compat `full` flag. All defaults unchanged — omitting the new params returns today's byte-identical output.
- 69a25bd: Additive `limit`/`cursor` pagination (via `paginate` + `toolText`) to the orchestration list tools — `permissions_list`, `policy_list`, `workflow_list`, `activities_list`, `cron_list`, `routine_list`, `inbound_endpoint_list`, `inbound_watcher_list` — applied last, after all scoping and filters. Output is byte-identical to before when neither param is supplied.
- 0012980: feat(permissions): thread plan \_meta through the hold path and add free-text feedback on the respond path

  Adds `feedback?: string` to permission resolutions, enabling users to attach contextual information when approving or denying held tool-permission requests. The feature threads through all layers: types export `ACP_META_FEEDBACK` constant for the `_meta` key convention, ACP client carries `_meta` through to agent-prompt events, runtime forwards feedback on outcomes, and mastra-agent adapter folds feedback into suspension resumeData. CLI gains `--feedback` flag on approve/deny commands and renders plan text from suspension payloads. All changes are backward compatible.

- d315c0a: Add app-scoped state ledger (app_state_append/get/list) with stage-board fold
- a48dc03: Implement AIP-15 P2 (harness pinning) and P3 (declarative gate steps).

  **P2 Changes:**
  - Add `AgentHarness` interface for spawn-time control (model, effort, role, tools, skills, cwd, promptFile)
  - Thread harness fields through agent session spawn paths (host and sandbox)
  - Emit `session:harness-warning` events when unsupported harness fields (tools, role) are encountered
  - Load `harness.promptFile` at workflow-load time and record sha256 for audit

  **P3 Changes:**
  - Add `GateStep` interface for shell-command checks (command, args, cwd, report, retry, on_fail)
  - Implement gate step execution with exit-code semantics, report parsing (JSON from stdout or file), and retry logic
  - Add exponential/fixed backoff retry strategy with reprompt-and-retry linking to prior agent steps
  - Emit `workflow:gate-report` events on every command attempt (not just final outcome)

  All changes maintain backward compatibility (optional fields, new types only, no removals).

- db90fb3: Implement port exposure for sandboxes. Add `expose(port)` method and `ports` map to `BootedSandbox` to enable agents to expose HTTP server ports inside sandboxes as publicly accessible URLs. Support pre-declaring ports via `extraPorts` in the sandbox spec for eager resolution at boot time. E2B provider implements port exposure via `sandbox.getHost(port)`. Surface exposed ports in `SessionDescriptor` and `SessionSummary` via new `sandboxPorts` field.
- f6593d4: Add structured-question support. Sessions awaiting a structured question (e.g., context-continuity's continue-fresh/keep-going prompt) now display question text and clickable option buttons in a dedicated banner. Answer dispatch is wired into all prompt-turn seams (sendPrompt, enqueuePrompt, dispatchQueuedPrompt), intercepting exact option matches (case-insensitive) and routing them to their registered handlers. Unmatched prompts fall through to normal turn execution, preserving fallback behavior for unsupported or conversational replies. Context-continuity ask mode now tracks the acknowledgment percentage to suppress re-asking until context grows further. Desktop shell renders the QuestionBanner above the composer and displays question hints in the session rail with full text in tooltip.
- aff7794: Add `@agentproto/app-client/runner-select` — a shared harness+model selector for app UIs that discovers installed harnesses via `adapter_list` + `harness_preset_list`, eliminating per-app picker implementations. Automatically injected into every app UI alongside the McpApp bridge. Supporting changes: `adapter_list` summary mode for lightweight UI projections, harness preset profile status enrichment (disabled/missing flags), early validation of default preset profiles during spawn, and discovery tool allowlisting for all app UIs.
- 3a928c1: feat(sandbox): forward config-default wallets to sandbox spawns

  Sandboxed agent spawns can now use credentials configured in `defaults.adapters.<slug>.auth`. The host resolves the configured wallet and forwards it to the sandbox, ensuring the box bills on the same credential the host would use. Unconfigured sandboxes remain credential-free, and error handling clearly distinguishes between access profile and config-default wallet resolution failures.

  Adds `explicitConfig` boolean to `ResolvedSpawnAuthMaterial` to track whether auth came from config vs per-spawn request, enabling proper boundary enforcement and credential forwarding logic.

- 9a489e7: Additive output-shaping params for `tool_calls_list` (`fields` projection, `full` legacy escape hatch, `result`-preview helper disabled by default) and a `truncated` companion flag on `terminal_output` when a `lastBytes` window is applied. No default behaviour changes.
- ce273d2: Additive read pagination: `file_read` gains offset/limit (lines for utf8, bytes for base64) plus a truncated flag, `directory_list` gains limit/cursor paging, and `conversation_read` gains lastN/cursor transcript windowing — all defaults unchanged.
- c71753a: Add `agent_start.appServe`: with `sandbox`, the daemon installs the app on the box (the box daemon's `app_install`), launches `agentproto app serve --host 0.0.0.0 --port <port>` detached through the box's `command_execute` (seeding the box command allowlist), and stamps the public URL on the descriptor/result; `SandboxAgentSessionHost` now carries `mcpUrl` so callers can drive the box's other daemon tools.
- 3a928c1: Propagate the config-default wallet into sandbox spawns: when `defaults.adapters.<slug>.auth` names a wallet, the host now resolves its credential and forwards it to the box daemon so the sandboxed child session bills the same wallet, and the host descriptor echoes the forwarded wallet for UIs.
- f295874: Additive pagination for the session list tools: `session_list`, `agent_sessions_list`, `terminal_sessions_list` and `command_list` accept `limit`/`cursor` (plus `full`, currently a no-op) and return a `{ items, nextCursor?, total }` envelope when either is supplied. Without `limit`/`cursor` the output is unchanged.
- a04bd29: Workflow `kind: "approval"` steps are now resolved by a human instead of silently auto-approving. A declarative approval step parks the run as `awaiting-approval` with an `awaitingApproval` inbox record (visible in `workflow_status`), emits `workflow:approval-requested`/`workflow:approval-resolved` session events, and waits for a decision through `workflow_escalation_resolve`'s new approval form (`approvalId` + `approved` + `who` + optional `note`) — also exposed as `WorkflowRunner.resolveApproval`. The decision is appended to the app state ledger (`kind: "approval"`, `by: "human"`); a step `timeout_ms` resolves as rejected with `who: "timeout"`; a run parked awaiting approval survives a daemon restart (the pending item is re-registered, exactly one ledger event). `app_status` surfaces `awaitingApprovals[]` across the app's runs.
- fe9a374: Bridge workflow runs to the app state ledger: a run started on behalf of an installed app (workflow id owned by exactly one installed app, or explicit `appId`/`appRunId`) now appends `stage-started` / `gate-report` / `stage-done` / `blocked` events with `by: "runner"` to that app's `<dataDir>/state/events.jsonl`, so an app's stage board (`app_state_get`) is written by the runner instead of staying empty. Appends are serialized, best-effort, and never fail the run. An optional `item` on the run stamps every ledger event to one sub-key inside each stage.

  Also: `kind: "gate"` step args now resolve per-run — `$…` reference strings expand against the run bindings (`$$…` stays a literal `$`; a ref that resolves to nothing throws naming the step and the arg), so a manifest gate no longer receives literal `"$input.x"` strings as arguments.

### Patch Changes

- a581e76: Deflake the `session-blocked-on` transcript assertions: wait for the
  `turn-end` record to land in `events.jsonl` instead of sleeping a fixed
  50 ms, which raced the write-stream open on slower CI runners (ENOENT).
- f9e21fd: AIP-15 P2: `harness.knowledge[]` on `kind: "agent"` steps. A selector pins an AIP-10 corpus workspace (relative paths resolve against the WORKFLOW.md dir at load time; a missing workspace fails the load), `anyOf`/`allOf` tag filters, refined `kinds`, a `maxEntries` cap (default 50, slug-ascending deterministic order) and v1 `mode: "files"`. Before an agent step's spawn, the runtime resolves each selector with the corpus `resolveKnowledge`, writes the matched raw entries to `<stepCwd>/.knowledge/<workspaceBasename>/<slug>.md` plus a deterministic `INDEX.md`, prepends a prompt note pointing at the index, and records `knowledgeApplied: { workspace, matched, written }[]` on the step's run record. An empty match is not an error — it is recorded and emitted as a `session:harness-warning` (`knowledge-empty`). `resolveKnowledge`'s signature is unchanged; the new `filterEntriesByAllOf` helper beside it provides the AND-semantics post-filter.
- 2498d05: Strip bare carriage returns in stripAnsi to fix terminal output garbling
- ee15252: Fix session exit code classification to correctly handle node-pty's `{ exitCode: 0, signal: 0 }` clean-exit shape — `signal: 0` was being misclassified as "a signal fired" instead of "no signal."

  Add row disclosure triangles to the VS Code webview sessions list, enabling collapse/expand of nested subagent hierarchies. Collapsed rows show the busiest descendant status in their dot indicator.

- 672fc7c: Honor AGENT.md frontmatter model for the default mastra-agent app_run path
- 5328e9b: Introduce template version management system for agentproto-workstation e2b template. Establishes `templates/workstation/versions.json` as the canonical pin declaration (CLI, adapters, runtime, base image) and introduces `scripts/sync-templates.mjs` to regenerate all derived artifacts. Enhances `@agentproto/sandbox-e2b` provider with `resolveUpdateCli()` function to intelligently skip the on-boot CLI install when a template's recorded baked image provably carries the requested CLI version—defaulting conservatively to install when the bake is unproven, maintaining backward compatibility.
- f17e3a0: Fix cost refresh on empty turns. Some adapters (e.g., OpenRouter-routed opencode) settle their adapter-reported cost on trailing no-op turns carrying no assistant text or tool calls. On such turns, PR discovery lanes are correctly skipped (no new PR opened), but cost refresh must still run to re-render the footer once spend becomes known. Previously, cost refresh was entirely skipped on empty turns, leaving a session whose PR-creating turn stamped a footer with no cost amount to go unstamped forever if all later turns remained empty or if the session never exited.
- 55c8154: Fix PR provenance recording for shim-stamped footers: recognize and upgrade own-session footers from the `gh` PATH shim, enabling cost-refresh to find and enrich PRs opened via every adapter's wrapped `gh` subprocess.
- d190202: Fix regression: stamp sandboxPorts on session descriptors. The SpawnAgentInput interface was missing the sandboxPorts field, causing the port-to-URL map from booted sandboxes to be silently dropped when building session descriptors. Now properly threaded through both descriptor creation paths.
- 49a89ba: Fix sandbox spec field forwarding in HTTP path and prevent VM leaks on boot/reconnect failures.

  **@agentproto/runtime**: Fixed #1150 regression where `POST /sessions/agent` silently dropped `extraPorts`, `env`, `lifecycle`, and other fields from inline sandbox specs. Extracted shared schema `sandboxSpecWithReuseSchema` to ensure both HTTP and MCP paths validate against identical schema and forward all fields.

  **@agentproto/sandbox-e2b**: Centralized sandbox cleanup on boot/reconnect failure to prevent VM leaks (observed live: six boxes left running without sessions). Added fast-fail mechanism that exits immediately when daemon crashes during boot, surfacing captured stderr for diagnostics, instead of blocking the full readiness timeout.

- f75ef5d: Add token usage tracking for OpenCode adapter sessions via readOpenCodeUsage hook. OpenCode's live ACP usage_update event only carries cost (no token fields), so the new function reads token data from OpenCode's sqlite store and is wired into the registry's turn-end path to fill in missing tokensIn/tokensOut fields, mirroring the existing hermes adapter pattern.
- bf87d9e: Add internal paginated tool envelope helper (tool-envelope.ts), not yet wired to any tool.
- Updated dependencies [692d659]
- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [4d01e5c]
- Updated dependencies [d66ffe3]
- Updated dependencies [0012980]
- Updated dependencies [a48dc03]
- Updated dependencies [db90fb3]
- Updated dependencies [aff7794]
- Updated dependencies [1cd0220]
- Updated dependencies [6bfb633]
- Updated dependencies [ece3cae]
- Updated dependencies [c71753a]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/model-catalog@0.9.2
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/workflow@0.4.0
  - @agentproto/workflow-loader@0.2.0
  - @agentproto/app-kit@1.0.0
  - @agentproto/acp@0.8.0
  - @agentproto/sandbox@0.3.0
  - @agentproto/app-client@0.3.0
  - @agentproto/providers-store@0.3.11
  - @agentproto/apps@0.9.1
  - @agentproto/workspace-brain@0.4.3
  - @agentproto/driver-agent-cli@2.4.1
  - @agentproto/mcp-server@0.2.7
  - @agentproto/agent@0.2.2
  - @agentproto/auth@1.0.1
  - @agentproto/command-sandbox@0.2.0
  - @agentproto/driver@0.2.1
  - @agentproto/eval-reporters@0.2.10
  - @agentproto/manifest@0.2.1
  - @agentproto/provider-kit@0.4.2
  - @agentproto/provider-presets@0.6.1
  - @agentproto/redaction@0.2.1
  - @agentproto/routine@0.2.1
  - @agentproto/secrets@0.2.4
  - @agentproto/telemetry-langfuse@0.2.8
  - @agentproto/tool@0.2.2

## 2.11.0

### Minor Changes

- 1541277: Add `extractToolResultSessionId()` utility to extract and validate session identifiers from tool result payloads, supporting both `agent_start` descriptors (id field) and `live_session` results (sessionId field). This enables proper session pinning in the live-session widget to display the session spawned by a tool call rather than auto-discovering the newest session.
- 8215419: Give installed apps a data directory distinct from their source directory. The `app_data_*` plane now anchors to `InstalledApp.dataDir` (default `<dir>/data`) rather than the app's `dir`. Custom data directories are set with `app_install {dataDir}` / `agentproto app install --data-dir`, or hinted by APP.md `data: { dir }`. Full backward compatibility: pre-dataDir files under `<appDir>` are still found via fallback; under the default layout the legacy `data/` spelling is collapsed so existing paths continue to work.
- dcb0bc5: P7 deliverables 1 & 2: Generic daemon MCP tool proxy and multi-adapter app_run support.

  Deliverable 1 closes the gap where app agents couldn't reach daemon tools outside a hand-curated set: a new daemon MCP tool proxy discovers and proxies any `tools/list`-exposed tool an AGENT.md declares, with automatic `appId` injection for `app_*` tools so models never need to know their own app id.

  Deliverable 2 extends `app_run` to support adapters that declare no `agent` option (claude-code, hermes, codex, ...): the spawn is now built FROM the AGENT.md (frontmatter model + body-as-prompt) instead of pointed at a path, with backward compatibility for mastra-agent (which still gets the path-based behavior).

### Patch Changes

- 5171a24: Add logging to dedupe hits in `spawnAgentSession` to improve observability. When an idempotency key hit occurs, the runtime now logs a warning message that includes the returned session ID, spawn context (adapter, cwd), and label if provided. This helps diagnose cases where a repeated `agent_start` call returns an existing session.
- e655351: Support UI-only apps in app-kit; move builtin daemon panels into @agentproto/apps
- 2fc4c69: Sandboxed sessions now report their spend, and PR footers pick it up.
  - `HarnessClient.usage(sessionId)` (`session_usage`) and an optional `usage` on
    `DaemonAgentSessionHost`. The runtime's sandbox spawn wires it as the session's
    `readUsage` hook, so a box's cost/tokens/model reach the HOST descriptor at
    every turn-end — the proxy's text stream never carried them, which is why the
    CI review footer showed no amount and no model for e2b-sandboxed `claude-sdk`
    reviews.
  - `readUsage` may now return `model`; a descriptor spawned without one adopts it.
  - PR-body footer cost refresh: a PR opened through the daemon is stamped the
    instant `gh pr create` returns — mid-turn, before a claude-code/claude-sdk
    session has reported any cost. The provenance reconciler now re-renders each
    recorded PR's footer once the session knows its spend (`replaceProvenanceFooter`,
    `stampFooterOnPr({ refresh: true })`), exactly once per PR.

- Updated dependencies [11b5564]
- Updated dependencies [8215419]
- Updated dependencies [e655351]
  - @agentproto/workflow-runtime@0.9.0
  - @agentproto/apps@0.9.0
  - @agentproto/app-kit@0.8.0
  - @agentproto/workspace-brain@0.4.2
  - @agentproto/sandbox@0.2.6
  - @agentproto/eval-reporters@0.2.9
  - @agentproto/telemetry-langfuse@0.2.7

## 2.10.1

### Patch Changes

- 47653e3: Fix: re-add router prefix for modelDerivedApiKey adapters billed through gateways. Resolves production bug where adapters like opencode receive models without the router prefix when using gateway routes, causing 404s at the ACP boundary. The fix ensures adapters that derive their API key from the wire model's leading segment (opencode, mastracode, jcode, pi, mastra-agent) receive the properly prefixed model ID.
- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1
  - @agentproto/providers-store@0.3.10

## 2.10.0

### Minor Changes

- 77ca7ff: Resolve media_upload_local file contents client-side before proxying
- 4fa1a02: Surface `addedAt` ISO date field on `CatalogProviderModel` interface to expose model introduction timestamps in provider model enumeration, enabling "new" badges in catalog pickers.
- d663b35: Refactor live-session widget timeline rendering: move usage updates from rows to state, add incremental DOM patching, and support compact display mode.

  **WP1**: Usage snapshot (`usage_update` record) now stores in `TimelineState.usage` instead of appending a row. Last-write-wins semantics; usage is displayed in the header chip, not the timeline.

  **WP2**: New `isNearBottom()` helper determines auto-scroll — captured BEFORE DOM mutation to preserve read position when user scrolls up, show "new messages" pill otherwise.

  **WP3/WP4**: Compact display mode (inline or <640px viewport) collapses the tree into a `<select>` dropdown and groups consecutive tool calls (≥2) into collapsible `<details>` sections.

  **WP5**: Header summary line surfaces status dot, tool count, usage chip (from state), and elapsed time, refreshed every 1s during active sessions.

  Incremental DOM patching: text-delta patches the last row's text node in place; other records append via `insertAdjacentHTML`; full rebuilds only on session start/focus change/mode flip.

- 12bb9e8: Add support for tracking model switches sent as ordinary prompts. Introduces an optional `activeModel` field to `SessionDescriptor` that captures the model believed to be running after a live switch, distinct from `model` (the requested/spawn-time value). The daemon learns switches from two paths: (1) a successful `setModel` call (verified, mirrors `model`), or (2) a `/model <id>` command sent as a plain conversational prompt followed by an adapter acknowledgement (unverified, advisory only — for UI display, never billing). Exports `isModelSwitchAcknowledgement()` and `parseModelSwitchCommand()` from agent-cli for reuse across both paths. VS Code's composer chip now renders "requested → active" when they diverge.

### Patch Changes

- 7a96351: Fix curation drift on `mode: "allow"` auth profiles: an allowlist generated once at create/import time was a frozen snapshot of the catalog that day — new models the catalog picked up later never became usable through the profile, and retired ones lingered forever, with nothing surfacing the mismatch. Adds an explicit, opt-in re-sync: `refreshAuthProfileModels` (`@agentproto/auth`) recomputes a profile's `ids` against a caller-supplied current-catalog snapshot, exposed as the `auth_profile_refresh_models` MCP tool and the `agentproto auth profile refresh-models <id>` CLI verb. Nothing calls this automatically — a profile is only touched when refreshed by name — and it rejects a `mode: "all"` profile outright, since that mode already tracks the live catalog on every read.
- f5b462a: Add test coverage for `auth profile refresh-models` CLI command and `auth_profile_refresh_models` MCP tool. Both test suites verify the happy path (successful refresh against the current model catalog) and error handling (unknown profile id).
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

- 728205b: Fix PR deduplication after force-pushes by extracting commit SHA from the provenance footer instead of relying on GitHub's API `commit_id` field, which drifts during branch mutations. Store full 40-character SHA in footer for unambiguous tracking.
- Updated dependencies [7a96351]
- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/auth@1.0.1
  - @agentproto/model-catalog@0.9.0
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/acp@0.7.3
  - @agentproto/agent@0.2.2
  - @agentproto/driver@0.2.1
  - @agentproto/eval-reporters@0.2.8
  - @agentproto/mcp-server@0.2.6
  - @agentproto/provider-kit@0.4.2
  - @agentproto/routine@0.2.1
  - @agentproto/sandbox@0.2.5
  - @agentproto/secrets@0.2.4
  - @agentproto/tool@0.2.2
  - @agentproto/workflow@0.3.1
  - @agentproto/workflow-loader@0.1.5
  - @agentproto/workflow-runtime@0.8.1
  - @agentproto/workspace-brain@0.4.1
  - @agentproto/providers-store@0.3.9
  - @agentproto/app-kit@0.7.1
  - @agentproto/telemetry-langfuse@0.2.6

## 2.9.0

### Minor Changes

- 0097d36: Add a new opt-in, read-only external filesystem plane for installed apps: an app can declare `externalReadRoots` (a manifest field on `AppDefinition`/`AppHandle`/`AppFrontmatter`/`InstalledApp`) to be granted read access to a real host folder outside the daemon's sandbox — e.g. a user's actual `~/Downloads/applications` — without touching the existing app-data (app-owned dir) or fs-tools (workspace-root) planes.

  Each root is `~`-expanded, resolved absolute, and validated to exist as a real directory at install time (`app_install`/`app_apply` fail fast otherwise). Two new MCP tools (`app_external_list`, `app_external_read`) and a new `GET /apps/:appId/external-blob?root=&path=` HTTP route read from a granted root only when the caller's `root` argument is an exact match — no prefix/fuzzy matching. `app_external_read` serves only an allowlist of text-ish extensions under a 2MB cap; binary content (PDFs, images, …) streams through the HTTP route instead. There is no write or delete tool for these roots anywhere in the daemon.

- 88134e9: Signal sources ingested with a stale pipeline version. Introduces `PIPELINE_VERSION` constant and `isStaleRecord()` helper to detect when ingested data was produced by an older version of the chunking/processing logic. When `ingestPending()` completes, it now reports `staleSources` (count of records behind the current pipeline version) and `currentPipelineVersion`. The new optional `reindexStale` parameter to `ingestPending()` forces re-ingestion of stale sources. Updated `workspace_brain_status` and `workspace_brain_ingest` tool descriptions to explain the new `staleSources` signal.
- 557c4d0: Add adapter-capability spawn guard to prevent spawning with models the adapter doesn't support on a resolved route.

  The bug: a supervisor spawned `agent_start({adapter:"claude-code", model:"openrouter/deepseek/deepseek-v4-flash-0731"})` with no explicit `route.gateway`. The money-safety wallet guard (checkModelWalletEligibility) passed — openrouter genuinely bills that model. But claude-code's own manifest never curates that specific model on that route; its ACP wrapper validates against its own live selector and rejects anything it doesn't recognize. The upstream 404 reached the driver, leaving 0 tool calls.

  The fix: before spawn and restart, check whether the adapter is among the resolved (vendor, product, route) row's adapters in the catalog. Reuses the exact same `buildCatalogModels` join `catalog_models` reports — never a parallel per-model table. Optional dependency: skipped when `listCatalogModels` isn't wired, preserving pre-guard behavior.

  Adds:
  - `checkModelAdapterEligibility` predicate function
  - `modelAdapterIncompatibleMessage` message formatter
  - `ModelAdapterEligibility` result interface
  - New error code `model_adapter_incompatible` on spawn/restart failures

- 007716f: Add two new chat streaming routes (`POST /sessions/:id/chat` and `POST /sessions/chat`) that map daemon transcript records into Vercel AI SDK v6 UIMessageChunk SSE format. Includes a pure record→chunk mapper with canonical fixture conformity tests, two-phase validation for existing sessions, and refactored shared spawn logic to prevent route surface drift.
- 34bbf65: Extract release-check logic from VS Code into `@agentproto/runtime` for code sharing with the CLI. Add `daemon status` release indicator and VS Code update-prompt command with tarball/workspace-specific behaviors.
- 7d39ce7: Add daemon-side AGENTS.md resolution and injection (WP-R2) + role disposition SYSTEM preamble tagging (WP-R3). The daemon now resolves the nearest AGENTS.md walking up from a session's cwd (bounded by git toplevel), injects it into the initial prompt (inline for small files, pointer for large ones), and stamps the resolution on the descriptor. Role disposition text has been clarified and is now recorded separately as a SYSTEM preamble in transcripts (along with lineage and AGENTS.md pointer), allowing UIs to fold synthesized text instead of rendering it as user bubbles. Includes configurable inline/pointer threshold via config, dependency-injected fs for testability, and comprehensive unit + integration test coverage.
- f90a383: Add queue management commands and MCP tools for prompt FIFO inspection and control.

  Introduces `agentproto sessions queue <id>` CLI command with flags `--force`, `--deliver`, `--drop` to inspect and manipulate queued prompts after enqueue. Adds four new MCP tools (`session_queue_list`, `session_queue_promote`, `session_queue_deliver`, `session_queue_drop`) with the same semantics. HTTP routes mirror the MCP surface.

  New public exports: `previewPrompt()`, `promptOriginLabel()`, `QueuedPromptView` interface from @agentproto/runtime for after-the-fact queue UI. Origin tracking distinguishes user-initiated queuing from agent/child-sourced prompts. Queue badge ("N queued") shown in CLI and VS Code session listings.

  All three operations are deliberately distinct: promote reorders without interrupting; deliver interrupts and dispatches immediately; drop removes without delivering.

- 11982fd: Introduce shared dashboard presence classifier (`presenceFor`) to unify session-status rendering across CLI and VS Code. Previously, the CLI sessions table and VS Code tree/webview each derived their own inconsistent status readings. The new four-state model (running/tending/attention/quiet) is driven by a pure, config-aware classifier in @agentproto/runtime, consumed identically by both clients. Fixes status divergence and adds grace-window config (`sessions.attentionDelaySec`, default 60s).
- 9191286: Implement WP-R4: per-workspace RULES.md injection. Enables workspace supervisors to define standing rules that automatically inject into every agent spawn in the workspace, carrying workspace-wide discipline like "main checkout untouchable", "PR-only never merge", "no AI attribution" without needing to hand-type them into every brief. Rules are read from the workspace's state bucket and injected ahead of the role disposition to establish the fundamental layer before role-specific behavior.
- 9953527: Add ground-truth cross-check for judge gates: when a judge gate runs on a session that has already had a machine gate (shell or cost) execute, the judge's prompt now includes the machine gate's actual exit code and output. This prevents judges from rendering verdicts that contradict already-computed results. Includes `kind` discriminator on `PolicyRunState.lastGate` to distinguish shell/cost/judge gates.

### Patch Changes

- dfb41f6: Carry `::agentproto-artifact::` ledger markers through the session ring buffer. The tool-result summarizer collapses multi-line tool output to one lossy line ("N lines, XB"), which destroyed the artifact-ledger marker the CI delivery helper prints — `driver: artifacts=[]` on every agentflow run, so the review provenance stamp always degraded to sha discovery (and PR #1054's review lost its footer entirely when a network blip killed the job before the fallback could run). Marker lines are now re-emitted verbatim under a `[tool-artifact]` prefix: raw `agent_output` keeps them harvestable (and JSON-parseable — no ANSI wrapping), while clean mode still strips them from human-facing output.
- 76f2c78: Multi-surface external subscriptions — one adapter can now declare BOTH a Claude and a ChatGPT native OAuth login, so mastracode/opencode's subscription eligibility no longer forces an anthropic-or-openai choice. `authSubscription` accepts a single surface (unchanged) OR an array of surfaces, one per billing provider; two entries claiming the same provider scope (or two unscoped entries) are rejected at manifest-validation time rather than resolved arbitrarily at spawn time. The runtime's old `subscriptionAppliesTo` boolean predicate is replaced by `subscriptionSurfaceFor`, which resolves the MATCHING surface for a spawn's resolved provider — used by `resolveAuthSpec` and the three mirrored direct-methods projections (`session-spawn.ts`, `session-restart-core.ts`, `catalog-models.ts`) so they stay in lockstep. `verifyLocalLoginPresent` now takes an optional provision-recipe `methodId` (convention `<provider>-oauth`) so a multi-surface spawn verifies the RIGHT login file instead of always checking the recipe's default method. mastracode declares both `{external: true, provider: "anthropic"}` and `{external: true, provider: "openai"}` — its ChatGPT login (`openaiCodexOAuthProvider`) is stored in its own auth.json under the key `openai-codex`, verified live. opencode declares the same pair: its ChatGPT OAuth login was reverse-engineered from the shipped binary (no OSS source available for this build) and is keyed under the SAME `openai` provider id its API-key flow already uses — there is no separate "chatgpt" key, confirmed by tracing the binary's generic `Cli.providers.login` → `Auth.set(provider.id, …)` write path. Both adapters' provision recipes gained an `openai-oauth` method alongside the existing `anthropic-oauth` one.
- adebd5b: External subscription verification resolves the ADAPTER's recipe, never the profile's/config's source. An external surface verifies the adapter CLI's own login file, but `profile.source ?? adapter` let a source naming another CLI's login shadow the adapter recipe — observed live: spawning mastracode with the codex-local profile (`source: "codex"`) resolved the codex recipe and failed with "provider 'codex' has no method 'openai-oauth'" instead of checking mastracode's own auth.json. Both the access-profile path and the config-defaults path now pass the adapter slug; codex-local on the codex adapter is unchanged (source equalled the slug there, which is why the bug hid).
- 1297e7f: Rate-limit `/mcp` transport error logs through the existing
  `createReconnectLogGate` (first failure immediate, then ≤1 line per minute
  with a suppressed-count suffix). Bare per-failure `console.error` on a
  launchd-redirected regular-file stderr is a synchronous disk write per
  malformed probe — a log flood and an event-loop stall risk under bursts of
  retrying clients (the `Parse error: Invalid JSON` / ECONNRESET incident).
  Wire behavior is unchanged: every probe still gets its JSON-RPC error
  response.
- e3ad769: Claude subscription on pi/opencode/mastracode — each through the door that actually exists — and honest subscription eligibility everywhere. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY`, where Anthropic's edge rejects it as an invalid key after the session is live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its documented bearer env (`ANTHROPIC_OAUTH_TOKEN`, scoped `provider: "anthropic"`) so a Claude subscription profile runs pi's anthropic models natively. opencode and mastracode declare `external` anthropic-scoped subscriptions — each CLI's OWN Claude Pro/Max OAuth login (`opencode auth login`; mastracode's `/login`), backed by new `opencode`/`mastracode` provision recipes pointing at each CLI's auth store: the runtime verifies the login is present (fail-loud), injects nothing, and scrubs the api-key vars so a leftover key can't override it. Adapters/models with no matching surface fail fast at spawn with an actionable message instead of failing opaquely upstream, and the catalog stops advertising subscription profiles as runnable on them.
- 4ac9d37: Documentation sync: Update MCP tool naming conventions (resource_action pattern), version bumps (0.12.0 → 0.14.0), and add docs for new features (daemon status build identity, pack build subcommand, workspace-brain transcript chunking, ops-panel app).
- f62f63a: Fix regression where pty-native session restarts lost the isolated config directory, causing provider resume to fail with "No conversation found". Add env-var threading support (CLAUDE_CONFIG_DIR) for session restarts with proper replay across pty-plain restart chains. Improve observability for abnormal PTY exits by capturing and surfacing diagnostic output.
- 90411f9: Document `agent_start(wait: true)` serialization behavior. Batching multiple `wait: true` calls in a single turn serializes them (caller-side harness limitation, not daemon bug). Includes clear workaround patterns for parallel fan-out using `wait: false` + `agentproto sessions wait` or `policy_attach`.
- c48c10d: Document `worktrees.isolation` configuration policy with detailed explanation of the three modes (on-request, always, never), depth-0-only behavior for nested spawns, and important config-key gotcha that can lead to silent misconfiguration.
- c6b5e41: Fix HTTP streaming finalization bug: prevent writing POST-terminal records (like usage_snapshot) after stream is finalized. Add integration test for `/sessions/:id/chat` SSE streaming route validating the complete UI message stream chunk sequence.
- d5eb115: Separate daemon-composed system prompts from user prompts in transcripts. The role disposition (and other daemon-synthesized preambles like lineage, AGENTS.md) are now recorded as a distinct `system-prompt` event ahead of the `user-prompt`, allowing viewers to fold synthesized context instead of rendering it as a user bubble. The adapter still receives the single composed prompt unchanged; the split is recording-only on the daemon's event stream.
- 8900417: Add support for `usage_update` and `usage_snapshot` transcript record kinds as known no-ops. These high-frequency cost/context bookkeeping records were previously falling through to the unknown-kind error path. Fixes spurious error chunks and console logging on every turn against a live daemon.
- dcfaa65: Fix text fragment rejoining logic to use only the explicit `partial` flag instead of heuristic `endsWith("\n")` check. This prevents complete text blocks from being incorrectly concatenated when tool calls interleave, which was causing paragraphs to run together (e.g., "…the client.Trial logic…"). The writer's transcript contract emits end-of-message blocks as non-partial records without trailing newlines, making the explicit `partial: true` flag the only reliable glue signal.
- baf8570: Surface ACP's `available_commands_update` notification instead of silently dropping it. `translateSessionUpdate` now maps it to a new `available-commands` StreamEvent, `transcript-writer` persists it to `events.jsonl`, and the daemon mirrors the latest command list onto `SessionDescriptor.availableCommands`, exposed read-only via `GET /sessions` / `GET /sessions/:id`. (The list surface now omits this live-only field by default; pass `?fields=availableCommands` to `GET /sessions`, or read `GET /sessions/:id`, which always carries it.)
- 7220068: Fix "restart starts a terminal but it doesn't work" bug: add origin-gate that prevents agent-cli/ACP-origin sessions from defaulting to provider-native terminal restart. ACP-origin sessions now default to agent-level resume, with explicit opt-in via `preferNativeTerminal` flag. Implement billing-auth re-resolution for pty-native path to prevent ambient credential leaks, closing #824/#490 for this codepath.
- bdc7d6f: Fix profile-aware route fallback for model-derived API key adapters: when a model's naive prefix-guessed route doesn't make a named profile eligible, search the model's actual serviceable routes for one that does, allowing models like "deepseek/deepseek-v4-flash" (billed via "openrouter") to work with appropriate profiles without requiring explicit `route.gateway`.
- 6372c19: Implement exit-time auto-reclaim for policy-provisioned (implicit) worktrees. When a session spawned under the `"always"` isolation policy without an explicit `worktree` request exits cleanly (merged/fresh, no uncommitted work), its worktree is automatically reclaimed using the same safety-layered classify→re-verify→remove pipeline as `worktree gc`. Caller-explicit worktrees (today's manual-cleanup behavior) are never auto-reclaimed. The feature is fire-and-forget, best-effort only, and never interrupts session teardown.
- 8a3d53d: Fix two critical bugs in `monitorSessionWait`:
  1. **Stale fast-path**: The synchronous already-in-target-state check for `turn-end` now requires `opts.since !== undefined` to fire. Without a cursor anchor, there is no way to distinguish "the turn this wait is waiting for already finished" from "some turn finished hours ago". Fresh `agentproto sessions wait` CLI processes (which have no persisted cursor) now correctly fall through to the real bus-subscribe long-poll instead of instantly succeeding against stale history.
  2. **Dropped empty/reason fields**: `SessionTurnEndEvent.empty` (zero assistant output, zero tool calls) and `.reason` (e.g. `"error"`) are now propagated through all three branches of the wait monitor (ring-replay, sync fast-path, bus long-poll) so callers can distinguish productive turns from silent no-ops (bad auth/model config) or adapter-reported errors. CLI exit code 4 is added for these cases.

  Includes a new `currentEventsCursor()` method to capture race-free cursors for prompt+wait patterns that cannot otherwise subscribe before a turn completes.

- c5016ed: Fix critical production incident (2026-08-22) where running daemon sessions' own working directories were incorrectly deleted by worktree GC. Root cause: `computeLiveness` was defaulting to the frozen legacy sessions file instead of reading per-workspace bucket files (AIP-46). Also adds `protectedPaths` mechanism as belt-and-suspenders protection, wiring the daemon's live in-memory session registry to prevent TOCTOU races between plan and apply.
- 1fd4a15: Make live OpenRouter pricing resilient to testing via snapshots instead of hardcoded assertions. Prices are re-synced weekly by catalog-sync, so snapshot diffs show legitimate changes as reviewable without breaking CI. Also fixes changeset naming collision in sync script that broke #1040/#1063.
- Updated dependencies [0097d36]
- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [4ac9d37]
- Updated dependencies [88134e9]
- Updated dependencies [e2314b3]
- Updated dependencies [baf8570]
- Updated dependencies [b95e23b]
- Updated dependencies [b1a8b7e]
- Updated dependencies [1fd4a15]
  - @agentproto/app-kit@0.7.0
  - @agentproto/model-catalog@0.8.5
  - @agentproto/driver-agent-cli@2.3.1
  - @agentproto/secrets@0.2.3
  - @agentproto/acp@0.7.2
  - @agentproto/workspace-brain@0.4.0
  - @agentproto/workflow@0.3.0
  - @agentproto/workflow-runtime@0.8.0
  - @agentproto/providers-store@0.3.8
  - @agentproto/sandbox@0.2.4
  - @agentproto/workflow-loader@0.1.4
  - @agentproto/eval-reporters@0.2.7
  - @agentproto/telemetry-langfuse@0.2.5

## 2.8.0

### Minor Changes

- da57681: Add build identity tracking to CLI and runtime. Captures git SHA and build timestamp at build time, and judges source (workspace vs published) at runtime. This enables operators to distinguish between workspace distributions and published tarballs of the same version via `daemon start`/`status` output and `/health` endpoint.

  New exports:
  - `renderBuild()` from `@agentproto/cli/commands/daemon`

  New optional fields:
  - `DaemonHealthInfo.build`
  - `CreateGatewayOptions.build`
  - `RuntimeHttpServerOptions.build`
  - `DaemonHealth.build` (VS Code)

### Patch Changes

- afa1796: Enhance PR provenance with exact attribution from tool-call records. The reconciler now checks two lanes in order: lane A reads successful `gh pr create` calls from the session's transcript (immune to branch switches and shared checkouts), then falls back to lane B (branch→PR resolution) for adapters whose tool calls aren't recorded.
- 3740171: Fix transcript debounce-split bug where mid-word fragments split by interleaved tool-call records would create artificial paragraph breaks. Adds `partial` flag to track explicitly unterminated flushes and updates reducers to rejoin text-delta records that haven't reached newline termination, keeping sentences coherent across tool interactions.
- d63cd31: Add skip-tracking to workspace brain to prevent re-ingestion of permanently-unavailable sessions. Skips are recorded in brain-state.json and excluded from pendingSessions backlog, but are not tombstones — explicit re-ingests and later successful ingests clear them automatically.
- bfd7daf: Fix transcript discovery for daemon-spawned claude-code sessions with isolated CLAUDE_CONFIG_DIR. Since the #824 MCP-isolation fix, daemon-spawned sessions write their transcripts under their own isolated config directory, not the global ~/.claude. Discovery and read operations now correctly resolve transcripts from the session's isolated directory when available, while maintaining backward compatibility with pre-#824 sessions and native PTY sessions that use the global store.
- 1bb03c4: Fix critical data loss bugs in sessions registry: add per-write unique tmp file names to prevent concurrent write truncation, serialize persist rounds to prevent interleaved snapshots, and quarantine malformed files instead of silently overwriting them.
- 949c6c7: Export new identity-stamping functions for daemon MCP gateway: `shouldInjectDaemonSelfMount` (determines which adapters receive default daemon gateway injection) and `stripOwnCallerStamp` (removes stale identity stamps when continuing sessions). Enable on-host claude-code spawns to receive identity-stamped daemon gateway by default, fixing the production issue where spawned sessions lacked parentSessionId lineage attribution.
- 463d345: Fix shutdown persistence race and failed spawn signal bug. Prevents child process exit handlers from re-arming persistence timers after shutdown (which would wipe session history to disk), and stops accidental SIGTERM signaling to the daemon's own process group when a spawn fails.
- d1b4aa4: Fix phantom-PR regression where sessions at the repo root would incorrectly attribute open PRs that happen to be on the default branch. Add default-branch guard to `makeOpenPrResolver` and only record PRs when actually stamped for the first time, preventing misattribution on idempotent re-reads.
- Updated dependencies [7b28edf]
- Updated dependencies [d63cd31]
- Updated dependencies [632b011]
- Updated dependencies [132ffe5]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4
  - @agentproto/workspace-brain@0.3.0
  - @agentproto/provider-presets@0.6.1
  - @agentproto/providers-store@0.3.7

## 2.7.0

### Minor Changes

- 2e24a7e: Enhance daemon lifecycle management with health reporting and shutdown statistics.

  **@agentproto/cli changes:**
  - New `runStop()` function exported for daemon stop command with pre-shutdown stats gathering
  - `runStart()` and `runRestart()` now accept optional `health: HealthFetchFn` and `probeAttempts` parameters for testability
  - New `DaemonHealthInfo` and `DaemonStopStats` interfaces enable rich metadata tracking
  - Lifecycle info blocks report daemon version, uptime, workspace, binary path, and activity metrics (sessions, token counts, spend estimates)
  - Enhanced `humaniseUptime()` to show nested units (e.g., `3h12m` instead of `3h`)
  - Added `formatDuration()` helper for shutdown messages

  **@agentproto/runtime changes:**
  - `/health` endpoint now reports daemon version, process ID, node executable path, and entry point
  - Added `startedAt` ISO timestamp to `/health` for debugging
  - These metadata fields enable lifecycle tooling to accurately report "what is actually running"

- 27a22ca: Persistent per-session isolated adapter config directories to enable native resume after adapter respawns.

  Previously, the isolated `CLAUDE_CONFIG_DIR` was a throwaway mkdtemp recreated on every spawn. This meant the SDK's conversation store (projects/<cwd-slug>/<uuid>.jsonl) was lost on respawn, causing resumeSessionId to degrade to a digest fallback every time an adapter process was reaped and restarted.

  The fix introduces `SessionDescriptor.adapterConfigDir` to persist the config location across respawns, keyed by the first session id in a lineage (`~/.agentproto/adapter-config/<sessionId>`). The runtime threads this through all spawn paths (agent_start, session_restart, lazy resume, cron, judges, webhooks, workflow steps), and the driver preserves the SDK's own state when reusing a persistent dir while always re-asserting `mcpServers: {}` to prevent ambient leaks from mid-session `claude mcp add` commands.

  Backward compatible: legacy rows without the new field keep today's digest-fallback behavior.

- 59d23d1: Enhance session visibility by tracking watcher metadata (who's watching and what they're waiting for) alongside the watchers count. New optional `SessionWatcherInfo` type captures waiter identity, event, timeout, and attach timestamp. Adds "awaiting-bg" section for sessions with pending background tasks. All changes maintain backward compatibility.
- 0b4a84b: Daemon-side FIFO prompt queue with force semantics: `enqueuePrompt` gains `queue`/`force` options, new `removeQueuedPrompt` method and `QueuedPrompt` type, and an HTTP `DELETE /queue/:id` endpoint. Messages arriving mid-turn are held in an ordered queue and dispatched sequentially as turns complete.
- 231f015: Add native terminal/TUI launching for harnesses and redesigned harness card UI. New `NATIVE_LAUNCH_ARGV` export in runtime maps harness slugs to their launch arguments. VS Code package now shows a wallet badge (replacing manifest facts) for quick navigation to billing providers, adds a Terminal button to spawn native sessions, and supports programmatic auth model focus targeting for direct provider navigation.
- 5de8be3: Add `session_flag_status` MCP tool and `SessionsRegistry.flagAwaitingInput` method for manual correction of a session's `awaitingInput`/`awaitingQuestion` classification. This is the first external write path for these fields (otherwise set only by internal heuristics or driver-reported prompts). Includes new `session:awaiting-input-flagged` event type emitted on the session event bus for audit trail visibility via `session_events_poll`, webhook notifier, and session monitor.
- cbe11c2: Fix jcode print arm: add `--ndjson` output format and move `run` subcommand to `bin_args` so composed flags land after it (not before). Add comprehensive jcode NDJSON event mapper with full test coverage. Implement fail-fast TTY handling for interactive setup steps: refuse pre-spawn when stdin is not a TTY, return distinct `EXIT_SETUP_NEEDS_TTY (78)` to surface the condition separately from real failures. Add `needsInteractiveSetup` flag to `AdapterInstallResult` and VS Code install action to offer "Open Setup Terminal" for TTY-blocked installs.
- a0558d4: Add session pinning — a server-persisted, list-visibility-only favorite flag. Pinned sessions sort to the top of `agentproto sessions` table and the VS Code webview's dedicated "Pinned" group. Includes new CLI `pin`/`unpin` subcommands, the `session_set_pinned` MCP verb, HTTP route `POST /sessions/:id/pin`, and dedicated UI in VS Code. Deliberately orthogonal to `keepAlive`, reaper eligibility, and notifications — pin is a quiet, structural sort/display flag with zero operational side effects.
- 140874a: Add optional `provider` field to ACP agent specifications. This allows generic ACP adapters (Mistral Vibe, Google Gemini CLI, Moonshot Kimi CLI) to declare their billing endpoints, enabling clients to link the harness to that provider's wallets even when no model list is declared. The provider is projected through AdapterInfo and integrated into VSCode wallet linking logic.

### Patch Changes

- e418ec7: Documentation updates for new jcode adapter, MCP tool families, configuration enhancements, and Mastra adapter API changes.
- 2120494: Report the pi adapter's real context window instead of the running token total, so context-continuity hard-stops trigger at the actual limit.
- 42ca610: Add in-band adapter turn-error tracking and refactor session status precedence. Introduces `lastTurnErroredAt` field to distinguish adapter-reported failures (status stays "running") from thrown/rejected streams (status→"error"). Reorders status dot precedence to awaiting > stalled > busy and separates healthy parked-bg sessions from genuinely stuck ones in the status bar.
- 6b04734: Test isolation: the runtime test package now runs with an isolated `$HOME` (vitest config/setup), so tests no longer read the real `~/.agentproto/*`. No runtime behavior change.
- 4474e5e: Expand terminal launch coverage to every harness with an interactive CLI arm by broadening NATIVE_LAUNCH_ARGV beyond attachArgv's resume-specific gates. Redesign harness card action buttons from platform-font glyphs to crisp SVG icons (conversation bubble + terminal glyph) with title and aria-label for accessibility.
- f96dc2a: Add opt-in `gh` provenance PATH shim for local agent sessions. When `provenance.wrapGh` is enabled, spawned sessions get a shim directory prepended to PATH so `gh pr create` (or adapter subprocesses) automatically append the daemon's deterministic `@agentproto-bot` provenance footer to PR bodies, matching cloud runner behavior.
- Updated dependencies [e418ec7]
- Updated dependencies [27a22ca]
- Updated dependencies [545752b]
- Updated dependencies [0bdd564]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/app-kit@0.6.1
  - @agentproto/driver-agent-cli@2.3.0
  - @agentproto/workspace-brain@0.2.1
  - @agentproto/provider-presets@0.6.0

## 2.6.0

### Minor Changes

- c17620e: Add app-scoped durable data plane with migrate/read/write/list MCP tools
- af936f8: Add a built-in live-session MCP App that attaches to `agent_start` and streams
  nested session activity with an app-only bridge polling fallback.
- b51b58e: **Support shell-based package managers (uv, pip, brew, cargo, go, pipx)** — expand adapter installation beyond npm to handle package managers commonly used in AI/ML workflows. New `parseShellHint` function parses and validates non-npm install commands; only recognized package managers are executed to prevent blind shell injection.

  **ACP adapters can now use `uv tool install`, `pip install`, etc.** — planner detects hint type (npm → shell → unsupported) and adapter install routes handle shell commands with the same safety/timeout guards as npm-global installs.

- 2375019: Extend the MCP app bridge wire (spec 2026-01-26) with three new methods and integrate them into the mail-triage UI:
  - **`updateModelContext`** (`@agentproto/runtime`): lets an app push updated context back to the model over the bridge; marshaled through JSON-RPC on the postMessage bridge, rejected with a clear error on the standalone bridge.
  - **`openLink`** (`@agentproto/runtime`): lets an app request the host open a URL; the postMessage bridge marshals the request through JSON-RPC, the standalone bridge falls back to `window.open`.
  - **`onTeardown`** (`@agentproto/runtime`): registers a callback invoked when the host sends `ui/resource-teardown`; the bridge replies with `{result:{}}` after running registered callbacks synchronously.
  - **Mail-triage UI** (`@agentproto/apps`): adds email selection via checkboxes, a "send selection" action that pushes selected emails to the model via `updateModelContext`, and "open in Gmail" links wired through `openLink`.

- 6fba2b9: Feature-flag the LLM Endpoint proxy sidecar behind `features.llmEndpoint` (default false). When disabled, the route is not registered, the registry is not created, and MCP tools are not exposed.
- ce6352b: Fix PR provenance attribution to prefer explicit caller session ID over heuristic guess, eliminating misattribution when unrelated sessions share the same working directory. Add `workspaceSlug` field to disambiguate workspace roots from per-branch worktrees in PR footer labels.
- 57dec3b: Add harness→profile preset persistence (`~/.agentproto/harness-presets.json`). Eliminates re-picking auth profiles per spawn by storing which profile + default model each adapter harness should bill through. Includes full CRUD store with validation (profile existence, model curation), MCP tools for remote management, and clean spawn-path integration at the correct precedence level (lowest — only fills unpinned profile/model).
- 1cb2093: Enhance session resumption transparency by distinguishing "no context available" from "partial context recovered from daemon transcript". The new `ResumeContextDigestResult` interface provides explicit context-availability tracking, enabling callers to display honest restart banners about what was actually recovered.
- dde641e: Add conversation export tool — the write side of cross-adapter transcript pivot. Enables exporting daemon session transcripts into target adapter native stores (starting with claude-code JSONL) and returning resume handles. Complements the existing read-side (`exportClaudeCodeSession`). Includes round-trip tests verifying message fidelity.
- 4b20f1e: **Per-workspace "brain"**: a queryable index of a workspace's agent sessions for agents to recall what work the workspace has done.

  New package `@agentproto/workspace-brain` provides the pure indexing engine (BM25 via `FilesKnowledgeAdapter`, zero runtime deps). The runtime wires it up with three MCP tools (`workspace_brain_query`, `workspace_brain_status`, `workspace_brain_ingest`) and auto-ingests sessions on exit (fire-and-forget, never takes down the exit path). State is persisted atomically to `brain-state.json`; knowledge index lives in `knowledge/sources/` under a per-workspace brain dir.

  Exports from runtime: `registerBrainTools`, `createWorkspaceBrains`, `readSessionForBrain`, `createWorkspaceBrainSubscriber`.

- 435a6f2: Expose live session activity phase: new read-time fields `currentPhase`, `toolCallsThisTurn`, and `secondsSinceLastActivity` track what an agent session is currently doing (thinking, tool-call, awaiting input, etc.), the distinct tool count in the current turn, and elapsed time since last activity. All fields are ephemeral—computed on every read and never persisted—following the pattern of existing fields like `processAlive`.

### Patch Changes

- 996ec8e: Add regression coverage for `agent_start` user-preset adapter resolution,
  including adapter and harness aliases, explicit-call precedence, and validation
  errors.
- 33e97d3: Add skill surface to defineApp/emit and app_skill_get validation
- d22fec5: Add artifact surface to defineApp/emit for Cowork artifact registration
- 59bc722: Three fixes around MCP app panels and session restart:
  - **MCP bridge injection** (`@agentproto/runtime`, `@agentproto/apps`): fix the idempotency check that incorrectly skipped injection for documents consuming `window.McpApp.connect()` — regex narrowed from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Defensive guard in mail-triage UI when the bridge is missing.
  - **Credential re-resolution on restart** (`@agentproto/runtime`): pass `accessProfileRef` to `resolveResumeAuth` so restarting a session that used a named auth profile re-reads the current credential from the keychain instead of falling back to a stale mode-based path.
  - **Restart loading state** (`agentproto-vscode`): show a loading state and disable the restart button while a session restart is in flight; new `restartFailed` webview message resets the state on error.

- 337cbfd: Parked-background-task detection, watch/unwatch sessions, watcher visibility.

  **Runtime** (`@agentproto/runtime`, patch):
  - Detect sessions parked with pending background tasks (run_in_background tool calls that end a turn without triggering a wake-up). Emit session:bg-tasks-parked / session:bg-tasks-cleared events; stamp pendingBgTasks count on descriptor.
  - Watcher attach/detach events: emit session:watcher-attached / session:watcher-detached when a blocking wait subscribes/unsubscribes, reporting the watcher count and supervising session id (when the wait came through the scoped orchestrator).

  **VS Code** (`agentproto-vscode`, minor):
  - Watch/unwatch commands: pin an eye on sessions so transitions into needs-you / stalled / parked-bg / failed / done raise toasts (debounced per state). Persisted per workspace; toggleable from tree and command palette.
  - Parked-bg activity state (needs-you > stalled > parked-bg > working > idle) with clock/warning icon, bg-task count in tree description + tooltip, '⏳ N bg tasks' webview chip.
  - Watcher visibility: info banner when a watcher attaches to the session you're watching, user-prompt badges when another session injected the message, and attributed history in the transcript.

- ec9efa3: **Hermes nativeTerminalResume gated on Node ≥22.5** — hermes TUI uses node:sqlite which is unavailable on older runtimes; the capability is now computed at import time so restart falls back to ACP agent-cli instead of crashing.

  **augmentWithFsResume backfills adapterSessionId** — when never captured (session killed before ACP handshake), backfill it from filesystem probe so agent restart can attempt ACP-level resume in addition to PTY-native restart.

  **restartAsTerminal opens transcript on fallback** — when restart falls back to agent-cli (no PTY available), open the conversation transcript view instead of the agent-mirror pseudo-terminal.

- 82ca9e6: Fix daemon crash from unhandled spawn errors and PATH-based node resolution issues:
  - Add error event listeners to spawn processes to prevent unhandled exceptions from crashing the daemon
  - Resolve `bin: "node"` in agent CLI definitions to `process.execPath` instead of relying on PATH lookup, preventing failures in launchd environments with minimal PATH
  - Fix auth method availability detection for models with `modelDerivedApiKey` by checking both `authSubscription` and `modelDerivedApiKey` for oauth-bearer eligibility
  - Improve test mocks to properly emit spawn events, enabling proper coverage of spawn failure scenarios

- c1e1807: Fix tool resolution failures in mastra-agent adapter: introduce fail-fast stubs for declared-but-unwired tools (preventing hangs), wrap all tools with timeout guards (preventing unbounded blocking), add daemon-style tool ID aliases (fixing vocabulary mismatches in AGENT.md files), and properly handle tool-error chunks from Mastra (preventing tool calls from appearing stuck). Extract shared command-allowlist logic to runtime package for reuse.
- 2c24d6f: Fix by-model-router adapters (hermes, pi, opencode) to stamp the resolved billing gateway onto the session descriptor's `route` field, preventing false "restart required" alerts in the VS Code change-model picker.
- a6b06b2: Three adapter infrastructure fixes:
  1. Codex model list expanded from 8 to ~40 models — covers GPT-5 family
     (5/5.1/5.2/5.4/5.5), GPT-5.6 (luna/sol/terra), GPT-4.1/4o, and
     o-series reasoning models (o1/o3/o4-mini).
  2. CLI `agentproto install <slug>` now drives a generic ACP agent's
     `install_hint` through the shared hint parser (new `install-hint.ts`
     module, extracted from `install-driver.ts` to break a circular dep).
     The `vendored` install step checks if the binary is already on PATH,
     runs npm/uv/pip/brew/cargo/go hints when recognized, and fails loud
     with an actionable message otherwise.
  3. `binOnPath` in `acp-generic.ts` now checks well-known package-manager
     install directories (`~/.local/bin`, `~/.cargo/bin`, `~/go/bin`,
     `/opt/homebrew/bin`, `/usr/local/bin`) as a fallback when PATH hasn't
     picked them up yet — fixes adapters installed via `uv tool install`
     not showing as "available" until the daemon restarts.

  Also: modelDerivedApiKey provider resolution for adapters like mastra-agent.

- be06061: Populate session descriptor model from adapter default when no explicit model provided.

  When a session is spawned with subscription auth and no explicit model parameter, the session descriptor's model field is now populated from the adapter's manifest default (if available), instead of remaining undefined. This fixes the VSCode panel displaying 'model?' as a fallback. The fix applies consistently to both the normal spawn and async worktree paths.

- bd990d1: Fix bundling of node:sqlite dynamic imports by using a computed specifier to prevent esbuild from stripping the node: prefix. Most builtins work without it, but node:sqlite has no unprefixed name.
- 66a6446: Add `conversation_locate` MCP tool for bidirectional session ↔ native-transcript lookup, enabling both forward (sessionId to native path) and reverse (native path to sessionId) queries. Also implement graceful fallback to daemon events when native transcripts are missing.
- c3dbdc4: Multi-provider knowledge federation: introduce `FederatedKnowledgeProvider` for concurrent query/ingest across multiple knowledge backends (files, gbrain-doc, qdrant) with min-max score normalization, per-provider weighting, and graceful degradation. Add `provider-resolver.ts` for config-driven adapter instantiation with environment secret resolution and schema validation. Integrate per-workspace `knowledge.json` config loading in workspace-brains with resilient fallback to default single-provider (files) behavior.
- b5ec52b: Add optional title field to plan events, displayed in VS Code conversation UI. Titles are safely threaded through ACP client translation, runtime event stream, and conversation presenter, supporting both immediate titles and late-binding (title added in subsequent plan updates).
- 41e36f4: Settle orphaned tool calls at turn-end. Adapters like Hermes can end a turn while omitting tool-result events for nested/parallel calls, leaving them stuck in "pending" state in UI consumers. This change synthesizes tool-result events with null values before the turn-end is recorded, ensuring transcript replay sees completed tool cards.
- 9d76f08: Normalize live model changes to each adapter's expected wire ID while preserving canonical model identity in session state.
- 16e4304: Add test coverage for daemon-events fallback paths when conversation ID resolution fails or the store is not registered.
- 16e4304: Fall back to daemon events.jsonl for unresolved/missing conversation IDs too
- Updated dependencies [33e97d3]
- Updated dependencies [415044d]
- Updated dependencies [d22fec5]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
- Updated dependencies [4b20f1e]
- Updated dependencies [c3dbdc4]
- Updated dependencies [3d54f15]
- Updated dependencies [b5ec52b]
  - @agentproto/app-kit@0.6.0
  - @agentproto/model-catalog@0.8.3
  - @agentproto/driver-agent-cli@2.2.2
  - @agentproto/workspace-brain@0.2.0
  - @agentproto/acp@0.7.1
  - @agentproto/providers-store@0.3.6
  - @agentproto/sandbox@0.2.3

## 2.5.0

### Minor Changes

- 36e19c3: Add `injectMcpAppBridge()` function to inject MCP Apps wire protocol bridge into UI app HTML at serve time. The bridge enables all app panels to communicate with the host via postMessage JSON-RPC without requiring each app to ship its own shim. Cache integration ensures injection runs once per (path, version) rather than on every request.
- f8b9c73: Add standalone HTTP routes for app UI hosting: `GET /apps/:appId/ui` serves installed apps' HTML with a REST bridge injected, and `POST /apps/:appId/tool-call` is the REST twin of the MCP `app_tool_call` gateway. Exports `performAppToolCall` and `injectStandaloneAppBridge` for shared use between MCP and HTTP surfaces.

### Patch Changes

- 6e1fcf3: Remove tilde-prefixed OpenRouter aliases and use non-throwing route resolution in widening
- Updated dependencies [2b58616]
- Updated dependencies [69e97d9]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2
  - @agentproto/app-kit@0.5.1
  - @agentproto/providers-store@0.3.5

## 2.4.0

### Minor Changes

- 7f98884: Add session visibility tracking: ephemeral watcher counters surface how many supervisors are actively monitoring a session, and lineage carry-forward ensures sessions maintain their source channel through restarts.
- c58b9fe: Implement turn-liveness watchdog: detect mid-turn agent-cli sessions with dead adapter streams.

  The daemon periodically sweeps every BUSY agent-cli session and, for one that is mid-turn, NOT legitimately blockedOn a subagent/command, and has had no adapter activity for longer than the configured threshold (default: 5 minutes), stamps `stalledSinceMs` on the descriptor and emits `session:stalled` — surfacing a dead adapter stream (network drop, hung child) that would otherwise sit indistinguishable from healthy long work. Detection and observability only; never auto-kills or restarts. Threshold configurable via `daemon.turnStallAfterMs` config or `AGENTPROTO_TURN_STALL_AFTER_MS` env var (DEFAULT ON, opt-in-to-disable). VS Code displays the stall flag (⚠ badge) when the daemon confirms, with a tooltip showing the silent duration.

- 4b73e28: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.
- b098b52: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.

### Patch Changes

- 1d3cbc2: Add stable id/name/version identity to bundled apps; fix app-registry persistence
- 2d9befc: Add session visibility features for parent-child session hierarchies: `childrenBusy` field counts descendant sessions mid-turn, enabling UI to show idle parents as "delegating" rather than truly idle; also adds "parked" state for idle sessions with watchers.
- c48defd: Allow subscription profiles (oauth-bearer) on modelDerivedApiKey adapters (mastracode, opencode). These adapters now correctly expose oauth-bearer as an eligible auth method and support subscription mode by injecting the token via the model-derived provider env var.
- Updated dependencies [4b73e28]
- Updated dependencies [b098b52]
  - @agentproto/app-kit@0.5.0

## 2.3.0

### Minor Changes

- 29acda3: Add optional `encoding` parameter to `file_read` MCP tool to support base64 encoding for binary files, fixing corruption of binary content (PNGs, audio, video, etc.) that was caused by UTF-8 decoding. Default behavior unchanged — existing callers continue to receive UTF-8 text as before.
- 5f2ebb8: Add prompt provenance tracking to transcript records and webview, enabling accurate attribution of supervisor-orchestrated turns. When one agent session prompts another (via `agent_prompt` or spawn with `initialPrompt`), the originating session ID is now recorded as the turn's source and displayed in the conversation UI as "SUPERVISOR ASKED" instead of "YOU ASKED". The feature is backward-compatible: existing transcripts and API call sites are unaffected, and source fields are optional everywhere.

### Patch Changes

- a26d527: Add child→parent report-back communication channel: new `message_parent` MCP tool for child sessions to send messages/status updates to their parent supervisors, plus `AGENTPROTO_PARENT_SESSION_ID` environment variable for lineage discovery. Includes automatic scope injection for gateway-less children and comprehensive test coverage.
- 1bce78e: Persist permission resolution in the durable transcript so the conversation UI can display resolved permissions and clear the "Awaiting your decision" state. Permission-resolved events are keyed by toolCallId to correlate with their originating agent-prompt asks.
- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 2.2.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- 5e75a57: Add progressive step status reporting to workflow execution via optional `onStepStart` and `onStepComplete` callbacks. Steps now transition through pending → running → done states during execution, rather than remaining pending until workflow completion. This enables real-time progress tracking for long-running workflows.
- 2962637: **Feature: Agent step output text threading in workflows**

  Agent steps can now automatically capture their text output and inject it into subsequent steps' prompts, enabling multi-step workflows to share context and analysis. The workflow runtime captures the final message from each agent step (when `readFinalMessage` is available) and threads it through the bindings, making it accessible to downstream steps via the AIP-16 Selector pattern. Previous step outputs are formatted as `[Output from step "id"]\ntext` and prepended to the base prompt, improving agent reasoning across sequential steps.

- 2b379e9: Add app dependency management and scope mount tracking. Introduces `requires` field on apps to declare dependencies, new MCP tools (`app_apply`, `app_unapply`, `app_list_applied`) for managing app mounts to scopes, HTTP endpoints mirroring the tools, and AppRegistry enhancements for persistence of applied mounts with dependency validation.

### Patch Changes

- 48b4302: Add app\_\* daemon tools (app_install, app_list, app_run, app_status, app_stop) for @agentproto/app-kit lifecycle management. Tools enable installing bundled agent-workflow apps, running agents as live sessions, and monitoring app execution. Moves workflow tool-id validation from step-dispatch time to install time, reporting all missing tool ids at once instead of failing one step at a time.
- Updated dependencies [4b6bbe6]
- Updated dependencies [3e187e5]
- Updated dependencies [47ca357]
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
- Updated dependencies [492240c]
- Updated dependencies [2b379e9]
  - @agentproto/model-catalog@0.8.1
  - @agentproto/driver-agent-cli@2.2.0
  - @agentproto/app-kit@0.4.0
  - @agentproto/workflow@0.2.0
  - @agentproto/workflow-runtime@0.7.0
  - @agentproto/providers-store@0.3.4
  - @agentproto/sandbox@0.2.2
  - @agentproto/workflow-loader@0.1.3
  - @agentproto/eval-reporters@0.2.6
  - @agentproto/telemetry-langfuse@0.2.4

## 2.1.0

### Minor Changes

- 678bc1a: Session identity environment variables: inject `AGENTPROTO_SESSION_ID` and `AGENTPROTO_WORKSPACE_SLUG` into every process spawned by the daemon on a session's behalf (agent adapters, terminals, commands, cron jobs). Each spawn gets its own freshly minted id; the variables are set last to prevent caller forgery. This enables spawned processes to report back session context, tag telemetry, and nest child sessions under parent sessions via `parentSessionId`.
- 6280066: Add WP-D structured verdict parsing for judge gates, with optional JSON-based verdict format supporting findings/severity metadata. Judge gates can now pin a custom billing profile via `access.profileRef` to avoid wallet rate-limiting. New types: `JudgeVerdict`, `VerdictSeverity`, `VerdictFinding`. New gate spec fields: `judge.access`, `judge.route`, `judge.mode`. Verdict is persisted and echoed on `policy:passed`/`policy:failed` events. Backward compatible: existing plain-text verdicts work unchanged; JSON blocks are optional.
- b99245b: Default `agent_start` dedupe to deriving an implicit idempotency key. A retry provoked by a lost or slow response previously forked a second session unless the caller remembered to pass `idempotencyKey` — a guard that only works when asked for is not a guard, the same argument `spawn.attach` already settled for parent lineage. New daemon-side `spawn.dedupe` policy on `SpawnConfig` (`AGENTPROTO_SPAWN_DEDUPE` env > config > default `"always"`), which derives a key from `label` + a hash of the initial prompt. No label means no implicit key at all, so deliberate unlabelled parallel fan-out into one cwd is structurally excluded. Implicit claims use a shorter window (120s) than explicit ones (600s) — a guess should not be trusted as long as a promise. Per-call `dedupe: false` opts out, mirroring `attach: false`; `dedupeSource: "explicit" | "implicit"` is surfaced on the result so a caller can tell the two apart.
- fd3e287: **WP-E (spawn-dedupe-default)**: Add implicit idempotency key derivation to prevent accidental spawn duplicates without requiring explicit opt-in. When a spawn carries a `label` and no `idempotencyKey`, the daemon derives an implicit key from the label plus a hash of the initial prompt. Same-adapter/cwd/key spawns within ~2 minutes are deduped (shorter window than explicit keys to reduce false collisions). Label-gated derivation preserves the fan-out safety pattern where unlabelled parallel spawns must remain distinct. New config field `spawn.dedupe` ("always" default / "on-request") controls policy; per-call `dedupe: false` escape hatch.

  **WP-F (worktree async provisioning)**: Enable fast-return session registration with background worktree provisioning, and share a single turbo build cache across all provisioned worktrees. `worktree: { async: true }` opts in: returns immediately with status "starting", provisioning + driver spawn continue in background. New registry methods `spawnAgentPending` / `settlePendingAgent` manage placeholder lifecycle. New `resolveWorktreesTurboCacheDir()` export provides shared cache path to setup hooks, eliminating cold builds on every worktree provision.

### Patch Changes

- c825a12: Sync generated catalog data from the pinned provider sources.

  catalog-sync and runtime are named because their `src/__tests__` assertions
  had to follow the refreshed data (context-window entry count, gpt-5.6 tier
  repricing), and the coverage check counts anything under `src/` as
  publish-affecting.

- 832870d: Documentation sync: daemon restart command, sessions gc garbage collection, install --allow-unverified flag, Gemini adapter shipped, pi adapter support, xai-anthropic and llm-endpoint provider presets, and launchd crash-only KeepAlive behavior.
- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- 8228d88: Add dep-bump reclaim exemption for worktree GC: safely promote clean, unpushed worktrees from `hold` to `reclaim` when all commits are mechanical dependency bumps (subject and cumulative diff validation). Addresses storage bloat from recurring automated dependency-bump worktrees piling up as permanent holds. Includes comprehensive test coverage and applies re-validation at apply time (layer 2).
- 980276e: Router-aware LLM model enumeration for Requesty and HuggingFace.

  Introduces `listRouterLlmRoutes` to systematically enumerate all models a router serves, and enhances `getModelsByProvider` to fold these router tables into provider queries while deduplicating against OpenRouter's existing bare-id surface. Requesty and HuggingFace models now enumerate from their generated route tables as `vendor/product@router` ids. Claude SDK adapter adds Requesty model curation to its allowed list.

- df10f28: Fix spawn-claim deduplication window to match real retry latencies: increased from 30s to 10 minutes to absorb the caller's timeout (300s) plus network/clock skew, with an LRU size backstop (1,000 resolved claims) to prevent unbounded growth. Add non-blocking warning when two live sessions share the same label+cwd, aiding incident detection without breaking legitimate fan-out patterns.
- Updated dependencies [c825a12]
- Updated dependencies [832870d]
- Updated dependencies [c1399f3]
- Updated dependencies [980276e]
  - @agentproto/model-catalog@0.8.0
  - @agentproto/provider-presets@0.5.1
  - @agentproto/mcp-server@0.2.5
  - @agentproto/provider-kit@0.4.1
  - @agentproto/providers-store@0.3.3
  - @agentproto/eval-reporters@0.2.5
  - @agentproto/sandbox@0.2.1

## 2.0.0

### Major Changes

- ff9c348: Fold RoutineRunner into AIP-15 workflow; routine\_\* verbs become deprecated workflowRunner aliases
- 68ef7fb: Add operator-configurable custom routes via `~/.agentproto/routes.json` and a new `xai-anthropic` gateway preset.

  **Breaking change (`@agentproto/runtime`):** `registerBuiltinRoutes()` is now `async` (`() => Promise<void>`, previously `() => void`), because it now also loads and validates operator routes from `~/.agentproto/routes.json` before returning. Any external caller must add `await`:

  ```diff
  -registerBuiltinRoutes()
  +await registerBuiltinRoutes()
  ```

  Callers that do not await the returned promise will silently skip operator-route loading (built-in routes still register synchronously before the first `await` point, but overrides from `routes.json` will not be applied and no rejection will surface). All internal call sites in this repo have been updated.

  `@agentproto/provider-presets` gains the `xai-anthropic` preset: an Anthropic-schema-compatible gateway pointed directly at xAI, for hosts that want to address Grok through the Anthropic wire format.

### Minor Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 15e15db: Add context-continuity policy, structured checkpoints, and fresh continuation for long-running agent sessions.
  - Resolve context-continuity policy (manual / ask / auto) with configurable warn/compact/continue-fresh/hard-stop thresholds.
  - Build and persist bounded structured checkpoints next to the source session's events.jsonl.
  - Spawn a fresh continuation session with the same adapter, model, route, access, posture, cwd, and MCP servers, linked via `continuedFrom`/`continuedTo`.
  - Add MCP tools: `session_context_status`, `session_checkpoint`, `session_compact`, `session_continue_fresh`.
  - Surface compact and continue-fresh actions in the VS Code sessions panel.

- 9bb814f: Add attachment support and MarkdownV2 formatting to transmit_message
- 96b22d5: add tool-cli CLI projection and session PR provenance tracking
- 6a0a60c: add daemon PR-provenance reconciler and open-PR resolver
- 013e7b3: Carry provider auth headers through attach; fix Box boot auth
- 2ec1af8: Add the semantic hook engine core (Plane 1): `.agentproto/hooks.json` schema + loader (`hooks-config.ts`, mirroring the `allowed-commands.json` cache pattern) and a rule-driven `decide(rules, {tool, command, args}, fallback)` evaluated at the pre-exec permission seam, generalizing the old `permissionHold` boolean into `allow | hold | deny`.
  - Every rule carries a required `plane: "semantic" | "blast-radius"` tag; `decide()` only consults `"semantic"` rules (the ACP permission seam), leaving `"blast-radius"` rules as declared-but-unwired substrate for the OS-sandbox plane.
  - RISK-0 GUARD: the loader refuses to load a rule that declares `intent:"security"` with `plane:"semantic"` and `action:"hold"` or `"deny"` — a Plane-1 hold/deny is bypassable (bypass posture, in-process tools, non-ACP harnesses) and would be a false sense of safety for a security rule.
  - LOG-ONLY DEFAULT: no `.agentproto/hooks.json`, or one containing only `action:"log"` rules, reproduces today's `permissionHold`-boolean behavior exactly — this PR ships the engine + config substrate, not any enforcing rule. `deny` decisions currently degrade to the same hold-for-human path as `hold` (no auto-deny wiring yet).

- 8367648: rename auth 'vendor' axis to 'endpoint' in profiles and manifests. The v1
  `~/.agentproto/auth-profiles.json` disk format deliberately keeps `vendor` for
  backward compatibility; the public TypeScript API exposes only `endpoint`.
- 70ee0db: Add AIP-45 mode support to CronAction agent type: `mode` (mode id), `permissionHold` (start in permission-hold mode), and `options` (manifest-declared option ids). These optional fields are properly threaded through `startSession` and `spawnAgent` calls with conditional spreading to maintain backwards compatibility.
- d10ed02: Add worktree-status query surface (MCP tool + HTTP route). Exposes git worktree status with live PR integration and session linkage via `worktree_status` MCP tool and `GET /worktrees` HTTP endpoint. The heavy join lives in `@agentproto/worktree` and is injected at the daemon's composition root, keeping the runtime free of that dependency.
- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- b04dba5: Add daemon-lane PR provenance stamping: relocate footer generation logic from `scripts/lib/provenance-footer.mjs` into a new pure `pr-provenance` submodule so daemon's `command_execute → gh pr create` path can stamp the same `@agentproto-bot` footer (byte-identical CI format, with daemon-specific auth-profile/supervisor/host/cwd fields) as the CI lane. Include `pr-provenance-stamp` orchestration module for best-effort stamping with idempotency and comprehensive error handling.
- d90fdc0: Add spawn-time money-safety guard that rejects gateway/router models on incompatible wallets. Exports three new functions: `serviceableModelRoutes()`, `checkModelWalletEligibility()`, and `modelWalletIneligibleMessage()`. Adds new `model_wallet_ineligible` error code to `SpawnAgentSessionResult`. The guard prevents silent 404s when a model bills to a different route than the resolved wallet can provide (e.g., DeepSeek on Anthropic's wallet when it requires OpenRouter).
- 6ff42b4: feat(auth,runtime): auth-profile create/delete flow. Provision named subscription and api-key auth profiles from the daemon via the `auth_profile_create` / `auth_profile_delete` MCP verbs, backed by a `profile-provision` helper that writes the profile descriptor and stores the credential in the OS keychain. Surfaced in VS Code as a create/delete UI on the auth-profiles tree.
- 7e78a37: Add trusted `parentSessionId` lineage hint (WP-R1) and `session:spawned` event (WP-R3) to enable agent-to-agent spawn attribution and real-time tree updates. The scoped orchestrator gateway's token always wins over hints, maintaining unspoofable parent derivation for nested spawns while filling the depth-0-orphan gap for root-path spawns.
- a3deef9: Fix session display name precedence: derived titles now outrank spawn labels

  Introduces a `renamedByUser` flag to distinguish user-renamed labels from spawner-supplied labels. This allows the derived title (first sentence of the first prompt) to outrank spawn labels in the display precedence, preventing slugs like "auto-title-precedence-fix" from shadowing useful titles. User-explicit renames still win.

  Breaking compatibility: None. Sessions persisted before this change treat an absent `renamedByUser` flag on a labelled session as "user-renamed" to preserve prior edits; only new spawns stamp the flag explicitly.

- 61b23e0: Implement adapter installation API for harnesses: add `POST /adapters/:slug/install` HTTP route and `adapter_install` MCP tool to install not-yet-ready agent CLI adapters. Supports both acp-catalog CLIs (npm-global) and first-party workspace adapters (manifest install pipeline). VS Code extension UI integration with context-aware install button for installable harnesses.
- 3948ef9: Add support for four new universal conversation stores (codex, opencode, mastracode-inprocess, pi) with discover and export interfaces. Enables session recovery across diverse harnesses with comprehensive error handling and support for role mapping, timestamps, reasoning blocks, and tool calls.
- 443507d: Add `listImportCandidates` for universal conversation import across multiple harnesses. The new function discovers external conversations (claude-code, hermes) that can be reattached as live sessions, replacing claude-code-only logic with a store-agnostic abstraction. Generalizes over `ConversationStore.attachArgv` — any harness with native reattach capability can now be discovered and reattached.
- fa2e0c9: Add interpreter detection and warning to `command_execute`: export `INTERPRETER_BASENAMES`, `isInterpreterBasename()`, and `interpreterExecWarning()` to help users avoid the security footgun of allowlisting code interpreters (bash, node, python, etc.), which can grant arbitrary host code execution despite workspace cwd anchoring. Warnings are logged once per interpreter per daemon session and included in the result JSON for visibility without blocking.
- b55c58d: Add macOS Seatbelt-based OS-level confinement for `command_execute` subprocesses (phase 2). Introduces opt-in `.agentproto/command-sandbox.json` config with three modes: "off" (default, no change), "workspace" (deny access to home directory outside workspace, protect credentials), and "strict" (add network denial). Backends are platform-specific; returns null on non-macOS platforms. Original command/args preserved in provenance; only spawned argv is wrapped. Comprehensive test coverage including end-to-end macOS Seatbelt validation.
- 589dc04: Add Mode 3 (self-refreshing OAuth) support for subscription credentials. Allows the runtime to read the Claude Code OAuth token fresh from the local login on every spawn via the `claude-code-oauth` provision recipe, implementing automatic token refresh without static token management.

  New exports: `resolveSubscriptionCredential()`, `SubscriptionSourceError`, `CLAUDE_CODE_OAUTH_SOURCE`, extended `CredentialSource` type.

  Fixes precedence logic (explicit-token > source-resolved-fresh > config-static-token) and adds loud error handling for unknown sources or resolution failures.

- d3f6f85: Add `gcSessions()` method to bulk garbage-collect terminal sessions — archive (default, reversible) or forget (drop descriptor to reclaim disk). Supports age-based and scope-based filtering, never touches live sessions. Exposed via MCP tool `session_gc`.
- f669026: Add unified Activity read-model (policies, turns, routines, workflows, PRs) with MCP tool and HTTP endpoint
- 2efea7d: Add provenance tracking for command sessions via `origin` and `callerSessionId` fields.
  - `SessionDescriptor` now includes optional `origin` (source label: "command_execute", "cron", etc.) and `callerSessionId` (session that invoked this one)
  - `command_execute` tool accepts optional `origin` parameter, defaults to "command_execute"
  - Cron scheduler stamps `origin: "cron"` on scheduled command sessions
  - Transcript export includes provenance fields in metadata and renders them in markdown output
  - All changes backward compatible; fields are optional and only set when provided

- 8f5e5cd: Add Task-to-Activity linking via read-time join. Introduces `ActivityTaskLister` interface and `linkTasks()` function that enriches activity records with `taskId` — turns link to the OPEN task their session owns; policies link to the task whose verify gate is that policy. Also adds `snapshot()` method to `TaskLedger` interface for unscoped task access needed by the Activity projector. Maintains clean separation: Task stays the source of truth for INTENT, Activity for EXECUTION.
- 645279d: Add support for source-backed auth profiles — named profiles that resolve credentials fresh from self-refreshing sources (e.g. `claude-code-oauth`) instead of storing a static secret. Session spawn resolves source-backed profiles via Mode 3 credential resolution on every spawn; session restart explicitly rejects them (out of scope for restart, follow-up planned).
  - `AuthProfile.credentialRef` now optional, new mutually-exclusive `source` field
  - `validateCreateInput` enforces exactly one of `credential`/`source` for oauth-bearer, requires `credential` for api-key
  - Session spawn: source-backed profiles resolve fresh credential each time via `resolveSubscriptionCredential`
  - Session restart: source-backed profiles fail loud with `RestartOverrideError`
  - New tests: profile provisioning with source, session spawn with source, restart rejection of source

- 6c1948d: Add `boardId` spawn-time board pinning: allow clients to pin spawned agent sessions to explicit task boards via optional `boardId` parameter on `agent_start` (MCP) and HTTP spawn endpoints. The spawned board pin (`meta.boardId`) takes precedence over lineage-derived board resolution, enabling cowork-style operators to fan out multiple depth-0 root sessions onto a shared board without shared lineage. Backward-compatible: all new fields are optional, existing spawns unaffected.
- 5ba2032: Add rawInput field propagation through permission-hold system. The tool call's raw input (e.g. Bash command string) now flows from requestPermission RPC → agent-prompt event → PendingPermission object → HTTP/MCP APIs, surfacing in the CLI `permissions ls` table as a truncated preview for enhanced transparency in permission request review.
- ca4b091: Add optional `hint` field to `session_monitor` MCP tool response. When a polling timeout occurs, the hint guides callers toward the uncapped `agentproto sessions wait` CLI command. Improve docstrings for `agent_start` and `session_monitor` tools to clarify CLI equivalents.
- 0515531: Unified tool-call logging for both proxy (command_execute) and in-agent (Bash, Read, Edit) paths via normalized ToolCallRecord interface. Adds tool_calls_list MCP tool to query records across sessions, joined with session-level provenance (harness, origin, callerSessionId) at read time.
- 3c0ef25: Add git-worktree garbage collection surface: `POST /worktrees/gc` HTTP route and `worktree_gc` MCP tool powering the daemon's worktree management. Defaults to dry-run mode; requires explicit `apply: true` to execute. Design maintains architectural isolation from `@agentproto/worktree` via an injected runner port, mirroring the `worktree_status` pattern.
- 230f378: Export orphan reaping utilities for custom orchestrator implementations. Adds `reapOrphanedDescendants` function and `OrphanReaperRegistry` interface to the public API, enabling users to implement custom child-session lifecycle management when parent sessions exit.
- 392021a: Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):
  - **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.
  - **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.
  - **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.
  - **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.
  - **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

  Backwards compatible: default behavior unchanged when no config and no explicit mode.

- bd24703: Implement `action:"gate"` for the hooks engine — shell commands that auto-resolve permissions from exit codes. Factors out gate execution into a shared `runShellGate()` function (reused by both turn-end policy gates and hook-engine gates), ensuring identical behavior and reducing duplication. Includes comprehensive test coverage and properly maintains the RISK-0 guard against security-intent rules on Plane-1. New exports: `decideRule()`, `runShellGate()`, `HookGateSpec`, `ShellGateOutcome`.
- 173cff1: Add argv-level allowlist matching and callerSessionId provenance threading for command_execute.

  Allowlist entries can now constrain command arguments (e.g., allow `git status` but deny `git push`), while plain string entries remain unconstrained for backward compatibility. Session ID pre-minting enables tracking which agent session invoked a command through the MCP gateway.

- 17b503a: Harden daemon lifecycle for idempotent startup under launchd supervision:
  - **KeepAlive crash-only restart**: Changed plist `KeepAlive` from always-restart (`<true/>`) to crash-only (`<dict><SuccessfulExit>false</SuccessfulExit></dict>`). This allows clean exit-0 to stay settled, enabling idempotent `serve` startup when a healthy daemon already owns the port.
  - **Split `daemon start` into idempotent-launch vs force-cycle**:
    - `agentproto daemon start` now uses `kickstart` (no `-k`): idempotent, leaves a healthy daemon running.
    - `agentproto daemon restart` uses `kickstart -k`: force-cycle, kills and relaunches (replaces `pnpm killport 18790`).
  - **Idempotent gateway boot**: `serve` now preflights the `/health` endpoint before binding. If a healthy daemon already owns the port, exits cleanly with exit-0. If bind races, re-probes on EADDRINUSE and defers to the winner.
  - **Rate-limited reconnect logging**: New `createReconnectLogGate` (exported from `@agentproto/runtime`) rate-limits failure logging per key. A dead peer's standing reconnect loop logs the first failure immediately, then at most one line per window with a suppressed-count suffix. Fixes log spam: one dead pairing previously buried 85% of `daemon.log`.
  - **Test coverage**: New comprehensive tests for daemon lifecycle (`daemon-lifecycle.test.ts`), idempotent boot (`serve-idempotent-boot.test.ts`), and log rate-limiting (`reconnect-log-gate.test.ts`).

- 1470be9: Fix billing-auth re-resolution for lazy in-place session resume. Previously, lazy resume called `startSession` with no auth, causing sessions pinned to subscription billing to silently use the daemon's ambient `ANTHROPIC_API_KEY` instead of re-resolving credentials fresh from config. Extracts shared `resolveResumeAuth` function used by both restart and lazy resume paths to ensure consistent fail-loud behavior. Exports `resolveResumeAuth`, `ResumeAuthResolution`, and `ResolveResumeAuthOptions` for external use.
- 6ff5175: Implement interrupted-turn contract (§4) for daemon-restart session recovery. Sessions that die with a turn in flight are now marked with a derived `interrupted` field and resumed without auto-retrying the dropped prompt. A new `SessionResumedEvent` bus event surfaces recovery state to watchers, and a new `isResumable()` predicate gates in-place resumption eligibility. Also fixes an ordering regression (§5) where completion policies were silently cancelled at boot when their watched session recovered under a daemon restart.
- 9d56fa2: Add resume attempt cap and backoff mechanism to prevent infinite retry loops when an adapter consistently fails to resume a session. Introduces `MAX_RESUME_ATTEMPTS` constant, `canResume()` function for cap-aware eligibility checking, and `ResumeDisabledError` exception. Session resume attempts are persisted across daemon restarts and reset on successful completion, ensuring the cap survives crash-loops and prevents exhaustion of resources.
- 9b1736d: Add opt-in eager resume-on-boot for session survivability (PR-4). After a daemon restart, eligible agent-cli sessions are eagerly re-spawned without waiting for a prompt, restoring liveness to orchestrated fleets and completion policies. Feature is off by default (set `daemon.resumeSessionsOnBoot: true` to enable) and includes proper concurrency control and cross-process safety for multi-daemon deployments.
- 47dae30: Implement idle agent-session reaper (PR-6): periodically retire long-idle agent-cli sessions to free adapter processes and prevent resume-storms on daemon restart. New public API exports `runIdleReapPass`, `IdleReapSummary`, and `IdleReaperRegistry` for library users; opt-in via `daemon.idleReapAfterMs` config field or `AGENTPROTO_IDLE_REAP_AFTER_MS` env var.
- 05f85ac: Add "Save as Favorite" functionality to capture and reuse preferred spawn configurations. New HTTP routes (POST/DELETE /user-presets) enable favorites authoring from VS Code, storing user presets with pinned spawn axes (adapter, model, route, effort, context) and location (cwd, skills) in ~/.agentproto/presets.json. Favorites are displayed in the spawn picker with star icon, enabling zero-input re-spawn with their pinned values.
- 8d20b7e: Dynamic session activity line: secondary, auto-regenerating label showing what each session is doing now. Regenerated on turn-end from heuristics (ANSI-stripped last assistant/tool line + lifecycle state); frozen for human-renamed sessions; throttled to ≥60s interval. Displayed as the leading segment of the sessions tree row (sidebar-truncated to 72 chars) and in full in the tooltip.
- 242df33: Add `agentproto sessions gc` CLI command and `POST /sessions/gc` HTTP endpoint for bulk garbage collection of terminal-status sessions. Supports `--older-than-days` (cutoff filter), `--forget` (permanent deletion vs. reversible archival), and `--json` (scripting output).
- 3865de6: Add file-based ("external") subscription login support for Codex and future adapters (Gemini). File-based subscriptions have the CLI read its own login file (~/.codex/auth.json), so the daemon injects NOTHING and only scrubs conflicting api-key environment variables, maintaining the money-safety invariant that no OAuth bearer is ever written to an api-key channel.

  Includes:
  - New `authSubscription: { external: true }` shape in adapter manifests for CLI-resident login files
  - `verifyLocalLoginPresent()` function to fail-loud on missing external login before spawn
  - Comprehensive test coverage for both profile-based and config-based spawn paths
  - VSCode UI integration for "Use my existing Codex login" option
  - Documentation explaining both bearer-injection (Claude Code) and file-based (Codex/Gemini) shapes

- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.
- 14d29fe: Implement automatic parent attribution for spawned agents via attach policy layer, fixing the orphan-executor bug. Supervisors spawning executors without orchestrator setup now nest as children instead of appearing as depth-0 roots. Also adds session origin tracking and grouping for UI-friendly "claude-code vs vscode vs cron" views.

  New features:
  - `agent_start.attach` field: control spawn parent attachment (false=independent root, true=force attach, {parent}=explicit pin)
  - `spawn.attach` daemon config: policy mode (always=default, on-request=explicit opt-in only)
  - Session descriptor `origin` field: group roots by source (claude-code, vscode, cron, …)
  - `groupRootsByOrigin()` function: bucket session tree by origin for group-based UX views
  - `AGENTPROTO_SPAWN_ATTACH` env override for attach policy

  All new fields are optional; backward compatible default "always" mode auto-attaches via trusted callerSessionId.

- f3f5e82: Implement WS6: credential discovery scanner + first-run onboarding flow. Adds `auth_discover_credentials` (read-only scan of local credentials), `auth_profile_import` (materialize discovered credentials into profiles), and onboarding wizard. Two security invariants verified: never returns secret values (sentinel test), never throws on malformed source (per-source warn+skip). All five discovery origins supported (Claude Code, Codex, Gemini, env, hermes-config). New optional `origin` field on AuthProfile stamps the import provenance.
- 70bfab0: feat(runtime): expose session-story-panel module in package exports

  feat(vscode): live session-story webview panel with "Open story" command

  Reuses SESSION_STORY_PANEL_HTML from @agentproto/runtime byte-for-byte inside a VS Code webview panel (srcdoc iframe relay pattern). Adds agentproto.openStory command to open any session's live timeline, wired into the spawn wizard and session tree context menu.

  The panel drives itself over JSON-RPC 2.0 postMessage, calling session_list/agent_export/agent_prompt via StoryPanelController — a testable bridge mapping the panel's three tools onto DaemonClient.

- f3f5e82: Add profile enable/disable (WS2), per-model curation (WS3), and server-side credential identity display (WS5) features.

  **WS2 — Whole-profile disable**: New `disabled?: boolean` field on `AuthProfile` and `setAuthProfileEnabled()` function enable/disable a profile entirely, dropping all its models to non-runnable. The `eligibleProfiles()` predicate skips disabled profiles at the endpoint/method gate.

  **WS3 — Per-model curation**: New `models?: ModelCuration` field on `AuthProfile` and `setAuthProfileModels()` function restrict a profile to specific models via an allow-list. Curated profiles stay endpoint-eligible but only their chosen refs become runnable. The curation filter is applied downstream in the catalog join.

  **WS5 — Credential identity**: New `credentialIdentity()` function computes a read-only identity (fingerprint + last4 tail) server-side from the keychain, never exposing the secret. `auth_profile_list` MCP tool output now includes key status (`stored` / `self-refreshing` / `unavailable`) and identity for stored secrets. VS Code UI displays the tail and fingerprint in the profile row.

  All changes maintain backward compatibility: absent `disabled` means enabled; absent `models` means mode "all". Profiles without these fields parse and round-trip byte-identically to pre-feature versions.

- babc42d: Add usage rollup feature for tracking spend estimates over rolling windows.
  - New `usage_rollup` MCP tool and `GET /usage/rollup` REST route for querying spend by profile, model, and harness
  - New CLI command `agentproto usage rollup` for local-derived, provider-agnostic spend estimates
  - Pure rollup logic (`parseWindow`, `rollupUsage`) correctly handles cumulative snapshots and separates priced vs unpriced tokens
  - Supports both shorthand (`5h`, `7d`) and ISO-8601 duration formats (`P7D`, `PT5H`)

- 655b4b6: Add windowed cost-budget caps and opt-in live remaining-quota enrichment for usage rollup
- 281eb5f: usage rollup phase 3 — best-effort remaining account credits (OpenRouter + Moonshot) surfaced on byProfile[].credits
- a88a78b: Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
- 7e47007: Add machine-readable `timedOut` flag to `ExecuteResult` to distinguish timeout terminations from other SIGTERM events. Includes process-group-aware child termination and helpful stderr guidance when timeouts occur. Requires corresponding updates to `RecordCommandInput` and `CommandLogEntry` to fully propagate the field through command logging.
- 924cbf6: Add upstream credential linking and live testing:
  - **@agentproto/llm-endpoint**: New API for per-upstream credential status (describeUpstreamStatus, collectUpstreamStatuses, testUpstream) and HTTP routes (GET /v1/upstreams, POST /v1/upstreams/:provider/test).
  - **@agentproto/runtime**: New llm-endpoint-links-store for persisting upstream→profile links to ~/.agentproto/llm-endpoint-links.json, and new MCP tools (llm_endpoint_set_upstream_link, llm_endpoint_list_links).
  - **agentproto-vscode**: New "Upstreams" tree grouping with inline test and link actions, profile picker QuickPick, and pending-restart annotations when persisted links haven't been applied yet.

  Users can now map LLM provider upstreams to named auth-profiles (instead of bare env keys), manage those links via MCP, and test them live to verify credentials resolve correctly.

- 91741b3: Add opt-in supervisor crash-notification (crash-detect PR-4): parent sessions can now receive direct in-band `[child-crashed]` notices when their children crash by setting `notifyParentOnCrash: true` at spawn time. Notices are enqueued immediately for idle parents and queued for delivery at the next turn for busy parents, ensuring no interruption of in-flight work. Complements the existing external webhook notification path.
- 4e8640f: Implement restart-scheduler (PR-2 of crash-detect chantier): opt-in automatic restart for agent sessions that crash unexpectedly. Introduces RestartPolicy per-session configuration with exponential backoff and rolling-window crash-loop cap. Event-driven scheduling evaluates policy on session:exited; periodic sweep executes due restarts via in-place resume. Persists state so daemon restart mid-backoff preserves schedule. Includes comprehensive test suite and proper lifecycle integration.
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.
- 33221ac: Add Fix D: best-effort resume-context digest for blank-fallback resume scenarios. When a resume degrades to a fresh spawn (adapter doesn't support resume or its conversation store is missing), the daemon reconstructs a bounded summary from `events.jsonl` and injects it as initial context so the session isn't completely blind. Digest is strictly gated on blank-fallback flags—a successful native or ACP resume never gets double-fed its own context.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

- d9b4721: Add provider-agnostic inbound webhook endpoints (`POST /inbound/:slug`) with signature verification for agentpush, telegram, whatsapp, slack, and generic platforms. Includes per-endpoint deduplication, MCP tools for endpoint management (`inbound_endpoint_create`, `inbound_endpoint_list`, `inbound_endpoint_delete`), and comprehensive error handling to prevent webhook provider retry loops.
- 4bdea9f: Add per-model provider and adapter-level route selection to support free-routing adapters. This enables adapters like claude-sdk to offer models across multiple billing gateways while preserving money-safety for fixed-provider and derived-from-model adapters. Includes catalog widening logic to emit gateway routes only for adapters that can reach them, plus UI fanout for independent route choice on launch-menu drill-down.
- bcbb6f0: Resolve session route/model as a single source of truth: `resolveEffectiveRoute`, `modelWithRoute`, and `reconcileModelRoute` replace two disagreeing hand-written resolvers and prevent route/model overrides from describing two different billing endpoints (SPEC risk R2 / §4.4).
- 329ef7a: add PR settlement port to resolve pr activities via forge state
- 3123238: add SessionsRegistry.settlePendingWrites to drain in-flight command-log writes

### Patch Changes

- d94680f: Prevent overlapping cron executions from spawning duplicate agent sessions.
- bb63cf2: Fix Codex native OpenAI launch contract. A fixed-provider adapter (e.g. codex with `provider: "openai"`) matched against its own native gateway preset (`route.gateway: "openai"`) is now treated as a direct route: subscription mode stays eligible, the preset `base_url` is dropped, and no `base_url` option is injected. Non-native gateway presets and custom third-party routes remain unsupported for such adapters and are rejected at spawn time; the Configuration Lab filters them out of the route list.
- 636a01b: Fix Node `Buffer` to `BodyInit` incompatibility in Telegram outbound adapter by converting buffers to `Uint8Array<ArrayBuffer>` before passing them to `fetch()`.
- e9900a2: wire inbound endpoint store into the HTTP inbound route
- bd79483: forward routed auth and provider route to sandbox daemon
- 93e6309: Declare MastraCode's model-derived api-key auth contract and enforce it in catalog/session eligibility.
  - `@agentproto/adapter-mastracode`: adds `modelDerivedApiKey: true` so the runtime knows its direct-route API keys derive from the chosen model; the capability strategy now reports each provider's wire protocol (`apiMode`) and never claims subscription support.
  - `@agentproto/driver-agent-cli`: accepts `modelDerivedApiKey` in the AIP-45 manifest schema.
  - `@agentproto/runtime`: `buildCatalogModels` now includes api-key profiles for adapters that declare `modelDerivedApiKey`, matching `spawnEligibilityManifest`.
  - `agentproto-vscode`: Configuration Lab surfaces the corrected MastraCode eligibility (api-key profiles only; no Anthropic subscription defaults).

- 0a165ee: `agent_start`: surface a "did you mean" advisory when a spawn names an explicit
  `model` slug the local catalog doesn't know but a known id shares its bare
  product (a wrong- or missing-vendor/route prefix, e.g. `deepseek-chat` →
  `deepseek/deepseek-chat`, `moonshot/kimi-k2` → `moonshotai/kimi-k2`). Turns an
  opaque late 404 deep in the provider call into an actionable breadcrumb in the
  spawn response `warnings`. Advisory only — never a reject, so genuinely-new and
  free-form (hermes OpenRouter) slugs still spawn, in step with the money-safety
  guard's never-reject-an-unknown-model rule.
- e433dde: Map xAI pricing-catalog models to both the native `xai` route and the Anthropic-compatible `xai-anthropic` route so stored `xai` and `xai-anthropic` auth profiles resolve models correctly in the catalog. Registers `xai-anthropic` as a built-in custom route and surfaces compatibility rows for every xAI-priced model, fixing the UI showing 0 active / 0 models for these profiles.
- 10f9091: Fix: Gate /mcp endpoint against cross-origin browser drive-by attacks. Malicious web pages could previously fetch http://127.0.0.1:<port>/mcp and drive shell + filesystem tools via the loopback bypass in auth mode "none". Now the endpoint rejects untrusted cross-origin browser requests (identified by the Origin header) unless they present a valid bearer token. Native MCP clients and trusted localhost dev origins remain unaffected.
- 4566930: Security fix: add `guardBrowserOrigin()` to reject untrusted cross-origin browser requests to read routes that leak local session state (/conversations, /events, /workspaces, /worktrees). Also tighten CORS to only expose credentials to allowlisted origins, and redact query strings in logs to prevent token leakage.
- 75c9c90: Harden loopback auth bypass by checking the entire family of proxy forwarding headers (not just X-Forwarded-For), closing a gap where proxies that strip XFF but set X-Real-IP / CF-\* headers could bypass auth. Add explicit warning for unauthenticated passthrough tunnels so the exposure is surfaced to users instead of buried in prose.
- fea103e: Add optional `origin` field to session descriptors to track the source/channel (vscode, codex, cron, etc.) that spawned a session. The field flows through spawn inputs and persists for session lineage visibility in the tree view.
- 190a6ed: Add DNS-rebinding defense to HTTP server. Requests from the loopback interface now require a loopback Host header (127.0.0.1, localhost, or [::1]), preventing DNS-rebinding attacks that point malicious domains at 127.0.0.1 while retaining their own hostname in the HTTP Host header. Complements existing Origin-based CSRF guards with a second layer of protection. The `/health` endpoint remains publicly accessible as a harmless uptime probe.
- e44385b: Stamp origin field on spawns from CLI, cron scheduler, and webhook/inbound watcher to track source channel and improve session lineage visibility. Extends the origin-tracking feature introduced in PR #575.
- 93e21ea: Add Linux bubblewrap (`bwrap`) sandbox backend for the `command_execute` sandbox, implementing phase 3 of the command-sandbox work. The new `buildBwrapArgs()` function constructs bubblewrap confinement arguments using an allowlist-by-construction pattern: only bound paths are visible, system dirs are read-only, the workspace is read-write, and strict mode isolates the network namespace. `resolveCommandSandbox()` now returns the bwrap backend when bubblewrap is installed on Linux, falling back to null elsewhere. Includes comprehensive unit and end-to-end tests with platform-specific skips.
- 64db0fb: Fix catalog eligibility parity with the spawn wallet guard (SPEC §1c). `buildCatalogModels` now gates gateway-only models on direct (fixed-wallet) vendor routes, preventing 500 errors at spawn time when the model's actual serviceable routes differ from the route's billed wallet.
- 8a76cc9: Fix: `session_list` MCP tool and `GET /sessions` HTTP endpoint now exclude shell-command runs (`kind:"command"`) from the default view, since commands are execution logs—not resumable sessions—and were cluttering the UI. Commands remain fully accessible via explicit `kind:"command"` filter or `includeCommands:true` parameter (HTTP endpoint and MCP tool). Internal UI panels (sessions/agents-overview/bureau/session-story) now filter to live-able sessions only, matching the new default semantics.
- 7b0d7e7: Harden command sandbox security: implement fail-closed validation when a confinement mode is explicitly configured but the platform lacks the required backend (sandbox-exec on macOS or bwrap on Linux), and add loud per-call warnings when commands run unconfined. Add `AGENTPROTO_COMMAND_SANDBOX_MODE` environment variable to override workspace config without editing tracked files.
- 23c5d28: Forward `resolveSandboxProvider` to scoped orchestrator gateway, fixing regression where children spawned through the orchestrator sub-gateway couldn't resolve sandbox providers even though the daemon had one.
- 4dbd028: Fix flaky startFromFile test by rooting fixtures inside project instead of OS temp dir, ensuring vitest's module resolver keeps imports deterministic.
- c506d87: Extract OS-level process confinement (macOS Seatbelt / Linux bubblewrap) into shared `@agentproto/command-sandbox` package to resolve circular dependency, enabling both `command_execute` tool and adapter child processes to use identical backends. Add `extraWritePaths` support for write-capable directories (e.g., toolchain self-managed installs), and empirically-validated metadata-only `$HOME` allow for npm/npx compatibility. Apply confinement to agent-cli spawns in both ACP/MCP and print-protocol arms.
- dfe8023: Enhance session title handling with clear precedence (explicit title > label > derived) and extend MAX_LENGTH from 60 to 72 code points. Labels are now used verbatim when present, preventing boilerplate orchestrator prompts from creating useless titles—critical for agent spawns where caller intent lives in the label.
- 7f28982: Reject explicit worktree requests on nested spawns (depth > 0) to prevent silent data corruption. A nested spawn that passes an explicit `worktree: true` or `{slug}` request now fails loudly with a clear error message, pointing users to the `sandbox` pattern for isolated nested spawns. Implicit requests (no field or `false`) continue to silently spawn in-place as before, respecting the parent's working tree per AIP-46 §Delegation.
- 3f3333a: Add warning system for nested spawns into shared dirty working trees. Nested agent spawns that run implicitly in-place (no explicit `worktree` or `sandbox` request) now emit a non-fatal advisory warning when the inherited cwd is a shared, dirty git checkout. The warning is silenceable via the new `allowSharedCwd: true` parameter on both the MCP `agent_start` tool and HTTP `/sessions/agent` endpoint.

  Changes:
  - New `allowSharedCwd` parameter on `SpawnAgentSessionInput` (MCP + HTTP)
  - New `warnings?: string[]` field on successful spawn results
  - New `isSharedDirtyCwd()` function to detect shared dirty trees (skipped for daemon-provisioned worktrees)
  - `WorktreeDecision` now carries optional `warn` field for non-fatal notices
  - Comprehensive tests: dirty vs clean cwd, with/without `allowSharedCwd`, root vs nested, all three isolation modes

  Addresses remaining footgun after PR #622's explicit-worktree-at-depth rejection.

- 7465b6c: Harden git-spawn PATH and worktree-cwd anchoring to fix two runtime bugs surfaced by worktree-gc daemon cron. Narrow inherited PATH (frozen at daemon install time) is merged with standard system bin dirs to prevent spawned tools like git from ENOENT-ing. Worktree-specific git spawns are anchored to stable repoRoot instead of per-worktree paths to prevent TOCTOU race conditions where concurrent gc reaps cause misleading "spawn git ENOENT" errors.
- 2ef3bd1: Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
- 5becedc: Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify
- 1cbb910: Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

  The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.

- 358af0e: Fix first-party models incorrectly marked ineligible on vendor routes due to router pricing-key collisions. Introduce `resolvePricingExact` to avoid substring-matching false positives (e.g., `google/gemini-2.5-flash-image` → `gemini-2.5-flash`). Restore vendor route for `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` on direct Anthropic auth.
- 2627fe1: Add daemon-supervised sidecar manager for the @agentproto/llm-endpoint proxy. Implements LlmEndpointRegistry for full lifecycle management (start/stop/status) with concurrency-safe dedup, idempotency, health probing, and MCP tool bindings. Fixes concurrent-spawn orphan leak (Fix 1) and improves crash error visibility with log tail (Fix 2).
- f1484a4: Add `stripRouteSuffix()` utility to strip catalog @route suffix before passing model IDs to upstream providers, and fix llm-endpoint keyEnv from LLM_ENDPOINT_API_KEY to LLM_ENDPOINT_ACCESS_TOKENS.
- 0f10338: Add built-in custom route for local llm-endpoint Anthropic-compatible proxy. The runtime now registers the llm-endpoint route at daemon boot, allowing curated model references (e.g., moonshot/kimi-k2.7-code@llm-endpoint) to transparently route through the local proxy. Configuration is derived from the gateway preset to ensure single source of truth.
- 04f495f: Add `keepAlive` flag to allow sessions to opt out of idle-reaper auto-retirement. Sessions with `keepAlive: true` are never reaped regardless of idle time, useful for supervisors that legitimately park waiting on children or scheduled wakes. Configurable at spawn time via `agent_start`'s `keepAlive` parameter or toggled later with the new `session_set_keepalive` MCP tool. Persists across daemon restarts.
- 469bc47: Fix TypeScript type-checking errors: resolve `vi.spyOn` generic type incompatibility in crash-reaper.test.ts via structural typing, and make `crashDetectIntervalMs` optional in RegisterDaemonHealthToolsOptions for backwards compatibility with code predating this configuration knob.
- 9de8157: Add Box sandbox provider for ascii.dev Box cloud computers. The provider boots a Box, installs an always-on systemd unit for the agentproto daemon, and exposes the daemon's MCP endpoint via a stable hostname. Includes comprehensive test coverage for boot, connect, pause, and stop lifecycles.
- 511ce04: Add push-ingress (`POST /inbound`) and transmitter binding store for bidirectional contact routing. Introduces `inbound-router` shared logic for both poll and push ingress, `transmit_message` MCP tool for sending messages via imported agentpush aliases, and persistent bindings to route inbound replies into sessions. Modes: "spawn" (always new), "route" (bound sessions only), "route-or-spawn" (bound sessions or fallback spawn).
- 40d6a42: Implement resume-honesty fix (AIP-45 resumable capability): prevent silently presenting blank sessions as continuations. When adapters declare `capabilities.resumable: false` (e.g. hermes, mastra-agent), the restart path now gates all ACP-level resume attempts, substituting honest "fresh — resume not supported by X" labels and emitting `contextRestored: false` event flags. Lazy-revived unresumable sessions now get clear banners to prevent confusion with actual continuity.
- ec5f64f: Fix model ID routing for Anthropic-native adapters: reduce direct-anthropic refs (e.g., `anthropic/claude-sonnet-4-5`) to bare product IDs that the native Anthropic wire expects, while preserving vendor/product for gateway-routed models and non-Anthropic adapters.
- 3088e23: Test coverage: prove OpenRouter gpt-5.6 series models (luna/sol/terra and their -pro variants) are selectable in the VS Code picker and launchable through an OpenRouter api-key profile, with money-safety spawn guard validation.
- b373165: Fix race condition in resume-context-injection that caused CI flakes. Move digest building before banner writes to `events.jsonl` so the read doesn't race against asynchronous flush of transcriptWriter.recordEvent.
- 2f246ba: Add Telegram bot support to transmitter system via new provider-agnostic outbound abstraction. Includes telegram-bot-creds store with MCP tools (telegram_bot_token_set, telegram_bot_token_status, telegram_bot_set_webhook) for secure bot token management, telegram-proxy HTTP reverse proxy for webhook ingress, and sendOutbound dispatch supporting agentpush and Telegram. Updated transmit_message tool to accept provider parameter (defaults to agentpush for backward compatibility). Added comprehensive test coverage for security (path traversal, method validation), credential storage, and integration.
- f1b9828: Fix telegram inbound source to use channel name instead of chat ID, preventing binding lookup failures. Also skip disk read when persist is disabled to avoid test isolation issues.
- 29042ca: Generate OpenCode model menu from shared provider catalog; add model-derived API key auth support and router-prefixed model ID handling across runtime and VS Code configuration UI.
- cce3546: ## Progressive Sessions Webview Loading

  Introduces a new `GET /sessions/summaries` endpoint on the runtime that returns lightweight `SessionSummary` projections with pagination support. The VS Code Sessions webview now uses this endpoint to load the first page (50 summaries) instantly, then offers a "Load more" affordance for older sessions, improving first-paint performance when the daemon holds hundreds of sessions.

  ### Runtime (@agentproto/runtime)
  - Added `SessionSummary` interface — a lightweight projection of `SessionDescriptor` excluding large resume/transcript/policy context
  - Added `listSummaries()` method to `SessionsRegistry` with `limit`/`offset` pagination
  - Added `GET /sessions/summaries` HTTP endpoint

  ### VS Code Extension (agentproto-vscode)
  - Refactored Sessions webview to consume `SessionSummary` instead of full `SessionDescriptor`
  - Implemented progressive loading: bounded first page + "Load more" button
  - Pending optimistic rows merged from store on each render for instant spawn feedback
  - Intelligent refresh: re-fetches the currently loaded slice on SessionStore changes
  - Removed workspace dropdown filter (simplification for paginated model)

  ### Sandbox Box (@agentproto/sandbox-box)
  - Fixed flaky test: strip ANSI color codes from stdout when `FORCE_COLOR=1` is set

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 77e93e5: synthesize tool-result for orphaned pending tool calls at turn-end
- 4832ced: Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.
  - Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
  - Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
  - Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
  - Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.

- b3e1648: Fix a false-green where an un-authenticated agent turn reported success. The ACP client mapped any non-`cancelled`/`max_turns` `stopReason` — including `refusal`, which claude-sdk returns after a 401 auth failure — to a `completed` turn-end. Because the adapter also emits a `[claude-sdk error]` chunk, the turn is not empty, so the existing empty-turn guard missed it and the workflow step reported `done`. The ACP client now maps `refusal` and any unknown/missing `stopReason` to `reason: "error"` — while routing the budget-cap reasons (`max_tokens`, `max_turn_requests`) to the non-failing `max_turns` bucket so a legitimate long turn isn't misfired as an error — and the workflow agent-host fails a step whose turn ends with `reason: "error"` (not only empty turns), so an auth-failed reviewer run reports `failed` and falls back instead of passing blind.
- bd79483: test(runtime): settle pending writes before workspace teardown
- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [013e7b3]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [831d4f5]
- Updated dependencies [6ff42b4]
- Updated dependencies [645279d]
- Updated dependencies [5ba2032]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [4d200a9]
- Updated dependencies [f3f5e82]
- Updated dependencies [5becedc]
- Updated dependencies [5643cb6]
- Updated dependencies [23fa73e]
- Updated dependencies [655b4b6]
- Updated dependencies [1cbb910]
- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [f3b54ad]
- Updated dependencies [e81ad25]
- Updated dependencies [15abbee]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [68ef7fb]
- Updated dependencies [4832ced]
- Updated dependencies [b3e1648]
  - @agentproto/provider-presets@0.5.0
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/sandbox@0.2.0
  - @agentproto/auth@1.0.0
  - @agentproto/driver@0.2.0
  - @agentproto/acp@0.7.0
  - @agentproto/command-sandbox@0.2.0
  - @agentproto/routine@0.2.0
  - @agentproto/mcp-server@0.2.4
  - @agentproto/workflow-runtime@0.6.0
  - @agentproto/workflow@0.1.1
  - @agentproto/model-catalog@0.7.0
  - @agentproto/provider-kit@0.4.0
  - @agentproto/secrets@0.2.2
  - @agentproto/workflow-loader@0.1.2
  - @agentproto/providers-store@0.3.2
  - @agentproto/eval-reporters@0.2.4
  - @agentproto/telemetry-langfuse@0.2.3

## 1.1.0

### Minor Changes

- ed0c269: Add terminal input endpoint and UI toggle for conversation/terminal view switching.
  - HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
  - DaemonClient method `writeTerminalInput` for terminal input requests
  - VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
  - Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
  - View toggle logic for agent-cli and native-conversation PTY sessions

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.

### Patch Changes

- ee4ab3f: Fix linked git worktree session workspace resolution: sessions spawned in linked worktrees now group under their base repo's registered workspace instead of falling back to "default". Also adds symlink-aware path comparison to handle macOS `/tmp` → `/private/tmp` aliases.
- a4239ff: Repair two `WorkspaceEntry` test literals that predated the AIP-34
  `addedAt`/`updatedAt` fields becoming required, restoring `check-types` green.
- Updated dependencies [3edb7a7]
- Updated dependencies [a0b94fd]
- Updated dependencies [cc00682]
  - @agentproto/workflow-loader@0.1.1
  - @agentproto/auth@0.2.0
  - @agentproto/driver-agent-cli@2.0.1
  - @agentproto/secrets@0.2.1
  - @agentproto/acp@0.6.0
  - @agentproto/sandbox@0.1.5

## 1.0.0

### Major Changes

- 8e99f17: Fix session-bucket clobber on registry-read failure or skewed reload; readRegisteredSlugs now returns {slugs, ok}

### Minor Changes

- cc84da6: Fix claude-code project-slug encoding and add persisted conversation index + `conversation locate` verb
- 40cd699: Add archivable terminal sessions: session_archive/session_unarchive MCP tools + list({includeArchived})
- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- b331539: Add read-only GET /catalog/models + catalog_models MCP tool (SPEC §5)
- 40036de: Add canonical-posture layer (native mode resolution + prompt-injection fallback)
- 7441a7d: Add descriptor config-axis echo fields (effort/posture/route/contextProfile/accessProfile) + AuthMethod export
- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option
- d4d515e: Add axis-generic session:config-changed event, emitted from setModel alongside session:model-changed
- 48c55d5: Add live effort + live posture verbs and a model↔route switch guard
- 39ace5f: Add restart-with-override: axis overrides on session_restart + POST /sessions/:id/restart

### Patch Changes

- 1411e36: Don't engage native Anthropic billing-auth when a gateway base_url is set without an auth_token
- 6453ff6: Persist session_restart's resumedFrom/resumeVia on the stored descriptor
- 336c49c: Expose real agent-step ids/session ids in file-based workflow runs and fail a step on an empty (no-op) turn
- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode
- c3bfaea: Fix catalog_models 500 on router-prefixed OpenRouter model ids
- 3d403d7: Fix e2b sandbox timeout issues and add poll resilience.

  Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

  Changes:
  - **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
  - **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
  - **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
  - **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)

- Updated dependencies [9e30ad2]
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [57d1499]
- Updated dependencies [48c55d5]
- Updated dependencies [e3bacf3]
  - @agentproto/model-catalog@0.6.0
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0
  - @agentproto/acp@0.6.0
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/mcp-server@0.2.3
  - @agentproto/providers-store@0.3.1
  - @agentproto/sandbox@0.1.4
  - @agentproto/eval-reporters@0.2.3
  - @agentproto/telemetry-langfuse@0.2.2

## 0.8.0

### Minor Changes

- a4d091d: Add policy-driven git-worktree isolation on agent_start
- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription

### Patch Changes

- f392877: Sync docs with latest release features (interrupt, conversation_read, WORKTREE column, llm:context-windows, duration flags)
- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug
- Updated dependencies [719771e]
- Updated dependencies [9c2cec0]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
  - @agentproto/model-catalog@0.5.0
  - @agentproto/providers-store@0.3.0
  - @agentproto/provider-presets@0.4.0
  - @agentproto/provider-kit@0.3.0
  - @agentproto/sandbox@0.1.3
  - @agentproto/eval-reporters@0.2.2

## 0.7.0

### Minor Changes

- 0d74b1e: Add SessionDescriptor.title derived from first prompt text
- 8aec010: Add ConversationStore abstraction, hermes attach support, and conversation_read MCP verb
- e5d55a7: Record worktreePath and worktreeId on SessionDescriptor at spawn time
- 8778b9d: Add optional sessionId filter to policy_list, GET /policies, and policy ls
- 98bbebf: Partition session state per workspace (AIP-46 §State partitioning)
- bbc5070: Add interruptSession registry method, POST /sessions/:id/interrupt route, and agent_interrupt MCP verb

### Patch Changes

- 7b80d00: Add last-known-good fallback so a rebuilding adapter isn't reported as uninstalled
- a571bf9: Fix flaky command-log tests by polling instead of a fixed 20ms sleep
- 45ee7ef: Stop test gateways persisting fake session rows into the real ~/.agentproto/
- 5d2b869: Redact client slug from fixtures and drop machine-specific comment framing
- e0b4b85: Widen interrupt-settle timeout to 60s to avoid false timeouts on slow adapters
- Updated dependencies [b531fd1]
  - @agentproto/model-catalog@0.4.0
  - @agentproto/providers-store@0.2.1
  - @agentproto/sandbox@0.1.2

## 0.6.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- ed52691: Surface empty (zero-output, zero-tool) turns with empty:true on session:turn-end
- 7b6c8d0: Add daemon.authToken config field and --auth-token flag for persistent gateway bearer token
- 049c2fe: Add generic ACP agent support: curated catalog, config-defined agents, acp verb
- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- d425044: Add catalog-sourced billing-credential resolver for all adapters
- 6894d2e: Add named terminal presets via terminalPresets in config.json
- 6aafd13: Auto-detect workspace from cwd when no workspaceSlug is provided
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured
- ed241b8: Add GET /sessions/:id/events/stream SSE endpoint with exactly-once replay→live handoff
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- eec7b5d: Add opt-in idempotencyKey to agent_start for retry-safe process spawning
- ea44602: Add sessions story subcommand and expose runtime/session-story subpath export

### Patch Changes

- 410271d: Accept `id` alias on drive tools; coalesce session_monitor arg shapes
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- 031735e: Fix workspaceSlug derivation from cwd on terminal and raw spawn paths
- 33f5fa4: Fix sendPrompt silently dropping interrupt on the blocking prompt arm
- 769f75f: Re-resolve billing auth on session_restart to prevent silent credential fallback
- d85e129: Clear frozen in-flight flags on already-terminal ghosts at snapshot load
- 475249b: Clear frozen in-flight flags on forced session termination (daemon-restart path)
- 8e7353a: Extract providers-store into a leaf package; fix llm-endpoint boot to inject stored provider keys
- 40fb9e8: Reject out-of-window contextUsed values instead of surfacing impossible occupancy figures
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 1549bdd: Close read-path gap for stale out-of-window contextUsed (#364 follow-up)
- ff4617c: Fix blockedOn latching when a tool fails (error event now releases it)
- c8198c6: Fix dropped tool-call arguments from non-terminal ACP tool_call_update frames
- Updated dependencies [1b282ab]
- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [0ea6fc1]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [8a4d5d5]
- Updated dependencies [d425044]
- Updated dependencies [c430b9f]
- Updated dependencies [d924e95]
- Updated dependencies [94a7e90]
- Updated dependencies [3639abd]
- Updated dependencies [8e7353a]
- Updated dependencies [a32bb69]
- Updated dependencies [e0fbccc]
- Updated dependencies [c8198c6]
  - @agentproto/provider-presets@0.3.0
  - @agentproto/model-catalog@0.3.0
  - @agentproto/acp@0.5.0
  - @agentproto/agent@0.2.1
  - @agentproto/eval-reporters@0.2.1
  - @agentproto/manifest@0.2.1
  - @agentproto/mcp-server@0.2.2
  - @agentproto/provider-kit@0.2.1
  - @agentproto/redaction@0.2.1
  - @agentproto/sandbox@0.1.1
  - @agentproto/secrets@0.2.0
  - @agentproto/telemetry-langfuse@0.2.1
  - @agentproto/workflow-loader@0.1.0
  - @agentproto/workflow-runtime@0.4.0
  - @agentproto/workflow@0.1.0
  - @agentproto/providers-store@0.2.0

## 0.5.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 99a5c60: Add agentproto_session_story MCP app — per-session story panel with buildStory heuristic
- 80ca385: Add per-session usage observability: cost + tokens, live via MCP + durable
- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 7f1584d: surface blockedOn (subagent|command) on SessionDescriptor
- af10521: add display-mode toggle (fullscreen/pip) to all ui:// panel bridges
- 517fe8c: Add agentproto_terminal MCP App: live PTY over WebSocket with CSP connectDomains
- e231d80: Add spawn-time role profiles (executor/supervisor) with hard delegation-tool gate
- 7ba7e06: expose eval-reporter MCP tools on the daemon gateway
- ec70cda: Add interrupt flag to agent_prompt for soft Ctrl-C mid-turn redirect
- 4b93900: Add role registry, privilege-lattice spawn gate, and role_list MCP tool
- e73dae1: Add enter and b64 options to terminal_input for reliable TUI key submission
- a7ccd54: Add langfuseSessionTracer and extract shared createIngestionClient with atomic-drain flush
- 2d23f82: Add filterSessionObserver and opt-in Langfuse tracing per session
- 1813814: Add command_execute JSONL audit log and command_log_tail MCP tool
- b3921a9: Add WorkflowRunner.startFromFile and workflow_run_file MCP tool
- fdb8ea1: Add credentialRef + headers to AcpMcpServer for brokered child-MCP auth at spawn time
- 1c69f14: Add sandbox provider family: list_sandbox_providers + setup_sandbox_provider MCP tools
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy
- afe2541: Add daemon_health MCP tool for cheap in-process liveness probing
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field
- b588e36: Add a `defaults` block to `~/.agentproto/config.json` — global and per-adapter `skills`/`options` auto-applied to every `agent_start` spawn. A normalized `skills: string[]` is folded into the resolved adapter's native option shape (e.g. hermes' comma-joined `--skills a,b`); adapters with no declared `skills` option are a no-op.

### Patch Changes

- ba74049: Guarantee a terminal turn-end for every agent turn (exited/error/aborted)
- 6c83622: Emit usage_update transcript events for hermes and mastracode adapters
- c4873a2: fix MCP Apps panels: forward resources/\* through mcp-bridge + spec-correct ui/initialize handshake
- 94740f9: Fix session-story panel rendering Markdown as literal text instead of HTML
- 2532d33: Scrub ambient Anthropic key under gateway base_url; provider-driven bearer auth
- e2388e8: fix(tunnel): redirect cloudflared stdio to file to prevent pipe back-pressure wedge
- 665903e: keep agent_output visible during tool-busy turns; never drop tool errors
- 863d6d9: fix(runtime): stop provider default credentialsFile shadowing named tunnel creds
- 48f658c: Extract SessionObserver seam for pluggable per-session transcript taps
- e5389c9: Trust cli.agentproto.sh origin so the panel PTY terminal connects
- 7bb147c: Forward trace flag through POST /sessions/agent HTTP route
- 973b553: terminal_input: send enter CR as isolated write for paste-safe submit
- bd4d7a0: Add value-scan redactor and secrets slug; bump runtime default tracer to secrets
- b77a552: Rename adapter-kit → provider-kit; add adapter-kit@0.2.0 compatibility shim
- 13991da: Harden role dispositions to explicitly prohibit native CLI subagent/Task-tool delegation
- 5747d5f: Trim session-story execute() payload when sessionId is known; add full-panel deep-link
- b1ce54c: De-flake command-log test by returning the write promise instead of a fixed delay
- fad8300: Fix claude-sdk idle watchdog false-abort and frozen ring on long thinking turns
- 16c85e7: Fix cron prompt-session resilience: skip if busy, auto-resume if dead, fix daemon shutdown hang
- 2d6aead: Fix session_restart resuming wrong conversation via fs-probe sibling leak
- 6cc9e25: Dedupe sandbox capability constant, drop redundant author guard + unused token-env export
- 6bbd6cd: Sessions panel: turn-aware status badge for agent-cli sessions. A running agent-cli process now shows `working` (turn in flight), `waiting` (awaiting input), or `idle` (process alive, no turn running) instead of a flat `running`, reading the `busy`/`awaitingInput` descriptor fields.
- Updated dependencies [f8ebe41]
- Updated dependencies [80ca385]
- Updated dependencies [6a5c41c]
- Updated dependencies [7aaf24a]
- Updated dependencies [126f7c6]
- Updated dependencies [aa70df9]
- Updated dependencies [310de1a]
- Updated dependencies [d9726d3]
- Updated dependencies [5b9b5ec]
- Updated dependencies [a7ccd54]
- Updated dependencies [bd4d7a0]
- Updated dependencies [b77a552]
- Updated dependencies [6a0d8fe]
- Updated dependencies [2154ed5]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
- Updated dependencies [e029a35]
- Updated dependencies [553597a]
- Updated dependencies [abb49cf]
- Updated dependencies [34cfcb5]
- Updated dependencies [2adc163]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/acp@0.4.0
  - @agentproto/sandbox@0.1.0
  - @agentproto/telemetry-langfuse@0.2.0
  - @agentproto/eval-reporters@0.2.0
  - @agentproto/redaction@0.2.0
  - @agentproto/provider-kit@0.2.0
  - @agentproto/provider-presets@0.2.0

## 0.4.0

### Minor Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*\_, terminal\__, command\*\*, file*_, directory\__, browser\*\*, policy*_, routine\_\_, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.
- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 17aff95: Add durable cron scheduler with MCP tools, REST routes, and CLI verb
- 5c207ca: Add scriptable session/policy wait — REST endpoints and CLI subcommand
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 5616041: Add session_restart MCP tool and extract shared resume decision tree
- 111a599: Add prompt-session cron action to re-prompt a live session
- 29d9c55: Add REST parity for routines, workflows, and policies HTTP routes
- 4f1565b: Share agent_start spawn logic between MCP tool and HTTP route via spawnAgentSession
- 3ab696d: Render tool calls/results informatively instead of the generic `[tool] view` line
- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 79a209a: Add structured per-session transcript capture and daemon-events export source
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation
- e27fc94: Add GET /sessions/:id/events for incremental polling; fix mastra tool_start args

### Patch Changes

- f89be1f: Default-mount daemon MCP gateway for hermes agent_start spawns; fix orchestrator merge-line bug
- fb1e5f0: Thread daemonMcpUrl into scoped orchestrator gateway to fix hermes zero-tool spawns
- a648994: Fix processAlive returning undefined from findByIdOrName on live sessions
- 71c52eb: Fix policy_attach gates throwing "cwd escapes workspace" for worktree sessions
- 3812f01: Don't duplicate a salient arg already baked into a curated tool title
- 8ce517b: Fix silent prompt-delivery failures for dead and busy sessions
- 837967a: Fix transcript-writer stripping newlines from text-delta/thought events
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [3ab696d]
- Updated dependencies [caab49e]
- Updated dependencies [79a209a]
- Updated dependencies [3cfe18a]
- Updated dependencies [887ea34]
- Updated dependencies [987db7b]
- Updated dependencies [4b76485]
- Updated dependencies [a5c4701]
  - @agentproto/acp@0.3.0
  - @agentproto/workflow-runtime@0.2.0

## 0.3.0

### Minor Changes

- 7a310ff: Add model-catalog package, provider-key store, and `agentproto models` command

## 0.2.0

### Minor Changes

- ea9be98: Wire the browser CLI verb into the router and register browser MCP tools (start_browser / list_adapter_browsers) in the gateway.
- e33d99a: start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
- 593b0fc: Wire RoutineRunner into root gateway and persist runs to disk
- 358949b: Expose optional per-session notifyUrl on start_agent_session tool
- 79149d5: Add InboundWatcher — poll agentpush and spawn agents on inbound events
- fc6fd0b: Add session cost/cap, wait:true one-shot, clean output, model echo, wait_for_any cursor
- 250f474: Migrate tunnel providers onto a slug-keyed adapter-kit registry; ngrok now creatable end-to-end; third-party providers pluggable
- dc870cf: tool: toolFromManifestOnly + optional inputSchema/outputSchema; runtime: session lifecycle events on bus + completion-policy supervisor MVP
- 3e348e3: Add WP3 policy persistence: boot reload, re-arm, and session-absent cancellation for CompletionPolicySupervisor
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- a15acc4: Add fan-in completion policy (WP4): attach_policy accepts sessionIds[] for all-of groups
- 618d424: Add orchestrator sub-gateway WP2–WP4: scoped MCP endpoint, scope-token registry, recursion guardrails
- 452b751: Add agents-overview + bureau-sessions MCP App panels and summarize_session tool
- 9cacd25: Add WP6 subtree-scoped supervisor composition for child orchestrators
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- ec769ab: Extract daemon helpers, add POST /sessions/browser route, fix stop_browser return shape
- 0d3b8f9: Add @agentproto/adapter-kit and migrate tunnel/browser/CLI adapter families onto it
- 7a89e37: Surface exportAgentSession via export_session MCP tool and sessions export CLI
- 1b8ae4e: Add browser_screenshot MCP tool — base64 frame proxy for live agent-browser view
- e6c9b80: Routine runner, orchestration tools, session event bus, event ring, transcript export.

  Adds `RoutineRunner` for scheduled / event-triggered routine execution, `SessionEventBus` for typed intra-session pub-sub, `EventRing` as a bounded circular buffer for session events, `orchestration-tools` (run-routine, list-routines AIP tools), and `exportTranscript` for full-session transcript serialisation. Also extends `sessions.ts` with `awaitingInput` state and browser-session fields (non-breaking additions).

- 405ea4d: Add MCP Apps adapter and agentproto_sessions panel (AgnoMcpApp)
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 0c7ced0: Fix bureau /mcp dispatch: add text/event-stream to Accept header to prevent HTTP 406
- 4277e54: Fix RoutineRunner fast-session race and honour start_routine cwd
- 8e540c3: Update browser session label on idempotent registerBrowser hit
- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- 43f9c8a: Add central daemon registry so CLI discovers a daemon from any cwd
- c938b78: Fix JSON-stringified union/object MCP params being rejected by zod (cowork client compat)
- 1769728: Fix attach_policy MCP schema to expose judge-gate variant alongside shell gate
- 7fec1bc: Add multi-field makeSetupTool variant; migrate cloudflare-named to SetupField[]
- 979d01a: Make ngrok check() env-independent via injectable probeBinary; fixes CI
- b86264b: fix(browser): HTTP route and registerBrowser cloud/local parity
- Updated dependencies [c6a90e2]
- Updated dependencies [250f474]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
- Updated dependencies [0d3b8f9]
- Updated dependencies [7fec1bc]
- Updated dependencies [4b2c9ec]
- Updated dependencies [2186e9e]
  - @agentproto/acp@0.2.0
  - @agentproto/adapter-kit@0.1.0
  - @agentproto/mcp-server@0.2.1

## 0.1.1

### Patch Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool
- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/agent@0.2.0
  - @agentproto/manifest@0.2.0
  - @agentproto/mcp-server@0.2.0

## 0.1.0

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
- Updated dependencies [44192c9]
  - @agentproto/agent@0.1.0
  - @agentproto/manifest@0.1.0
  - @agentproto/mcp-server@0.1.0
