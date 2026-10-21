# Permissions and identity: global, workspace and session scope

**Status:** Design, owner decisions recorded (§5). No code changes in this document.
**Scope:** Every permission, capability and flag the daemon (`@agentproto/runtime`) evaluates, across global, workspace and session scope, and the plan to put them behind one decision point.
**Code base:** `agentproto/ts` `main` @ `c9553f798` (includes #2161 caller-identity header and #2162 box relay, both merged 2026-10-21). Every `file:line` is from that commit unless marked `#2163` or `#2149` (open PRs).
**Specs:** `agentproto/agentproto` `specs/aip-*.mdx`.

Paths are relative to `packages/runtime/src/` unless they say otherwise.

---

## 0. What the specs already say (cite these before inventing anything)

The model this plan proposes is mostly already written down. The daemon has not caught up with it.

| AIP | What it already fixes | Where |
|---|---|---|
| **AIP-38 POLICY** | One vocabulary: grants of `(principal, action)`, `default: deny`. Composition: grants are unioned, and the **most restrictive** default and requirements win. Conditions are ANDed, and an unknown condition means deny. | `aip-38.mdx:84-111`, `:155-240`, `:317-348` |
| **AIP-39 ACTION** | Grants name *actions* (`storage:commit`), never tool names. | `aip-38.mdx:93-95` |
| **AIP-46 §Delegation** | The spawn gate must bind to the **authenticated calling-session identity, not the surface**. A URL param or header the caller supplies is "a request, not a gate". Every surface that reaches a delegation action must carry session identity. **Loopback is not an auth boundary, so hosts MUST authenticate the delegation surface per-session even on loopback.** No self-widening: "a child may be given less than its parent has, never more". There must be one predicate for enforcement and introspection. Delegation verbs are gated *as actions*. | `aip-46.mdx:424-500`, `:520-560`, `:1364-1420` |
| **AIP-46 §Session messages** | `from` must be host-derived. Allowed pairs: child→parent, parent→direct child, human/system→any. Siblings are OPTIONAL and off by default. **"Any other pair … MUST be refused."** `interrupt` should not be granted to session senders by default. The HTTP mirror is `POST /sessions/:id/messages`, where "the sender is the authenticated caller". | `aip-46.mdx:812-931` |
| **AIP-46 §Security / Open questions** | A `workspaceSlug` is caller input until the registry says otherwise. Partitioning is not isolation. **There is no workspace-scoped credential today.** That rule and the credential it keys off "should land together". | `aip-46.mdx:1425-1445`, `:1470-1480` |
| **AIP-34 WORKSPACE** | A workspace carries its own `policy` (AIP-38) and `sandbox` (AIP-36) blocks. "when [sandbox is] absent, command-execution tools MUST be unavailable". Walls are `shared/isolated(default)/sealed/hard`. A node may only *raise* its wall. Cross-workspace access is **two-sided consent** (`includes` on the consumer plus a matching `exports` on the provider), and the effective mode is the more restrictive side. `sealed` means "sessions scoped to this node carry a node-scoped token". | `aip-34.mdx:207`, `:221`, `:395-455` |
| **AIP-42 AGENT** | `tools[]`, `delegates_to[]` (a closed allowlist), `policy` (AIP-38), `boundaries[]` (prompt hints only). | `aip-42.mdx:209-220` |
| **AIP-36 SANDBOX** | Network is allow-list. A sandbox is the only real backstop for an adapter that has its own shell. | `aip-36.mdx:121`, `:362-380`; `aip-46.mdx:585-632` |
| **AIP-23 identity-ref** | Principal schemes: `operator://`, `user://`, `role://`, `*`… It has **no `session://` scheme** today. | `aip-23.mdx:1150-1160` |

Bottom line: **the target model is AIP-38 grants over AIP-39 actions, evaluated at one AIP-46 enforcement point keyed on a minted session identity, with AIP-34 workspace policy and two-sided doors as the workspace scope.** The rest of this plan maps the daemon onto that.

---

## 1. Current state: inventory

Legend for "Problem": **CT** = caller-trusted input, **DUP** = the same rule is implemented more than once, **BYP** = bypass, **INC** = inconsistent behaviour between surfaces, **FO** = fails open.

### 1.1 Global scope (daemon, `~/.agentproto`, env)

| Knob | Configured | Enforced | Default | Problems |
|---|---|---|---|---|
| Daemon bearer `daemon.authToken` / `AGENTPROTO_TOKEN`; `remote_enable` flips the mode to bearer | `config-schema.ts:569` (restart, not writable); tunnel token `tunnel.token` / env `AGENTPROTO_TOKEN` `config-schema.ts:757-760`; `remote-tools.ts:49` | `http-server.ts:1545` `authorize`, `:1625` `tunnelBearerAllowed` | mode `none` | **FO**: `authorize` returns true for any loopback request with no proxy headers (`:1501`, `:1547`). The bearer gates only the tunnel. Every child process the daemon spawns is a loopback caller. |
| Per-boot sessions token (`runtime.json`, mode 0600) | `index.ts:2170`, `http-server.ts:1136` | `http-server.ts:1747` `checkSessionsToken`, used for mutating `/sessions/*` at `:3063` | on | Mode 0600 stops browsers but not children: every child runs **as the same UID** and can read `<ws>/.agentproto/runtime.json`. Holding it makes the caller "human" on `POST /sessions/:id/messages` (§1.4). GET routes are ungated (`:1862`), so any loopback process can read any session's transcript and inbox (`:7705`). |
| Origin allowlist `daemon.allowedOrigins`, `daemon.strictOrigins`; widget embed token `?et=` | `config-schema.ts:521`, `:550` | `authorizeMcp` `:1696`, `checkSessionsToken` `:1747` | localhost defaults | Browser-CSRF defence only. It is not an identity, and that is fine as long as nothing treats it as one. |
| Tunnel-bearer exemptions (`/health`, `/inbound/:slug`, app shell, `link-auth`, **`/relay/parent-message`**) | hard-coded | `http-server.ts:1625-1660` (relay at `:1644`) | | Each exemption has its own credential type (HMAC, link token, relay token). There are four token systems and none of them shares a store or a revocation path (see 1.5). |
| `defaults.messaging.allowSiblings` | `config-schema.ts:1196` (hot, **writable**) | `message-tools.ts:142-143` only | false | **INC**: the HTTP route ignores it (`http-server.ts:7661` calls `isMessageAllowed(relation)` with no opts). **Self-widening**: `config_set` sits on every child's daemon mount (below). |
| `defaults.messaging.agentInterrupt` | `config-schema.ts:1206` (hot, writable) | `message-tools.ts` (`allowInterrupt`), relay `http-server.ts:3108+` | deny | HTTP senders with no caller id always get interrupt (`http-server.ts:7688`). Same self-widening as above. |
| `defaults.agentPromptInterrupt` | `config-schema.ts:1186` | agent-tools / message_parent | false | |
| `defaults.defaultRoleDepthCutoff`, `defaults.maxGrantableDelegation` | `config-schema.ts:915`, `:925` (hot, writable) | `role.ts` `resolveRole`, `role-registry.ts:55` | cutoff const / no cap | Hot-writable by any session via `config_set`. Depth only counts for scoped spawns (`session-spawn.ts:2548-2580`), so a bare `/mcp` spawn is depth 0 and resolves to **supervisor**. |
| `spawn.attach` | `config-schema.ts:996` | `session-spawn.ts:2563` `decideSpawnAttach` | | Lineage only. It records a parent but applies no caps (comment at `:2548`). |
| `features.deviceSpawnAllow` | `config-schema.ts:1569` | device bridge | false | Fine. This is the right pattern: an operator flag set through the CLI. |
| Orchestrator limits `DEFAULT_MAX_DEPTH=3`, `HARD_MAX_DEPTH=8`, `DEFAULT_MAX_CHILDREN=8` | `orchestrator-gateway.ts:123-125` | `session-spawn.ts:2588` (scoped only) | | **BYP**: "A direct `/mcp` spawn (no callerScope) is subject to NO caps" (`session-spawn.ts:2548-2551`). |
| `AGENTPROTO_TERMINAL_GATE` | `command-allowlist.ts:182-229` | `session-tools.ts:7454` | `allowlist` | The workspace file wins over env. That is OK as precedence, but it lets a workspace *widen* to `all`. |
| `AGENTPROTO_COMMAND_SANDBOX_MODE`, `AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE` | `command-tools.ts:62-70`, `@agentproto/command-sandbox` | `command-tools.ts:289-330` | `off` | The only real OS boundary in the daemon, and it is off by default (documented trade-off). |
| `AGENTPROTO_PARENT_RELAY_URL` | `parent-relay.ts:100` | `session-spawn.ts:6380` | unset | The relay is enabled by env alone, with no config key. |
| Auth profiles (`~/.agentproto/auth-profiles.json` plus keychain) | `@agentproto/auth`; `auth_profile_*` tools (`index.ts:3877`) | `session-spawn.ts:3738` | | **No narrowing**: any spawn may name any `access.profileRef` (`agent-start-schema.ts:282`), and a child can bill to a profile its parent never had. `auth_profile_create/delete` are on every child's mount. |
| `config_get` / `config_set` | `config-tools.ts:16`, `:644` (`writable` gate) | `index.ts:3883` | | The comment says "Root /mcp only", but root `/mcp` **is the self-mount every child gets** (`session-spawn.ts:1030-1050`, only `agent_start`/`agent_prompt` denied for executors, `role.ts:87`). So any session can widen any `hot`+`writable` policy key. |
| `remote_enable` / `tunnel_create` | `index.ts:3777`, `:4186` | none beyond `/mcp` auth | | Any child can publish the daemon to the internet. |
| Cron `cron_create` (command / agent / prompt-session / tool actions) | `orchestration-tools.ts:2716-2780` | `cron-scheduler.ts:827` (command), `:1046-1060` (agent via `dispatchTool`) | | **BYP**: an `agent` cron action is a deferred root `agent_start`, a delegation twin that is reachable by executors (the tool is not in `DELEGATION_TOOL_NAMES`). Command jobs use **basename-only** `loadAllowlist` (`command-allowlist.ts:129`), ignoring argv constraints, and stamp `workspaceSlug: "default"` (`cron-scheduler.ts:848,858`). |

### 1.2 Workspace scope

| Knob | Configured | Enforced | Default | Problems |
|---|---|---|---|---|
| Workspace registry `~/.agentproto/workspaces.json` (`slug`, `path`, `remote`, `ownerApp`) | `workspaces-config.ts:45-80` | `findWorkspace` `:371`, `findWorkspaceByPath` `:394` (realpath prefix) | | The entry carries **no policy at all**. AIP-34 puts `policy`, `sandbox` and `wall` here, and none of them is implemented. |
| Session `workspaceSlug` | `agent_start.workspaceSlug` (`agent-start-schema.ts:124`) | `session-spawn.ts:2360-2492` | `"default"` | **CT**: `let resolvedSlug = input.workspaceSlug` (`:2360`). When the caller passes *both* `cwd` and `workspaceSlug`, resolution is skipped (`if (!cwd || !resolvedSlug)`, `:2385`), so the slug is never checked against the cwd. Any unregistered cwd becomes `"default"` (`:2492`), and so do command sessions (`command-tools.ts` `workspaceSlug` default) and cron commands. That is fine as a storage bucket, but **#2163 turns it into an ACL principal**. |
| `workspaceId` | nowhere on `SessionDescriptor` | n/a | | Dead. #2163 commit `b17e97c14` added it to `MessageTreeNode`, the review auto-fix removed it, and the PR body still documents it. |
| `.agentproto/allowed-commands.json` (basename or `{command,args}` prefix; `terminalGate`) | `command-allowlist.ts:36` | `command_execute` `command-tools.ts:259+` (argv-aware `isCommandAllowed` `command-allowlist.ts:146`); cron `cron-scheduler.ts:827`, policy shell gates `supervisor.ts:272`, supervisor commit `supervisor.ts:829`, task-ledger (**basename only**) | missing = deny | **DUP/BYP**: two evaluators. `{command:"git",args:["status"]}` blocks `git push` through `command_execute` but not through a cron job or a policy gate. **Wrong scope**: the file is read from the **daemon boot workspace** (`index.ts:2163`, `:3729`; anchor `command-tools.ts:209`), not the calling session's workspace. A session in repo B is governed by repo A's file and anchored to repo A's root. |
| `.agentproto/command-sandbox.json` | `@agentproto/command-sandbox` | `command-tools.ts:289-330` | off | Same boot-workspace scoping issue. |
| `agentproto.json` (`worktree.setup`, `scripts`, `models`) | repo root, `packages/worktree/src/config.ts:109` (read from the committed tree of `origin/main`) | worktree tools, `model-roles-tools.ts:72` | | **No permission block.** It is the natural carrier for a committed workspace policy (it is read from the *committed* tree, which is good because a session cannot edit its own policy and have it apply). |
| AIP-42 `AGENT.md` `tools:` | `.agents/<id>/AGENT.md` (`packages/agent/src/load-agent.ts`) | `?allowTools=` on the self-mount (`http-server.ts` docs at `~:985`, `session-spawn.ts:1043`) | | **CT**: enforced only as a URL param the child could drop. `delegates_to` and `policy` from AIP-42 are **not implemented**. The role lattice (`role.ts`, `canSpawn`) stands in for them, and AIP-46 explicitly flags that lattice as non-standard (`aip-46.mdx` Open Questions, "Privilege levels vs. explicit allowlists"). |
| App boundary (AIP-53 app zones) | app manifest | `session-spawn.ts:2330-2356` (inherit-only, "can never widen"), `command-tools.ts:289` | | **The one place that already does narrowing correctly.** Use it as the model. |

### 1.3 Session scope (`agent_start` input and descriptor)

All fields are from `agent-start-schema.ts`. "Bounded by parent?" means whether a nested spawn can exceed the parent's value.

| Field | Line | Enforced | Bounded by parent? | Problems |
|---|---|---|---|---|
| `posture` (plan / accept-edits / read-only / bypass / native) | `:292` | `canonical-posture.ts` (native mode, or **advisory preamble** fallback); `session-spawn.ts:4553`, `:4976` | **no** | A child can request `bypass`. Some adapters already default to `bypassPermissions` (`adapters/claude-sdk/src/options.ts:316`, `packages/cli/src/registry/builtins.ts:46`). |
| `role` (executor / supervisor / pack roles) | `:423` | `resolveRole` and `canSpawn` (`session-spawn.ts:2890-2935`), but **only when `callerScope`** | only through the scoped gateway | **BYP**: the executor's "no delegation" is `?denyTools=agent_start,agent_prompt` on its self-mount URL (`session-spawn.ts:1042`). That is a request: the child connects to `/mcp` without the param (loopback bypass) and spawns a depth-0 supervisor root. |
| `orchestrator` (`tools`, `maxDepth`, `maxChildren`) | `:320` | `narrowSandboxOrchestratorForward` `session-spawn.ts:1985-2023` (intersection plus min-clamp), `buildOrchestratorMcp` | **yes** (scoped) | Correct, and the second model to copy. |
| `mcpServers` (stdio / http / sse) | `:315` | mounted verbatim | **no** | **BYP**: a `stdio` mount is an arbitrary `ref` binary plus `args` plus `env`, so it is command execution outside `allowed-commands.json`. |
| `access.profileRef(s)`, `auth.{mode,token,apiKey}` | `:282`, `:300` | `session-spawn.ts:3738` | **no** | A child can use or bill any keychain profile. |
| `keepAlive`, `restartPolicy`, `notifyParentOnCrash` | `:220`, `:389`, `:205` | registry | n/a | Lifecycle, not permission. Out of scope apart from being settable by anyone who can drive the session. |
| `allowPromptFrom` (`["any"]`, `label:`) | `:429`; `agent_set_prompt_policy` `agent-tools.ts:1344` | `session-owner.ts` `checkSessionOwnerGate` (`agent-tools.ts:372-394`) | n/a | A second "who may put text in my context" ACL, separate from messaging. **FO**: `undefined` caller = operator, so it always passes (`session-owner.ts:10`, `:32-38`, `:56`). |
| `parentSessionId` hint, `attach` | `:158`, `:176` | `decideSpawnAttach` (`session-spawn.ts:2563`) | ignored when scoped | **CT** on the root path: lineage only, no caps. It does make the claimant the child's owner for drive and messaging. |
| `remoteParent` `{sessionId,url,token}` | `:336` | `agent-tools.ts:893` (box-side `message_parent`) | n/a | **CT**: a public field described as "never set by hand". Any host caller can point its child's reports at an arbitrary URL with a token it chose (the #2162 PR body admits this). |
| `deviceBridge`, `resumeSessionId` | `:537`, `:550` | `session-spawn.ts:2310-2347`, box re-attach | n/a | **CT**: "Internal … Do not set" fields on the public schema. |
| `sandbox`, `cloud`, `commandSandbox`, `worktree`, `appServe` | `:468-506` | spawn paths | `commandSandbox` partly (app boundary) | The request can opt *out* of `commandSandbox` unless an app boundary forces it. |
| `workspaceSlug`, `cwd` | `:124`, `:130` | see 1.2; `cwd_outside_parent` per AIP-46 | cwd: scoped only | See 1.2. |
| Caller identity `?callerSessionId=` / header `x-agentproto-caller-session-id` (#2161) | `session-spawn.ts:1050+` | `http-server.ts:2052` `resolveCallerSessionId`, `:2098` `externalClaimTrusted` | | **CT**: a claim, trusted on loopback (`:2098-2106`). The **query wins with no trust check** (`:2053-2055`; only the header path calls `externalClaimTrusted`). Any child can claim any id, including its parent's, and **omitting it makes you the operator**. The only unforgeable identity in the daemon is the orchestrator scope token (`orchestrator-gateway.ts:127-165`, map `:289`, persisted `:513-549`). |
| `denyTools` / `allowTools` / `deferred` / `surface` / `origin` query params | `http-server.ts:940-1000`, `:2117` | `mcpServerFactory` (`index.ts`) | | **CT** by construction. AIP-46 calls these "a request, not a gate". `surface=approval-cards` is refused when a callerSessionId is present (`http-server.ts` `handleMcp`), but a child that omits callerSessionId *can* open that surface and self-approve. |

### 1.4 Messaging ACL, every path that delivers a `SessionMessage`

| Path | Sender identity | ACL | Interrupt | Problems |
|---|---|---|---|---|
| `message_send` / `message_reply` (`message-tools.ts:142`) | scope token or callerSessionId claim | `resolveRelation` + `isMessageAllowed(rel,{allowSiblings})` (`session-message.ts:75`, `:94`) | `agentInterrupt` | Correct shape, but the identity is a claim. |
| `message_parent` (`agent-tools.ts:831`) | same | implicit: own `parentSessionId`, else `remoteParent` relay (`:893`) | `agentPromptInterrupt` / `agentInterrupt` | **DUP**: its own path. |
| `POST /sessions/:id/messages` (`http-server.ts:7624-7700`) | `?callerSessionId=` **query only** (no header, no trust check), else **human** | `isMessageAllowed(relation)`, **no `allowSiblings`** (`:7661`) | human: always (`:7688`) | **INC + FO**: siblings are refused here even when the config allows them. Any holder of the runtime.json token (every child) who omits the query is `human`, reaches every session, and may interrupt. |
| `POST /relay/parent-message` (#2162, `http-server.ts:3108`, `parent-relay.ts:343`) | relay grant (in-memory `Map`, `parent-relay.ts:102`, 1 h sliding TTL `:89`) | hard-coded relation `"child"` (`parent-relay.ts:380`) | `agentInterrupt` | **DUP**: the third ACL. A fourth token store that is lost on restart. Correct by construction, but not routed through the shared decision. |
| `registry.sendMessage` (`sessions.ts:12145`) | n/a | **none** (it checks liveness only) | caller-passed `allowInterrupt` | The sink trusts every caller to have run *some* ACL. |
| Drive tools `agent_prompt`/`agent_interrupt`/… | same claim | owner gate plus `allowPromptFrom` (`session-owner.ts`) | | A second ACL for the same effect ("text lands in X's context"). |

### 1.5 Credential and token systems in the daemon today

1. Daemon bearer (tunnel), `http-server.ts:1625`.
2. Per-boot sessions token (`runtime.json`), `:1747`.
3. Orchestrator scope token (`/mcp/orchestrator?scope=`), persisted, `orchestrator-gateway.ts:289`, `:513`.
4. Parent relay token, in-memory only, `parent-relay.ts:102`.
5. Widget embed token `?et=`, app link tokens (`app-link-gate.ts`), `/inbound/:slug` HMAC.
6. Plus the *claim* `callerSessionId` (not a token at all).

Only #3 is a real per-session capability. It is used only for orchestrator-mode children, while every other child gets #6.

---

---

## 2. Problems, ranked

1. **A session's identity fails open (P0).** Without `callerSessionId` the caller is the operator (`session-owner.ts:32-38`, `http-server.ts:7688`), and `/mcp` accepts any loopback caller (`http-server.ts:1547`). A child session, even an executor, reaches the operator's full surface the moment its request does not say who it is: root `agent_start` with no caps, `config_set`, `remote_enable`, `auth_profile_*`, `cron_create`, and the approval-cards surface. AIP-46 requires the delegation surface to be authenticated per session even on loopback (`aip-46.mdx:1395-1405`). Every other ACL in this document sits on top of this hole. Per the owner decision (§5, D2) the fix targets the *session* side: every daemon-spawned session carries a daemon-minted identity, and a local caller with no session identity (Claude Desktop, Cowork, a bare `/mcp` client) stays operator-equivalent by default.
2. **Identity is a claim (P0).** A child can name *any* session id on loopback (`http-server.ts:2052-2106`) and send or drive as its parent or a sibling. The query path skips even the trust check that the header path runs.
3. **Policy can be widened by the governed (P0).** `config_set` (hot+writable `defaults.messaging.*`, `maxGrantableDelegation`, `spawn.attach`) is reachable from every child's mount. #2163 adds two more such keys (`allowSameWorkspace`, `peerGroups`).
4. **Executor "no delegation" is URL-only (P1).** `?denyTools=` (`session-spawn.ts:1042`) is a request, and cron `agent` actions, `workflow_start` and `app_run` are delegation twins outside `DELEGATION_TOOL_NAMES` (`role.ts:87`). AIP-46 wants actions gated, not tool-name strings.
5. **The messaging ACL is implemented 3-4 times, inconsistently (P1).** MCP tool, HTTP route (no siblings, anonymous=human), relay (hard-coded child), and `message_parent`. The sink (`sessions.ts:12145`) checks nothing.
6. **Workspace identity is caller-supplied and collapses to `"default"` (P1).** `session-spawn.ts:2360`, `:2385`, `:2492`. Fine as a storage bucket, fatal as a principal. #2163 makes it a principal, with default ON.
7. **The command allowlist has two evaluators and the wrong scope (P1).** argv constraints are bypassable through cron, policy gates and commit. The file comes from the daemon boot workspace, not the session's (`index.ts:2163`). Command execution also happens outside it through stdio `mcpServers`, `pr_open` (#2149), `terminal_start` with `terminalGate: all`, and the adapters' own shells.
8. **Nothing narrows at spawn except orchestrator scope and app boundary (P2).** `posture`, `access.profileRef`, `mcpServers`, `commandSandbox` opt-out, and `allowPromptFrom: ["any"]` are all unbounded by the parent, against AIP-46 "no self-widening".
9. **Internal fields on the public schema (P2).** `remoteParent`, `deviceBridge`, `resumeSessionId` (`agent-start-schema.ts:336`, `:537`, `:550`).
10. **Token sprawl (P2).** Five-plus credential types with separate stores, TTLs and revocation, and the relay grants die with the daemon (`parent-relay.ts:102`).
11. **No introspection predicate (P3).** No `permissions_explain`: nobody can ask "may S do A on T, and why", which AIP-46 requires to be the *same* predicate as enforcement (`aip-46.mdx:487-491`).
12. **Unread transcripts are world-readable to loopback (P3).** GET `/sessions/*` routes are ungated (`http-server.ts:1862`). This is acknowledged as an open question in AIP-46, but it should be on the list.

**Residual, accepted for now (D1).** Every session runs as the daemon's UID. A child with a native shell can read `runtime.json`, `~/.agentproto/*` and the keychain-backed files, run `agentproto` itself, or simply open `/mcp` without the identity its mount carries and be treated as an anonymous local caller (operator-equivalent by default, D2). The threat model this plan defends against is a **confused** child: accidental or casual bypass, which is the realistic defeat AIP-46 names (`aip-46.mdx:1405-1412`). A child that uses the mounts it was given is always evaluated as itself and narrowed. A **hostile** child that deliberately strips its identity or steals the operator credential is out of scope until the optional OS sandbox step (§4 step 12), and an operator who wants anonymous callers narrowed earlier sets `policy.anonymousLoopback` (§3.3).

---

## 3. Proposed model

### 3.1 Principles

1. **One vocabulary**: AIP-39-style action names. Tools map to actions in a generated table (alongside `daemon-tool-names.generated.ts`), and enforcement looks up the action, never the tool name.
2. **One decision point**: `decide(principal, action, target, ctx) -> {allow, reason, provenance[]}` in a new `permissions.ts`. Every enforcement site and the introspection tool call it. Sinks (`registry.sendMessage`, `spawnAgentSession`, `runCommand`) take a branded `Decision` argument, so a new caller cannot skip the check without a type error. Naming note: the runtime already exports an unrelated AIP-65 `decide(policy, evidence)` (`decision.ts:616`, re-exported from `index.ts:73`). The permission predicate stays module-local as `decide` inside `permissions.ts` and is exported from the package as `decidePermission`, so the two never collide.
3. **Identity is minted, never claimed.** The daemon resolves every request to exactly one principal:
   - `session:<id>`: presents a per-session token the daemon minted at spawn and placed on that session's mounts. It is always evaluated as that session, narrowed, never as operator.
   - `operator`: holds the operator credential (runtime.json token or bearer).
   - `controller:<daemonId>`: a paired or host daemon forwarding a box or device spawn.
   - `anonymous`: a local caller that presents no session identity at all. By default (D2) it is **operator-equivalent**, so Claude Desktop, Cowork and a bare `/mcp` client keep driving every session as they do today. `policy.anonymousLoopback` narrows it, opt-in.

   A request that names a session (a `callerSessionId` claim) without that session's token is never upgraded to the session and never downgraded to anonymous: it is refused (`identity_unverified`). A caller cannot claim another session's id.
4. **Narrowing only, down the tree.** The rule is `effective(child) = global ∩ workspace ∩ agent(AIP-42 policy) ∩ role ∩ effective(parent) ∩ request`. Only three actors can widen:
   - the **operator**, at global scope, through the CLI or an operator-credentialed call (never `config_set` from a session principal);
   - the **workspace owner**, through committed workspace policy, and only up to the global ceiling;
   - **both workspaces** for a cross-workspace door (AIP-34 two-sided consent).

   A session can *request* less and can never obtain more.
5. **Union of grants, most-restrictive default** (AIP-38 rule 2). If any applicable grant allows, the action is allowed, unless a `deny` from a narrower scope forbids it. This is what fixes the #2163 inversion: a pair that is *both* siblings and same-workspace peers is allowed if *either* grant applies.

### 3.2 Action vocabulary (v1)

```
session.spawn            agent_start, cron agent action, workflow_start, app_run (agent steps)
session.drive            agent_prompt, agent_interrupt, agent_kill, session_restart, session_continue_fresh
session.message          message_send, message_reply, message_parent, POST /sessions/:id/messages, relay
session.message.interrupt
session.read             agent_output, transcript/GET /sessions/:id/*, inbox of another session
command.exec             command_execute, cron command, policy shell gate, supervisor commit
terminal.open            terminal_start
mcp.mount.stdio          agent_start.mcpServers[transport=stdio]
pr.open                  pr_open (#2149), gh shim
auth.profile.use         agent_start.access / auth
auth.profile.manage      auth_profile_create/delete/import
config.write             config_set
remote.publish           remote_enable, tunnel_create
cron.schedule            cron_create/delete
approval.decide          approval_card_decide (operator only, never delegable)
box.relay                relay grant use (box → host)
```

`target` is a session id, a workspace slug, a command argv or a profile ref. `ctx` carries the relation (parent / child / sibling / peer / door), the workspace verification state and the depth.

### 3.3 Config shapes

**Global** (`~/.agentproto/config.json`). This is operator-only. `config_set` refuses every `policy.*` key unless the principal is `operator` (or `anonymous` while it is operator-equivalent).

```jsonc
{
  "policy": {
    // How a local caller with NO session identity is treated (D2).
    // Default "operator": Desktop / Cowork / bare /mcp clients are not blocked.
    // "restricted" (attribution + own inbox, no spawn/drive/config) and
    // "deny" are opt-in for operators who want them.
    "anonymousLoopback": "operator",        // "operator" | "restricted" | "deny"
    "roles": {
      "supervisor": { "allow": ["session.*", "command.exec", "terminal.open", "pr.open"] },
      "executor":   { "allow": ["session.message", "command.exec", "pr.open"],
                      "deny":  ["session.spawn", "session.drive", "cron.schedule"] }
    },
    "sessionCeiling": {                     // what ANY session principal can ever hold
      "deny": ["config.write", "remote.publish", "auth.profile.manage", "approval.decide"],
      "postures": ["plan", "read-only", "accept-edits", "default"],   // "bypass" only if listed
      "maxDepth": 3, "maxChildren": 8
    },
    "messaging": {
      "siblings": "deny",                   // AIP-46 default
      "peers": "deny",                      // same verified workspace, no tree edge; default deny per AIP-46
      "agentInterrupt": "deny",
      "links": [["agentik-studio", "app-agentik-pygmalion"]]  // operator-declared cross-workspace doors (v1 of AIP-34 doors)
    }
  }
}
```

**Workspace** (committed, read from the committed tree the way `agentproto.json` already is). Shape: the `policy` block of `agentproto.json`, mirroring AIP-34 `policy` (`aip-34.mdx:221`). It can only narrow the global value, with one exception: `messaging.peers` and `exports` may be *opened* within the global ceiling, because that is the workspace owner's call (see Open question 1 for whether that stays workspace-owned).

```jsonc
// <repo>/agentproto.json
{
  "policy": {
    "messaging": {
      "peers": "allow",                      // sessions verified in THIS workspace may message each other
      "exports": [{ "to": "app-agentik-pygmalion", "actions": ["session.message"] }]   // AIP-34 door, provider side
    },
    "commands": { "file": ".agentproto/allowed-commands.json" },   // existing file, now resolved per SESSION workspace
    "deny": ["remote.publish"],
    "postures": ["plan", "accept-edits", "default"]
  }
}
```

**Session** (`agent_start`): a new optional `capabilities: { deny?: string[], allow?: string[] }`. `allow` is intersected (it narrows to that set), `deny` subtracts. The resolved value is stored on the descriptor as `effectiveCapabilities` with `provenance` (which scope removed what). `remoteParent`, `deviceBridge` and `resumeSessionId` leave the public schema and travel only on a `controller:` principal's internal envelope.

### 3.4 Identity

- **Per-session token on every daemon-spawned mount.** Minted at spawn next to the self-mount (`buildDaemonSelfMountEntry`, `session-spawn.ts:1030`) and injected as a header on every daemon mount the session gets (self-mount, orchestrator mount, box/device forwards), the same place #2161 already puts `x-agentproto-caller-session-id`. Stored hashed in the same persisted store as orchestrator scopes (`orchestrator-gateway.ts:513-549`), generalised into `session-credentials.ts`. Sent as `Authorization: AgentprotoSession <tok>` or `x-agentproto-session-token`. The orchestrator scope token *becomes* a session token with a narrower capability set. There is one store and one revoke-on-retire.
- `resolvePrincipal(req)` replaces `resolveCallerSessionId` (`http-server.ts:2052`). Rules:
  - A valid session token wins: the request is `session:<id>`, evaluated with that session's effective capabilities. Holding the runtime.json token as well does not make it operator.
  - A `callerSessionId` claim (query or header) **with** a token must match it, else 403 `identity_mismatch`.
  - A claim **without** a token is refused with 403 `identity_unverified` once enforcement is on (§4 step 6). It is neither treated as that session nor dropped to `anonymous`, so naming a session id never gains anything.
  - No token and no claim: `anonymous`, treated per `policy.anonymousLoopback` (default `operator`).
- **Operator**: holds the bearer or runtime token *and* has no session token. The CLI already reads runtime.json.
- **Workspace binding is daemon-derived**: `binding = findWorkspaceByPath(realpath(cwd))` (`workspaces-config.ts:394`). The rules:
  - A caller `workspaceSlug` only *selects* a workspace when no `cwd` is given.
  - If both are given and they disagree, the spawn fails with `workspace_mismatch`.
  - A nested spawn inherits the parent's binding (AIP-46 inheritance).
  - An unregistered cwd gets `workspaceBinding: null`. The storage bucket may stay `"default"` for back-compat, but **`null` is never equal to `null`** in an ACL.

  The descriptor gains `workspaceBinding: { slug, verified: true, via: "cwd" | "slug" | "parent" } | null`.

### 3.5 Messaging rules (one function, every path)

`decideMessage(sender, recipient, policy)` lives in `permissions.ts` and is called by `message-tools.ts`, `message_parent`, the HTTP route and `parent-relay.ts`. `registry.sendMessage` requires its `Decision`. The algorithm collects **all** relations that hold, then allows if any grant matches:

| Relation (all that hold are collected) | Grant | Default |
|---|---|---|
| `parent` ↔ direct `child` | always | allow |
| `sibling` (same parent) | `messaging.siblings` | deny |
| `peer`: both have a verified binding with the same slug | workspace `messaging.peers` (within the global ceiling) | deny |
| `door`: verified bindings in two workspaces linked by `policy.messaging.links` (v1) or a two-sided `exports`/`includes` (v2, AIP-34) | link or door | deny |
| `human` | principal = operator, or `anonymous` while `anonymousLoopback` is `operator` | allow |
| `system` | daemon-internal only | allow |
| box child → host parent | relay grant = a session token scoped to `session.message` on its parent only | allow |
| anything else, or `anonymous` under `restricted`/`deny` | | refuse |

Two more rules:

- `interrupt`: operator (and operator-equivalent anonymous) yes; session senders follow `messaging.agentInterrupt`, which a workspace may tighten but not loosen.
- The envelope `relation` field reports the *strongest* relation (`parent > child > sibling > peer > door`), so the recipient's view does not change for tree pairs.

### 3.6 Command and tool rules

- **One evaluator.** `isCommandAllowed(entries, basename, argv)` (`command-allowlist.ts:146`) becomes the only check. `loadAllowlist` (basename-only, `:129`) is deleted, and cron, policy gates, supervisor commit and the task ledger call `decide(principal, "command.exec", argv)`.
- **Scope.** The allowlist and command sandbox come from the **calling session's workspace binding**, with the anchor at that workspace root, intersected with the global allowlist if one is configured. A `null` binding means the global allowlist only. That is the AIP-34 rule: no workspace sandbox means no command exec.
- **Commands the daemon runs on someone's behalf** (`pr_open`, gh-provenance shim, `git` commit) are actions of their own (`pr.open`, `command.exec` with `{argv}`). They require a relation: the target session is the caller, a descendant of the caller, or the caller is the operator. They run in the **target session's** workspace, not `opts.workspace`.
- **stdio `mcpServers`** require `mcp.mount.stdio`, and the `ref` is evaluated against the allowlist.
- **`terminalGate: all`** in a workspace file is honoured only if the global ceiling permits `terminal.open` unrestricted.

### 3.7 Box, device and remote rules

- **Host → box.** The host forwards `controller:<hostDaemonId>`-signed spawn envelopes. The box daemon accepts `remoteParent`, `role`, `orchestrator` and capabilities only from a controller principal, and clamps them with the same intersection as `narrowSandboxOrchestratorForward` (`session-spawn.ts:1985`).
- **Box → host relay.** The relay grant is a session token (store from 3.4) with capability `{session.message → parentSessionId}`. It is persisted hashed, so it survives a restart, and revoked on box retire (already `revokeParentRelayGrantsForBoxSession`, `parent-relay.ts:227`). The tunnel exemption (`http-server.ts:1644`) stays POST-only and token-gated.
- **`remote_enable` / tunnels** are `remote.publish`, which is operator-only and in `sessionCeiling.deny`. When remote is enabled, a tunnel caller with the bearer is the `operator`. Bearer plus a session token makes the caller that session, which is how a remote child is identified. `anonymousLoopback` only ever applies to loopback: a non-loopback caller without the bearer is refused as today.
- **Device bridge**: unchanged (`features.deviceSpawnAllow`), but `deviceBridge: true` is only honoured from a controller principal.

### 3.8 Introspection

`permissions_explain({ action, target?, sessionId? })` returns the `Decision`, with provenance listing global, workspace, agent, role, parent and request. `session_capabilities` gains `effectiveCapabilities`. Both read the same `decide()`, which satisfies the single-predicate requirement in `aip-46.mdx:487`.

---

## 4. Migration plan (ordered, PR-sized)

Each step is independently mergeable from `main` (no stacking), and each keeps back-compat behind a knob. Order follows the owner decision (D3): `decide()` first, the unified messaging ACL second, and #2163 reworked on top of those. Step 0 runs in parallel because the spec amendments are prose PRs in another repo, and code that becomes AIP-normative should not land ahead of them.

**Step 0: spec amendments (agentproto/agentproto, prose PRs, in parallel).**
- AIP-46 §Session messages: add relations `peer` and `door`, keyed on a *verified workspace binding*, both default deny. Today's "any other pair MUST be refused" would make #2163 non-conforming.
- AIP-46 §Delegation: name the per-session credential and the `anonymous` principal. State the D2 split explicitly: host-spawned sessions MUST carry a host-minted identity on every delegation surface and are evaluated as themselves; a local caller presenting no session identity is the operator's own client and MAY be treated as the operator by host configuration. Close the "workspace-scoped credential" open question with "session token + workspaceBinding".
- AIP-23: add a `session://<id>` identity-ref scheme for AIP-38 principals.
- Cite AIP-34 doors as the v2 of `links`.

**Step 1: `permissions.ts` with `decide()` plus the action map. No behaviour change.**
- `decide()` encodes *today's* rules exactly (tree ACL, `allowSiblings`, owner gate, allowlist), plus the generated tool→action table.
- `permissions_explain` is read-only.
- Tests assert `decide()` agrees with every existing call site.
- Gain: one predicate exists. Back-compat: total.

**Step 2: unify the messaging ACL. Small, deliberate behaviour fixes.**
- `message-tools.ts`, `message_parent`, `http-server.ts:7624`, and `parent-relay.ts:343` call `decideMessage`. `registry.sendMessage` takes a `Decision`.
- Fixes: the HTTP route honours `allowSiblings` and reads the caller identity through the same resolver as `/mcp` (header too).
- This is the "one function" half of #2163, without the peer widening.

**Step 3: rework #2163 on top of steps 1-2.**
- Peers become a relation evaluated by `decideMessage`, with union semantics (sibling OR peer), so there is **no tree-first precedence** and the "sibling refused, stranger allowed" inversion is gone.
- Same-workspace messaging is **off by default**.
- **No session-writable peer keys**: the switch (and `links`, which replaces `peerGroups`) lives under operator-only `policy.messaging.*`, refused to session principals by `config_set` (enforced by `decide()`, `config.write`).
- A pair counts as peers only when both sides' slugs are verified against their cwd (`findWorkspaceByPath(realpath(cwd))`); `"default"` and unregistered cwds never match. Until step 4 lands the binding on the descriptor, this check is computed at decision time.
- Rebase on `main`: #2163 forks at `9309cd51c`, before #2161/#2162. Fix the stale PR body (`workspaceId`).

**Step 4: daemon-derived workspace binding on the descriptor.**
- Add `workspaceBinding` to the descriptor; step 3's decision-time check reads it instead.
- `workspace_mismatch` when `cwd` and `workspaceSlug` disagree (`session-spawn.ts:2385`). Ship it as a warning for one release, then make it an error.
- An unregistered cwd gets `binding: null`, while the bucket stays `"default"`.
- Back-compat: storage paths are unchanged.

**Step 5: per-session tokens on every daemon-spawned mount (shadow mode).**
- Mint at spawn, inject into every daemon mount's headers next to the #2161 caller-identity header, and generalise the scope-token store.
- `resolvePrincipal()` logs claim-vs-token disagreement and claim-only calls (metric: `identity.claim_only`) and counts anonymous calls separately (`identity.anonymous`), so the operator can see what `anonymousLoopback: restricted` would affect before opting in.
- No enforcement yet.

**Step 6: enforce session identity (no change for anonymous callers).**
- A request carrying a session token is evaluated as that session, narrowed: role capabilities, `sessionCeiling`, parent ∩ request. It never resolves to operator, even if the process also holds the runtime.json token.
- A claim without a token, or a claim that disagrees with the token, is a 403 (`identity_unverified` / `identity_mismatch`). A caller cannot speak as another session.
- `config_set` of `policy.*` / `defaults.messaging.*`, and `remote.publish`, `auth.profile.manage`, `approval.decide`, all refuse session principals.
- `anonymousLoopback` stays `"operator"` by default: Claude Desktop, Cowork and bare `/mcp` clients keep full access to every session. `"restricted"` and `"deny"` are opt-in config; an operator who opts in runs `agentproto install-mcp` to write the operator token into those clients' config.
- This closes problems 2 and 3, and problem 1 for every session that uses the mounts it was given (the D1 threat model). Deliberate identity stripping stays the accepted residual (§2) until the operator opts into `restricted` or step 12.

**Step 7: actions instead of tool names for delegation.**
- Role capability sets (3.3) replace the `?denyTools=` mechanism as the gate, keyed on the session principal from step 6. Keep the URL param as defence in depth.
- Cron `agent` actions, `workflow_start` and `app_run` require `session.spawn` *of the creating principal*, recorded on the job. A cron job fires as its creator's principal, clamped by the creator's capabilities (see Open question 3 for what happens after the creator retires).

**Step 8: command allowlist unification and per-session scope.**
- Delete basename-only `loadAllowlist`, and route cron, gates and commit through `decide`.
- Resolve the allowlist by session `workspaceBinding` (fallback: today's boot workspace, with a deprecation warning).
- stdio `mcpServers` require `mcp.mount.stdio`.

**Step 9: spawn narrowing.**
- `posture` is clamped to `parent ∩ workspace.postures ∩ sessionCeiling.postures` (`bypass` must be explicitly listed).
- `access.profileRef` must be in the parent's profile set (or the operator's).
- `allowPromptFrom: ["any"]` requires an operator or workspace grant.
- Internal-only fields (`remoteParent`, `deviceBridge`, `resumeSessionId`) are accepted only from a `controller:` principal.

**Step 10: relay and token consolidation.**
- Relay grants move into the session-credential store (persisted, hashed, revoked on retire).
- Fold the remaining token types behind one `credentials.ts` interface. The embed, link and HMAC tokens keep their semantics and get one registry for listing and revocation.

**Step 11: workspace policy file plus AIP-34 mapping.**
- Read `agentproto.json` `policy` from the committed tree. `agentproto workspace check` validates narrowing-only.
- The v2 `exports`/`includes` doors replace `links`.

**Step 12 (later, optional): OS sandbox backstop, `commandSandbox` profile `agent`.** Deny-read on `~/.agentproto/{runtime.json,auth-profiles.json,config.json}` and `<ws>/.agentproto/runtime.json` for adapter processes, so a child cannot steal the operator credential. This is the step that moves the threat model from a confused child to a hostile one (D1). It will break some current `gh`/`pnpm` flows (see the `command-sandbox.ts` notes), so it is opt-in per workspace and not on the critical path.

### 4.1 Disposition of the three PRs

| PR | State | Recommendation |
|---|---|---|
| **#2163** `feat/messaging-same-workspace` | open, head `59d9c02af`, based on `9309cd51c` (behind main) | **Rework on top of steps 1-2; do not merge as-is** (step 3). Keep the single `resolveMessageAcl` idea and the HTTP-route fix: they become step 2. Drop:<br>• `allowSameWorkspace` default **true**, which conflicts with AIP-46's "MUST be refused" and widens every workspace silently (off by default instead);<br>• the tree-first precedence, where a sibling is refused and a stranger allowed (`session-message.ts` #2163 `resolveMessageAcl`: sibling becomes peer only via `peerGroup`);<br>• `peerGroups` and `allowSameWorkspace` as hot, session-writable keys (operator-only `policy.messaging.*` instead);<br>• `sameWorkspace()` on the raw caller-supplied slug, where `"default"` makes every unregistered session a peer.<br>Also fix the stale PR body (`workspaceId`). |
| **#2162** box relay | **merged** (`e4ca9cc1a`) | Keep. Follow-ups:<br>• route delivery through `decideMessage` (step 2);<br>• move grants into the persisted credential store, since today they die on daemon restart (`parent-relay.ts:102`) (step 10);<br>• make `agent_start.remoteParent` controller-only (step 9).<br>The bearer exemption at `http-server.ts:1644` is correct as designed. |
| **#2149** `pr_open` | open, head `094006555` | **Park until step 8, or merge only with three fixes.** (a) Add a relation check: the caller is the target session, its ancestor, or the operator. Today any `/mcp` caller can open a PR, with caller-chosen title and body, for *any* session's branch. (b) Run `gh` in the **target session's** workspace checkout, not `opts.workspace` (the daemon boot dir, `#2149 command-tools.ts` `workspacePath: opts.workspace`), or a session from repo B opens against repo A. (c) Register it so `denyTools` / role capability can remove it. It is the `pr.open` action, deliberately *outside* the command allowlist but *inside* the capability model. |

---

## 5. Decisions and open questions

### Decided

- **D1. Threat model: a confused child, now.** The plan defends against accidental and casual bypass by a child session that uses the mounts and credentials it was given. It does not try to stop a hostile child that deliberately strips its identity or reads the operator credential with its own shell; that residual (§2) is accepted. The OS sandbox deny-read (step 12) stays a later, optional step.
- **D2. Anonymous local callers stay operator-equivalent by default.** Claude (Desktop, Cowork, a bare `/mcp` client) must not be blocked from interacting with any session by default, so a local caller with no session token keeps today's operator-equivalent access (`policy.anonymousLoopback: "operator"`). The fix targets child sessions instead: every daemon-spawned session gets a daemon-minted identity on its mounts (§3.4, step 5), and a request carrying a session identity is evaluated as that session, narrowed, never as operator (step 6). A caller cannot claim another session's id: a claim without the matching token is refused. Restricting anonymous callers further (`"restricted"` or `"deny"`) is opt-in config.
- **D3. Next steps.** Step 1 is `decide()` with no behaviour change; step 2 is the unified messaging ACL. #2163 is reworked on top of those (step 3): same-workspace messaging off by default, no tree-first precedence, no session-writable peer keys.

### Open

1. **Who defines peers, and is a global `links` list acceptable as v1?** The plan makes same-workspace peers workspace-owned (`agentproto.json` `policy.messaging.peers`, default deny) and cross-workspace doors operator-owned (`policy.messaging.links`) until AIP-34 `exports`/`includes` doors land. The alternative is operator-only for both. Pygmalion's cross-workspace consultations are the first consumer; if they are urgent, step 3 can ship with a *global, operator-only, default-off* `peers` flag that matches only **verified** bindings, and the workspace-owned form follows with step 11.
2. **Role lattice vs AIP-42 `delegates_to`.** AIP-46 standardises `delegates_to` (an allowlist) and calls the `level` lattice non-standard. Do we keep roles as the capability carrier (cheaper, already shipped) and add `delegates_to` later, or go straight to AIP-42 `policy` plus `delegates_to`?
3. **Cron capabilities after the creator retires.** Should a cron job keep running as its creator's principal after that session retires (frozen capabilities), or be downgraded to operator-only creation, so that sessions can no longer schedule work at all?
