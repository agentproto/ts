# agent_start

Spawn a long-running agent CLI (claude-code, hermes, …) on the host. The
session stays alive across multiple turns — call `agent_prompt` to continue
the conversation. Returns the session id + initial descriptor.

This doc holds the field-level detail cut from the tool's schema to keep
`tools/list` cheap. Each schema field description ends with a pointer like
`Details: tool_help {name:"agent_start", topic:"worktree"}` — pass that
`topic` to get just one section, or omit it for the whole doc.

## adapter

Adapter slug — one of the installed `@agentproto/adapter-*` packages (e.g.
'claude-code', 'hermes', 'aider'). Omit only when `presetId` names a saved
preset with an adapter.

## harness

Canonical harness slug — alias for `adapter`. Accepts the same values; use
whichever field your caller produces.

## presetId

Saved user spawn preset id from `agentproto preset list`. Its adapter and
decomposed axes are applied first; explicit fields on this call override it.

## workspaceSlug

Workspace slug from `agentproto workspace list`. The daemon resolves it to
an absolute path. Omit to use the `cwd` field or the active workspace.

## cwd

Absolute path to spawn the agent in. Wins over `workspaceSlug` when both are
set — except for a `sandbox` spawn that also names a `workspaceSlug` (below).

**With `sandbox` + `workspaceSlug`** the workspace's remote is ALWAYS cloned into
the box (checkout under the box home, `wt/<slug>` work branch, git credential
helper + `GIT_TOKEN`/`GH_TOKEN`, delivery/checkpoints), whether or not `cwd` is
set. `cwd` is then read as a working directory INSIDE the box: a relative path
(resolved against the checkout) or an absolute path under the box home. The box
home itself (e.g. `/home/user`, the provider default) means "no preference" and
lands in the checkout. A HOST path (`/Users/…`, `/Volumes/…`, `C:\…`) or a path
outside the box home is ignored: the session starts in the checkout and the
spawn result carries a warning.

**With `sandbox` and `cwd` but NO `workspaceSlug`** the box has no repo clone, no
git token and no delivery branch (a private repo cannot be cloned or pushed and
`gh` is unauthenticated); the spawn result carries a warning saying so. Pass
`workspaceSlug` to get them. A `device:<fp>` target is unchanged: its `cwd` is a
path on the paired machine.

## prompt

Optional initial prompt. The session is spawned and the prompt dispatched
in one shot — equivalent to `start` then `prompt` back-to-back. Skip to
spawn idle.

## label

Free-text label that surfaces in `agent_sessions_list` and the UI — useful
for tagging sessions with a conversation id or operator name.

## mode

Manifest-declared mode id (AIP-45 `modes`) applied at spawn time, BEFORE the
child process starts — e.g. claude-code's 'plan' (read-only: reasons and
proposes but does not edit or run commands), 'accept-edits',
'bypass-permissions'; codex's 'read-only' / 'full-access'; mastracode/
opencode's 'plan' / 'build'. Adapters that don't declare `modes` (e.g.
hermes) reject ANY value here — only pass this for adapters known to
support it. Omit for the adapter's normal interactive mode.

## origin

Source label for this spawn — the calling channel/harness (codex, cowork,
vscode, cron, …). Descriptor-only: groups the session under a source node
in the tree. In-repo callers set it; the mcp-bridge can auto-stamp it from
the host clientInfo.

## parentSessionId

Parent-lineage hint: attribute this spawn to a logical parent session so it
nests under that node in the sessions tree instead of appearing as a
depth-0 root. Pass the `id` of the session doing the spawning (e.g. an
agent-to-agent `agent_start`). The child's `depth` is derived from the
parent (parent depth + 1); you don't set it. Ignored when this call arrives
through the scoped orchestrator gateway — that path derives the parent from
its own token, which always wins over this hint.

## succeeds

Lineage handover: declare THIS new session the SUCCESSOR of another session
(id). The replaced row's LIVE children are re-parented onto the new session
and the new session takes the replaced row's place in the spawn tree - so the
successor can DRIVE those children (`agent_prompt` / `agent_interrupt` /
`agent_kill` / `session_restart`: the session-owner gate keys on
`parentSessionId`) and the children report UP to the successor
(`message_parent` resolves the caller's recorded parent) instead of a row
that is gone.

Use it when a persistent orchestrator ("the brain") is replaced by a NEW
session - a restart, a wallet change, a `continue-fresh` - while its
supervisors and executors stay alive. `session_continue_fresh` performs the
same handover automatically; `succeeds` is the explicit form, for a
successor that is not a continuation of the same conversation.

Who may declare it: the human operator, the replaced session itself (a brain
handing over its own position), or the session that owns the replaced row. A
third party - including one of the children being handed over - is refused
before anything is spawned.

The call's result carries a `lineageHandover` block (`from`, `to`,
`adopted`, `skipped`) and the succession is recorded on both descriptors
(`succeededBy` / `succeeds`) - that record is what authorizes
`session_adopt`.

## attach

Parent-attach control, mirroring `worktree`. By DEFAULT (omitted) a spawn
attaches under the session that made it — the daemon derives that parent
from the trusted caller id, so a supervisor's executors nest instead of
appearing as depth-0 roots, no `parentSessionId` needed. Pass `false` to
launch an INDEPENDENT root (no parent) — the deliberate detached spawn.
`true` forces attach even under an `on-request` daemon policy; `{ parent:
"<id>" }` pins an explicit parent. Ignored when this call arrives through
the scoped orchestrator gateway (the scope token wins). Descriptor-only
lineage: never relaxes a depth-gated worktree/role guard.

## boardId

Task-board pin for the spawned child, stamped onto its descriptor as
`meta.boardId`. The Task ledger resolves the child's default board from
this BEFORE walking `parentSessionId` lineage — so a client spawning
several depth-0 root sessions (no shared lineage) can join them all onto
ONE shared board. An explicit `boardId` passed on a task verb still wins
over this pin. Omit for the lineage-derived `tree:<root>` default.

## idempotencyKey

Caller-declared 'this is the same logical spawn' token — a PROMISE, not a
guess. A retried agent_start call (e.g. after a slow/lost response) that
repeats the same `idempotencyKey` for the same `adapter`+`cwd` within
~10min of a successful spawn gets that SAME session's descriptor back
instead of forking a second process — the response carries `deduped: true`
and `dedupeSource: "explicit"` so you can tell. Always wins over the
daemon's own derived key (see `dedupe` below) when both would apply.
Omitting this does NOT mean 'spawn unconditionally' — see `dedupe`.

## dedupe

Per-call override for the daemon's `spawn.dedupe` policy — what happens
when NO `idempotencyKey` is supplied. By DEFAULT (`spawn.dedupe: "always"`)
a spawn that carries a `label` gets an IMPLICIT key derived from that label
plus a hash of `prompt`, and dedupes against it exactly like an explicit
key — set `dedupeSource: "implicit"` on the response (alongside `deduped:
true`) so you can tell it wasn't your own promise that matched. A spawn
with no `label` is never touched by this — deliberate parallel fan-out into
one cwd (a real, exercised pattern here) needs no label and stays exactly
as many sessions as you asked for. Pass `dedupe: false` to opt this ONE
spawn out of implicit derivation regardless of policy — the escape hatch,
mirroring `attach: false` / `worktree: false`. `dedupe: true` forces
derivation even under an `"on-request"` daemon policy, mirroring `attach:
true`. Unrelated and NOT covered by this flag: a `worktree` spawn that
lands in a worktree another LIVE session already occupies under the same
`label` is always refused (`dedupeSource: "worktree-cwd"`) — a shared
worktree, unlike a shared plain cwd, is never a legitimate fan-out.

## permissionHold

Start the session in permission-hold mode: every ACP permission request the
agent raises (Write, Bash, …) is SURFACED and HELD in the cross-session
inbox (`permissions_list` / `permissions_respond`) instead of
auto-answered, and the agent blocks until a human/orchestrator approves or
denies it. Default false = today's auto-answer behaviour. ACP adapters
only; others ignore it.

## notifyParentOnCrash

Opt this spawn into a direct in-band crash notice to its parent: if THIS
session later crashes (adapter process gone between turns), the parent
(`parentSessionId`, direct or inherited) is told via `[child-crashed]
<label/id>: <reason> — <lastError>` — enqueued immediately if the parent is
alive and idle, or queued for its next turn (never interrupting an
in-flight one) if it's busy. Default false. The free external webhook
(`notifyUrl`) already fires on any crash regardless of this flag — this
only adds the direct signal into the parent's OWN session, for a delegating
supervisor that wants to react to a child's death without polling.

## sentinel

Set `false` to opt this spawn out of sentinel auto-link (AIP-60 §6): when the
session opens a PR (via `command_execute`'s `gh pr create` stamper, or either
`pr-provenance-reconciler.ts` lane discovering one), the daemon normally
creates a sentinel watching that PR for this session — `match:
github:owner/repo#N` with the default PR type set, `until:
subject_terminal`, `label: auto:pr#N`, `group: <this session id>`, delivered
back to this session at `next-turn` urgency. `sentinel: false` disables that
for this session specifically, regardless of the daemon's
`sentinel.autoWatchPrs` config. Default (unset) = allowed, still subject to
that config default (which itself defaults to `true` only when `local-gh`
(the host's authenticated `gh` CLI) is usable). The auto-created sentinel is
NOT torn down if this session later exits for good — its provider-side watch
keeps running and events park/orphan through the same dead-session path
every sentinel uses; `sentinel_list` / `agentproto sentinel list` still shows
it, filterable by `group: <session id>`.

## allowSharedCwd

Acknowledge that this nested spawn WILL run in place inside its parent's
working tree even when that tree has uncommitted changes and isn't an
isolated worktree — silencing the shared-dirty-cwd warning agent_start
otherwise returns in `warnings`. Only relevant for a delegated (depth > 0)
spawn with no `worktree` and no `sandbox`; ignored otherwise. Default false
= warn.

## keepAlive

Exempt this session from the idle-reaper: it is never auto-retired for
sitting idle, no matter how long. For a supervisor that legitimately parks
— waiting on a child, waiting on a scheduled wake — idle looks identical to
finished, and the reaper would otherwise pull it out from under you.
Default false = today's behaviour. Toggle later with
`session_set_keepalive`.

## options

Manifest-declared option id → value map (AIP-45 `options`), applied at
spawn time alongside `mode` — e.g. hermes' `skills` (string, prepended
before the subcommand) or a boolean flag appended when true. Each value is
validated against the option's declared `type`/`enum`/`min`/`max`; unknown
ids reject. Adapters that don't declare a given option id reject it.

## skills

Normalized, adapter-agnostic skill ids for this session (e.g.
['agentproto']). Merges with `~/.agentproto/config.json`'s
`defaults.skills` / `defaults.adapters.<slug>.skills` (global < per-adapter
< this field, which REPLACES rather than unions the config defaults when
provided — a deliberate exact set). Folded into `options.skills` using the
resolved adapter's declared shape (e.g. hermes' comma-joined `--skills
a,b`); adapters with no declared `skills` option (e.g. claude-code, which
auto-discovers from `~/.claude/skills`) ignore this — no-op.

## bundles

Capability bundle ids (`bundle_list`) to attach — each expands to its
imported MCPs (mounted as native MCP servers, never via the
`mcp_imported_*` indirection) + skills, and optionally the daemon's own
`/mcp`. REPLACES (not unions) config defaults when set.

## model

Model identifier to pass to the adapter (e.g. 'claude-opus-4-8'). For ACP
adapters (claude-code) applied via session/set_config_option after
newSession — NOT via a CLI flag. Others may ignore it.

## effort

Reasoning effort level (e.g. 'low', 'medium', 'high', 'xhigh', 'max',
'ultracode'). IMPORTANT: effort is calibrated per model — the same label
maps to different compute budgets across models, and defaults differ by
model (Sonnet 4.6 / Opus 4.8 default 'high'; Opus 4.7 default 'xhigh').
'max' and 'ultracode' are session-only. Omit to keep the model's own
default.

## route

Billing route/gateway. This is independent of model and named access
profile.

## access

Named auth profile to bill at initial spawn; resolved from the local
keychain.

## inference

Bind this spawn to a local/LAN inference endpoint instead of a cloud model.
Accepts `{endpoint}`, `{endpoint, model}`, or the shorthand
`{model: "<model>@<device|endpoint>"}`. A registered endpoint is a
local/LAN inference endpoint id (`agentproto llm endpoints list`), or
`"<id>@<device>"` for a paired device's own shared endpoint; a bare model
id pairs with `endpoint`, or use the shorthand `"<model>@<device|endpoint>"`
when `endpoint` is omitted. Runs a fit check (the harness's known
first-request size vs the endpoint's loaded ctx) BEFORE spawning and refuses
with an actionable error on a clear miss (`force` overrides the refusal;
the check still runs and still warns). `headroomPct` is the percentage held
back from the endpoint's loaded ctx for the fit check (default 25). Defaults
`adapter`/`harness` to "pi" when neither is set. Mutually exclusive with
`model`/`route`/`access` — set those directly instead of `inference`, never
both.

## posture

Canonical agent posture (plan, bypass, accept-edits, read-only) or native
harness mode.

## contextProfile

Context intake profile (for example full or lean).

## auth

Deterministic billing-auth mode + EXPLICIT credential for adapters that
declare a subscription login and/or an API-key provider (any other adapter
fails with `unsupported_auth_mode`). EXPLICIT credential selection, not
scrub-by-absence: `mode` picks 'subscription' (default) or 'api-key';
`token`/`apiKey` (matching the resolved mode) is the secret VALUE, merged
against `~/.agentproto/config.json`'s
`defaults.adapters.claude-code.auth` (this field's `mode` wins; the
credential for the resolved mode wins over the matching config field). For
claude-code, 'subscription' SETS CLAUDE_CODE_OAUTH_TOKEN to `token` (a
bearer token minted via `claude setup-token` — bills the Max/Pro
subscription, not API credits) and DELETES ANTHROPIC_API_KEY + the
cloud-provider redirect toggles + ANTHROPIC_BASE_URL. 'api-key' SETS
ANTHROPIC_API_KEY to `apiKey` and DELETES ANTHROPIC_AUTH_TOKEN — the
deliberate 'bill the API' choice. FAILS FAST (refuses the spawn, no
fallback) when the resolved mode has no credential configured anywhere. The
secret is never logged or echoed back — only a fingerprint appears on the
session descriptor / `agent_sessions_list`. Adapters that don't declare
this vocabulary ignore this field entirely. `source: "claude-code-oauth"`
(subscription mode, opt-in) instead reads the bearer FRESH on every spawn
from the local Claude Code login (Keychain / ~/.claude/.credentials.json) —
effectively self-refreshing; an explicit `token` still wins over it.

## mcpServers

MCP servers to mount into the spawned agent's session at spawn time.
Forwarded verbatim to `session/new.mcpServers` on the ACP arm — gives the
child agent a host-chosen scoped toolset (e.g. the daemon's own
orchestration gateway so it can spawn + supervise sub-agents). Adapters
that don't model MCP mounting ignore it.

A `mcpServers` entry in the descriptor (or the daemon self-mount) only
means the mount was *requested*: it does not guarantee the child actually
loaded any tools. A client can connect yet end up with 0 tools if the
server's MCP handshake is not one it can use (e.g. a protocol-era mismatch
on `server/discover` / `tools/list`). The daemon watches its own `/mcp` mount
per session: read `session_capabilities` (`mcpServers[].status`, `toolCount`,
`tools`) to see what the harness actually listed, and watch `session_events_poll`
for `mcp:degraded` (a turn ended with the mount never listed, listing zero
tools, or failing).

Each entry's `headers` are static HTTP headers sent with every request to
an `http`/`sse` server (ignored for `stdio`). `credentialRef` resolves a
brokered credential at spawn time into additional headers (typically
`Authorization`) — the secret never lives in env/config, and brokered
headers win on collision with `headers`. `args`/`env` are `stdio`-only
(argv and extra environment for the launched server; ignored for
`http`/`sse`).

## orchestrator

Make this child a SCOPED orchestrator — auto-mount the daemon's own
orchestration MCP tools (start/prompt/wait/poll/output + subtree
list/kill) so it can spawn and supervise its OWN sub-agents. `true` = the
default curated subset; `{ tools: [...] }` narrows it. The daemon mints a
per-child scope-token, injects the scoped sub-gateway URL into the child's
session (alongside any `mcpServers` you pass), and revokes the token when
the session exits. Shell/fs/remote/import/terminal tools are NEVER exposed
this way.

The nested `tools` array is an explicit allowlist — narrows the
orchestration toolset to ⊆ the default subset; names outside the default
are dropped (a child can never widen its own scope). `maxDepth` (default 3,
hard ceiling 8) is the max recursion depth reachable through this child — a
spawn that would exceed it is rejected, and a recursive spawn can only
LOWER the inherited cap, never raise it. `maxChildren` (default 8) is the
max concurrently-alive sub-agents this child may spawn, same
lower-only rule for a recursive spawn.

## notifyUrl

Optional per-session webhook URL. POSTed (fire-and-forget) on this
session's turn-end / awaiting-input / exited events, in addition to any
global notify URL.

## notifySecret

Optional Standard Webhooks secret (`whsec_...`) for `notifyUrl`. When set,
each POST carries `webhook-id` / `webhook-timestamp` / `webhook-signature`
headers (HMAC-SHA256 over `id.timestamp.body`); the receiver verifies them
to confirm the daemon sent it. Omit for the unauthenticated (legacy)
behavior — ignored without `notifyUrl`.

## wait

Block until the spawned session's first turn completes and include the
cleaned output in the response. Default false = return the descriptor
immediately. This blocks for the child's ENTIRE first turn (~40-90s+), not
just the spawn. Batching several `wait: true` calls in one turn does NOT
run them in parallel: harnesses that execute tool calls sequentially
serialize them, each wait blocking its slot until its child's turn ends.
For parallel fan-out spawn with `wait: false` (all spawns return in
seconds), then wait on completion separately via `agentproto sessions wait
<id> --until turn-end` (detached/background) or a completion policy via
`policy_attach`.

## maxCostUsd

Hard ceiling on cumulative session cost (USD). The session is stopped at a
turn-end once exceeded.

## costBudget

Windowed cost-budget cap (DISTINCT from `maxCostUsd`). Auto-attaches a
governance policy that trips `policy:failed` when the rolling windowed
spend for `scope` crosses `maxCostUsd`. Never kills the session — it trips
a policy for a supervisor to act on. `window` is a rolling window spec
("5h"/"7d"/"P7D"); `scope` is `session` (this session only) or `profile`
(every session on its auth profile).

## restartPolicy

Opt-in auto-restart policy. When set, an unexpected death (`crashed`
and/or `error`, per `on`) is automatically revived IN PLACE (reusing the
resume machinery — same session id, same conversation) after an
exponential backoff, up to a rolling-window crash-loop cap. Omit for
today's behaviour: a dead session stays dead until a human/orchestrator
prompts or restarts it.

`on` lists which automatic death reasons trigger a restart —
never a clean exit, an operator kill, an idle-reap, a daemon-restart death,
or a cost-budget kill, regardless of this list. `maxRetries` +
`windowMs` form the rolling-window crash-loop cap: give up once
`maxRetries` restarts have fired within `windowMs`. `baseDelayMs` is the
first restart's backoff delay, compounded by `factor` on each subsequent
restart up to the `maxDelayMs` ceiling. `resume` is reserved for a future
explicit resume-vs-fresh-spawn toggle; today's behaviour always revives in
place.

`"sandbox-gone"` is a third `on` value, for sessions that ran inside a
sandbox box (`agent_start.sandbox`): when the BOX itself is gone — lifetime
cap reached, the provider reclaimed it, or it became unreachable past
recovery — an in-place revival is structurally impossible, so a policy
listing `"sandbox-gone"` instead moves the session to a FRESH box: the same
path `session_restart` takes (re-clone the workspace remote, re-check the
recorded `wt/` work branch out, restore the last checkpoint snapshot) after
the same backoff and under the same crash-loop cap. The replacement session
is prompted once to continue the original task from where the pushed work
stops. When the move is blocked (no workspace remote, no tarball checkpoint,
provider missing) the session is left dead with a single `[sandbox-gone]`
notice — never a retry loop.

To opt in once for every box session instead of per spawn, set
`agentproto config set daemon.sandboxGoneRestartDefault true` (off unless
set; applies on daemon restart). A box session spawned with no explicit
`restartPolicy` then gets a policy listing only `"sandbox-gone"` — a session
that passes its own `restartPolicy` keeps it. Turning it on with
`daemon.restartSweepIntervalMs` unset also arms the restart sweep at 30s, so
the scheduled move actually runs.

## turnRetry

Graceful retry of a turn that failed for a TRANSIENT provider reason. ON by
default for executor agents and for sessions that run in a `sandbox` box: a
spawn that names no `turnRetry` gets the default policy (retry on
`rate-limit`, `upstream-5xx` and `no-output-stall`, `maxRetries: 6`, default
backoff). A free OpenCode current model also rotates by default: `rotateOn`
covers all three classes, and `rotate` lists the other free ids only (the
"free stays free" rule), so a throttled free model moves onto another free
model instead of banging on the same one. A paid current model never rotates
by default. Interactive supervisor sessions keep the old opt-in behaviour:
without `turnRetry`, a turn that hits a 429 or a 5xx just stops, as before.

An explicit `turnRetry` wins over the default. Setting it to `null`, or to an
object whose `on` list is empty, disables retrying for the session. When set,
the daemon waits an exponential backoff and then sends the SAME
live session a short continuation prompt:

> Continue where you stopped; the previous turn failed with: <error>

Note the free-model default rotation above only applies when the spawn names
its model explicitly: the default rotation list is built in
`agent_start` handling before default-model resolution, so a spawn that
leaves `model` unset never sees the free-rotate default.

Shape: `{ on, action?, maxRetries?, maxMigrations?, baseDelayMs?, factor?, maxDelayMs?, retryAfterToolCalls? }`.
Only `on` is required; the rest default to `action: "retry"`,
`maxRetries: 3`, `maxMigrations: 2`, `baseDelayMs: 5000`, `factor: 2`,
`maxDelayMs: 60000`.

`on` lists the classes to retry. The error text comes from the turn's
in-band error (`lastTurnErrorMessage`), or from the stall watchdog:

- `rate-limit`: HTTP 429, "rate limit", "too many requests",
  "resource exhausted". A provider `retry-after` hint raises the delay (still
  capped by `maxDelayMs`).
- `upstream-5xx`: HTTP 5xx, "overloaded", "bad gateway", "service
  unavailable", "internal server error".
- `no-output-stall`: the stall watchdog flagged a turn that produced nothing
  since its prompt (`no output since prompt — provider retrying?`), for
  example opencode retrying a 429 internally and silently. That turn is still
  running, so the retry interrupts it before re-prompting. Needs the daemon's
  stall watchdog to be on (`turnStallAfterMs`).

Never retried, whatever `on` says:

- a turn the user (or anything else) interrupted;
- a killed, exited or errored session. That includes the `maxCostUsd` kill. A
  dead process is `restartPolicy`'s job;
- a session with a failed governance policy, such as a tripped `costBudget`;
- auth and billing errors (401/402/403, invalid key, insufficient quota) and
  provider usage caps ("usage limit exceeded");
- a turn that already made a tool call outside a small read-only allowlist
  (read, grep, glob, ls, find, search, webfetch, websearch, todo, think).
  The continuation could repeat a write or an exec. Set
  `retryAfterToolCalls: true` to retry those turns anyway.

`maxRetries` counts consecutive retries. The counter is exposed on the
descriptor as `turnRetryAttempts` (also `lastTurnRetryAt`, and
`nextTurnRetryAt` while a retry is pending) and resets on the next turn
that completes cleanly. A new prompt, a kill, or a stall that recovers on its
own during the backoff cancels the pending retry. Each transition is emitted
as a `session:turn-retry` event (`scheduled` / `sent` / `cancelled` /
`exhausted` / `skipped` / `migrated` / `migrate-failed`) and stamped as a
`[turn-retry]` notice in the session transcript. Pending retries are
in-memory: a daemon restart drops them.

`action` decides what a matching failure does:

- `"retry"` (the default) — the behaviour above: re-prompt the same live
  session after backoff;
- `"migrate"` — on a SANDBOX session, move it to a fresh box (new IP, same
  work branch, transcript carried over) and re-prompt "continue" there,
  capped by `maxMigrations` consecutive migrations.

The migration cap is counted on the descriptor's `turnMigrations`: it resets
on the same clean turn that resets `turnRetryAttempts`, and it is carried
onto the migrated session (together with `turnRetryAttempts` and the
`turnRetry` policy itself), so a box that keeps getting throttled migrates at
most `maxMigrations` times in total.

A non-sandbox session, a spent cap, or a migration that cannot run (no
orchestrator, no work branch, a refused spawn) all fall back to the normal
retry above, with a `[turn-retry] no migration: …` /
`[turn-retry] did not migrate …` notice; a failed migration leaves the old
session untouched. Once `maxRetries` is spent as well there is nothing left
to fall back to: the daemon reports `exhausted` and gives up. The transitions
land as `migrated` (with `migratedTo`) and `migrate-failed` (with
`skipReason`) events.

CLI: `agentproto sessions start --turn-retry all` (or a comma list of
classes, or a JSON object). User presets and harness presets
(`harness_preset_create`) accept the same `turnRetry` field.

### Rotating to another model

A 429 on a free-tier model is per model per IP, so retrying the SAME model
usually fails again. Add `rotate` to move the session onto the next model
instead:

```json
{ "on": ["rate-limit", "no-output-stall"],
  "rotate": [{ "model": "opencode/minimax-m2.5-free" }, { "model": "opencode/big-pickle" }],
  "rotateOn": ["rate-limit", "no-output-stall"], "cooldownMs": 600000 }
```

- `rotate`: ordered fallback targets `{ model, profileRef? }` (max 16).
- `rotateOn`: classes that rotate, default `rate-limit` + `no-output-stall`.
  Add `upstream-5xx` to rotate on those too. Other retried classes keep
  retrying the same model.
- `cooldownMs`: how long a rate-limited model is skipped when the error has no
  retry-after hint. Default 10 min.

When a retry fires for a rotating class, the daemon takes the first target
that is not cooling down and is eligible, switches the live session to it (the
same path as `agent_set_model`), and only then sends the continuation prompt.
For a `no-output-stall` it interrupts the stuck turn first, then switches, then
continues. The descriptor's `model` reflects the new model, the transcript gets
`[turn-retry] rotating model A → B (class)`, and the `session:turn-retry`
event has `phase: "rotated"` with `fromModel` / `toModel`.

Cooldowns are daemon-wide: a model that rate-limits one session is skipped by
rotation for every session until the cooldown expires. A retry-after hint wins
over `cooldownMs`. They are read-only via `daemon_health` (`modelCooldowns`)
and `GET /health`, and are in-memory (a daemon restart clears them). They are
learned from every session whose policy rotates, including executor sessions
that use the default policy.

A target is skipped, with the reason in the notice, when it:

- is the current model, or is cooling down;
- is not in the session profile's `models` allow-list, or fails the spawn
  eligibility checks (adapter capability, wallet/route);
- is a paid model while the session's model is OpenCode free (see below);
- names a `profileRef` different from the session's current profile. v1
  rotates within the current profile only; switching profile needs a
  restart-with-override, which mints a new session id.

If no target is eligible, the retry falls back to the SAME model after the
backoff, and the notice says `no rotation target available (…)`.

**Free stays free.** When the session's model is an OpenCode free id (ends in
`-free`, or `big-pickle`, with or without an `opencode/` prefix), `rotate` may
only list free ids. `agent_start` rejects a list with a paid id
(`turn_retry_rotate_invalid`), so does saving a user or harness preset, and
runtime rotation never selects a paid id for such a session.

## contextContinuity

Context-continuity policy for this session — controls warning,
opportunistic compaction, fresh-continuation, and hard-stop thresholds.
Resolved from global → per-adapter → explicit override.

Every step that discards conversation context writes a checkpoint (goal,
plan, decisions, changed files, tests, errors, risks, next step) first: a
`/compact` or `/compress` prompt, the runtime's own auto-compaction, and the
context hard stop. If the checkpoint can't be written, compaction is refused
(the hard stop still happens, with a loud warning).

`hardStopAtPct` is a trigger, not a wall. At the floor the runtime
auto-compacts the session (checkpoint, then `/compact`, or `/compress` on
hermes) while incoming prompts wait with a retryable "mid-turn" error. If
compaction does not bring the window below the floor it continues the session
fresh, and only when neither works does it stop the session. Autonomous turns
evaluate the policy at turn end. Each outcome (`compacted` / `continued` /
`hard-stopped`) is announced in the transcript and as a
`session:context-rescue` event.

`compactRequiresOperator: true` reserves compaction to the operator: a
compaction prompt attributed to a session (`agent_prompt`, `session_compact`,
or the session itself) is refused; only an operator-originated prompt (HTTP,
CLI, UI) can compact. Default off.

`compactHandoffTurn: true` has a `/compact` or `/compress` prompt ask the
live session for a handoff turn (its own goal, decisions, risks) before the
checkpoint is built, then the harness's native compaction runs on the same
session. Default off: the checkpoint is extracted from the transcript alone,
with no billed model turn before compaction. The context-rescue path never
asks, and explicit handoffs (`session_checkpoint`, `session_continue_fresh`)
are unaffected.

## role

Spawn-time role gating whether this child may itself delegate (spawn/drive
further children) and, if it can, which roles IT may in turn spawn.
Built-ins: 'executor' = leaf, cannot delegate — `orchestrator` is ignored
and `agent_start`/`agent_prompt` are stripped from its default toolset,
regardless of `promptAppend`. 'supervisor' = may delegate (today's default
behaviour). Custom roles installed as role packs (see `role_list`) resolve
the same way. A spawn made THROUGH an orchestrator is additionally gated by
the privilege lattice: the calling role may only spawn a role allowlisted
in its `spawnableRoles`, or — open mode, the default — at or below its own
`level` (never something MORE privileged than itself). Omit `role` to
derive from spawn depth (root spawns default to supervisor; spawns made
through an orchestrator default to executor — see
`defaultRoleDepthCutoff` in config.json's `defaults` block).

## allowPromptFrom

Session ids allowed to drive the new session through the daemon's drive
tools (`agent_prompt`, `agent_interrupt`, `agent_kill`, `session_restart`,
`session_continue_fresh`), or `["any"]` to allow any caller session; entries
of the form `label:<exact label>` or `label:<prefix>*` grant a ROOT caller
session (no parent) whose operator-assigned, immutable label matches — the label
stamped when the human operator spawned it with `agent_start`; renaming a
session later does not change it. By
default the session may only be driven by its OWNER — the caller that
spawned it — one of its ancestors in the spawn tree (a grandparent or
orchestrator root keeps its existing subtree authority), and the human
operator (a client with no caller session); any other agent session is
refused by the daemon regardless of what tools its client lists. Change the
list later with `agent_set_prompt_policy` (session ids or `label:` entries
in/out, or an empty
array to reset): only the session itself, its owner, and the operator may.
`any` never widens what a caller's own role allows the daemon to do.

Same trust note as the rest of the daemon: the gate is keyed on the
`?callerSessionId=` identity the session's own mount carries — the same
daemon-trusted caller identity every other MCP tool already keys on, not an
independent proof of the calling process.

## promptAppend

One-off runtime text layered ON TOP of the resolved role's disposition and
prepended to `prompt` — it specializes the disposition, it cannot replace
it, and it cannot re-open the tool gate (an executor asked to 'delegate
anyway' via this field still has no delegation tools).

## deferredTools

Override deferred/lazy MCP tool loading for this spawn's daemon self-mount:
`true` hides every tool outside a small always-on set from `tools/list`
(still fully callable — use `tool_search` to look up a hidden tool's schema
by keyword before calling it), `false` keeps the full eager surface. Only the
loading strategy changes; no tool is removed.

Resolution order (first with an opinion wins): this field > the mount's own
`?deferred=1|0` (caller-supplied `mcpServers` entries) > a harness that
defers MCP tools natively (manifest `capabilities.nativeToolSearch`, today
claude-code ⇒ eager, so the daemon doesn't stack a second deferral layer on
top of the harness's own `ToolSearch`) > the resolved role's default
('executor' defaults ON, 'supervisor' has no opinion) > the daemon's
boot-time `defaults.mcp.deferredTools` config.

## browser

`"headless"` gives the spawned agent its own isolated headless Chrome
(1440x900, temporary profile) as a per-session `browser` MCP server
(chrome-devtools-mcp: navigate_page, take_screenshot, evaluate_script,
click, list_console_messages, …), torn down with the session (`true` =
`"headless"`). Works for any adapter that mounts stdio MCP servers; runs
inside the session's `commandSandbox` (`strict` ⇒ file:// only). `false` =
none. Omit to use the role / preset / `defaults.spawn.browser` default
(off). Not supported with `sandbox`.

## trace

Emit Langfuse observability traces for this session (prompt/completion +
tool spans + tokens/cost). Off by default; requires langfuse eval-reporter
creds configured.

## sandbox

Run this session inside a sandbox instead of on the host — pass a provider
slug (see `list_sandbox_providers`) or an inline AIP-36 SandboxDefinition
object. The daemon boots the sandbox, spawns `adapter` on the box's OWN
torn down. Omit to run locally (default). Pass an inline spec with `reuse:
"<sandboxId>"` (from a prior session's `sandboxId`) to reconnect to an
existing box instead — by default such a box is PAUSED (not killed) on
session close so it stays reusable; set `lifecycle.destroy_on` to always
kill it.

When a spawn ATTACHES to a box another session may already be using
(`reuse`, non-device, with a workspace), the per-workspace clone at
`<home>/<workspaceSlug>` stays the first session's checkout and the
attaching session gets its OWN git worktree of that clone at
`<home>/.worktrees/<workspaceSlug>/<branchSlug>` (same branch precedence as
a fresh-box checkout: an existing worktree of the branch → the pushed
`origin/<branch>` → cut from the resolved base). Concurrent workspace setup
on the shared clone is flock-serialized. On detach (box still shared), the
session's final delivery (checkpoint + push) runs first, then its worktree
is removed through the box (only when the push landed and the tree is
clean — any uncommitted/unpushed work keeps the worktree and says so). A
session alone on a fresh box is not affected: it lives directly in
`<home>/<workspaceSlug>` as before, and the box teardown takes that
checkout with it.

DO NOT CONFUSE with `commandSandbox` below — this field boots a WHOLE
SEPARATE machine/box; `commandSandbox` confines THIS host's own spawn argv
in place. The two are independent and combine (or not) freely;
`commandSandbox` is ignored for a `sandbox` spawn (the box's own daemon
would need to apply it).

## cloud

Spawn a MANAGED CLOUD agent (AIP-66) instead of a local one: pass a vendor
slug (`"anthropic"`) and the VENDOR owns the machine and the harness — the
host spawns nothing locally and relays through the vendor's cloud adapter
(`cloud: "anthropic"` resolves `adapter` to `claude-code-cloud`, harness
`claude-code`), so `adapter`/`harness` may be omitted. An explicit one must
name one of the vendor's harnesses or its relay adapter, else the spawn is
refused with `cloud_spawn_refused` naming the allowed ones; an unknown
vendor slug is refused too — never mapped to a default.

DISTINCT from `sandbox` (a host-booted box); mutually exclusive with it
and with every field the vendor can never apply (`worktree`,
`commandSandbox`, `mcpServers`, `daemonMount`, `bundles`, `browser`,
`appServe`, `inference`) — each is refused BY NAME (`cloud_spawn_refused`,
`details.field`), never silently dropped, and always before any side
effect.

The vendor session id is learned after the first prompt and persisted on
the descriptor as `meta.cloud = { vendor, sessionId, url }`; a later
restart or `resumeSessionId` re-attach resumes the VENDOR's own session
(AIP-66 §5) rather than starting a new one. No credential is ever carried
through `cloud`, `meta.cloud` or the relay's side file (AIP-66 §8).

## appServe

Serve an agentproto app's UI from INSIDE the sandbox box and return its
public URL. Requires `sandbox` (rejected otherwise). The box daemon
installs the app (`app_install` on the in-box `dir`), launches `agentproto
app serve --host 0.0.0.0 --port <port>` detached through the box's
`command_execute`, and the spawn result + descriptor carry `appServe: {
appId, dir, port, url, ready }` — `url` is the provider-resolved public URL
for the served UI (the port is also added to the spec's `extraPorts` and
echoed in `sandboxPorts`).

## commandSandbox

OS-level process confinement (macOS Seatbelt / Linux bubblewrap) for the
adapter's OWN spawned process on THIS host — NOT the `sandbox` field above,
which boots an entirely separate remote box. This wraps the exact argv
`adapter` spawns as (e.g. `claude`, `npx @agentclientprotocol/claude-agent-acp`)
so its process tree is denied filesystem access outside the session's `cwd`
— confinement an ACP permission seam can never provide, since it only sees
tool calls the adapter chooses to report, not what an in-process Bash
actually touches. `"off"` (default when omitted AND no
`.agentproto/command-sandbox.json` sets an `adapterSpawn.mode`) =
unconfined, unchanged behaviour. `"workspace"` = deny reads/writes to
$HOME outside the workspace (protects ~/.ssh, ~/.aws, credentials, …);
network stays allowed. `"strict"` = `"workspace"` + deny all network. A
workspace can set this same axis persistently via the `adapterSpawn` key of
`.agentproto/command-sandbox.json` (a DISTINCT key from the top-level
`mode` that key file also carries for `command_execute` — the two are never
shared; misconfiguring the whole-session adapter jail is a bigger blast
radius than misconfiguring one shell command) — this param, when set,
overrides that file. Ignored for a `sandbox` spawn. `"workspace"`/`"strict"`
with no backend installed for this platform (macOS needs `sandbox-exec`,
Linux needs `bwrap`) FAILS the spawn rather than silently running
unconfined.

## worktree

Isolate this session in its OWN git worktree instead of spawning directly
in `cwd` — so a parallel agent can't collide on the working tree. `true`
provisions a worktree on a fresh branch `wt/<slug>` cut from origin/main
(slug auto-minted from `label`); pass `{ slug, base, async }` to pin either,
or opt into an early return (see `async` below). The daemon boots the
worktree (git worktree add + the repo's agentproto.json setup hooks) and
spawns `adapter` THERE; the session's cwd, and every path it edits, live
inside the worktree. Honoured only for a ROOT spawn (a spawn made THROUGH
an orchestrator inherits its parent's tree — no second worktree; an
EXPLICIT `worktree` on such a nested spawn is REJECTED, not silently
ignored — use `sandbox` to isolate a child) and only when `cwd` is inside a
git repo (nothing to isolate otherwise ⇒ spawns plain, no error). The
daemon's `worktrees.isolation` policy may force this ON for every root
spawn (`always`) or OFF (`never`, which REJECTS an explicit `worktree`).
Ignored for a `sandbox` spawn (the box already isolates). The worktree is
NOT auto-removed on session close — it holds the agent's work; tear it down
with `agentproto worktree rm|archive|gc`.

`slug` pins the worktree's slug (names its branch `wt/<slug>` and its
directory) — omit to auto-mint a collision-free one from the label. `base`
is the git ref the branch is cut from (default 'origin/main'). `async`
returns a real, registered session as soon as it's minted (status
"starting") instead of blocking `agent_start`'s response on `git worktree
add` + the repo's setup hooks, which can run minutes — provisioning + the
driver spawn continue in the background; poll the session's `status`
(flips to "running" on success, "error" with a readable `lastError` on
failure — it never sits in "starting" forever). Any `prompt` is held and
dispatched only once the tree and the driver session both exist.
Incompatible with `wait` (there is no first-turn output to block on yet) —
combining the two is rejected. Defaults to true for any spawn that
provisions a worktree, UNLESS this call also sets `wait` (which falls back
to the old synchronous path instead of conflicting). Pass `false`
explicitly to force the old blocking ok/fail contract even without `wait`.

## sandboxCheckpoint

Per-spawn override of the sandbox checkpoint safety net — only meaningful
for a `sandbox` spawn that also has a workspace-remote delivery target
(`workspaceSlug` + `worktree`, so there's a branch to checkpoint). The
daemon force-pushes a snapshot of uncommitted work to a side ref
(`agentproto-checkpoint/<branch>` by default) at every turn end and once
more at teardown, so work is never lost to a box that dies abruptly — see
`defaults.sandbox.checkpoint` in config.json for the daemon-wide default
this overrides.

`false` disables checkpointing entirely for this spawn (teardown still
delivers the branch itself — pushes committed commits — it just stops
rescuing uncommitted work). An object overrides individual knobs over the
global default: `enabled` (master switch), `on` (`["turn-end", "teardown",
"interval"]` — which triggers take a checkpoint; `"turn-end"` controls the
per-turn hook, `"interval"` the periodic timer so a turn longer than the
box lifetime is still checkpointed mid-flight, `"teardown"` controls
whether the teardown delivery snapshots uncommitted work or only counts
it), `refPrefix` (remote branch namespace the snapshot lands under —
changing this only affects a FUTURE checkpoint), `minIntervalMs` /
`intervalMs` (periodic checkpoint spacing — `intervalMs` wins when both
are set; `0` disables the timer AND the turn-end hook even when
`on` includes `"turn-end"`, the legacy off-switch), `timeoutMs` (per-checkpoint wall-clock budget).
