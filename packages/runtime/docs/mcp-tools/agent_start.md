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
set.

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

## posture

Canonical agent posture (plan, bypass, accept-edits, read-only) or native
harness mode.

## contextProfile

Context intake profile (for example full or lean).

## auth

Deterministic billing-auth mode + EXPLICIT credential for adapters that
declare it (today: claude-code). EXPLICIT credential selection, not
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
on `server/discover` / `tools/list`). Verify from inside the session (list
its tools) before relying on a mount.

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

## contextContinuity

Context-continuity policy for this session — controls warning,
opportunistic compaction, fresh-continuation, and hard-stop thresholds.
Resolved from global → per-adapter → explicit override.

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
agentproto daemon, and proxies the conversation back onto this session —
`agent_prompt`/`agent_output`/`agent_kill` behave exactly as they do for a
local spawn, and the transcript stays readable here even after the box is
torn down. Omit to run locally (default). Pass an inline spec with `reuse:
"<sandboxId>"` (from a prior session's `sandboxId`) to reconnect to an
existing box instead — by default such a box is PAUSED (not killed) on
session close so it stays reusable; set `lifecycle.destroy_on` to always
kill it.

DO NOT CONFUSE with `commandSandbox` below — this field boots a WHOLE
SEPARATE machine/box; `commandSandbox` confines THIS host's own spawn argv
in place. The two are independent and combine (or not) freely;
`commandSandbox` is ignored for a `sandbox` spawn (the box's own daemon
would need to apply it).

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
