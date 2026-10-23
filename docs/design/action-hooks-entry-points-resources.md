# Action hooks entry points and resources

Pinned commit: d6641f7eaba69c6274eff55c502b5602e93a89fc

Status: WIP research inventory. Every code claim is cited as
`path:LINE` plus the exact line fragment. Unverified claims are marked
NOT VERIFIED.

Scope: AIP-71 action hooks need every code path that reaches a
daemon-owned operation, so a hook can either intercept it or be honestly
declared unable to. This document inventories three planes:

1. Daemon-owned tools and resources (the daemon IS the effect).
2. Harness-internal tool calls (only observable, or permission-gated).
3. Sandbox and worktree resources (allocation, attach, checkpoint,
   teardown, gc).

## 1. Daemon-owned MCP tools

The daemon builds one or more `McpServer` instances and registers tools
on them. There is a transport authorizer, but no per-tool authorizer.
`createMcpServer` is the shared factory:
`packages/mcp-server/src/index.ts:68` `export async function createMcpServer(`.
The runtime's main gateway is built at
`packages/runtime/src/index.ts:3644` `const { server: rawServer } = await createMcpServer({`.
Transport auth for the root and scoped gateways:
`packages/runtime/src/http-server.ts:1709` `function authorizeMcp(req: IncomingMessage, res: ServerResponse): boolean {`
and
`packages/runtime/src/http-server.ts:1558` `function authorize(req: IncomingMessage, res: ServerResponse): boolean {`.

An in-process dispatcher exists for cron/routine tool actions, not for
normal MCP calls:
`packages/runtime/src/index.ts:4406` `dispatchToolBox.fn = async (name, inputs) => {`.
It calls the registered handler directly:
`packages/runtime/src/index.ts:4416` `const tool = internal._registeredTools?.[name]`.
No transport authorization runs on that path.

| Entry surface | Handler (cite) | Authorization or approval gate (cite) | Single dispatch function? | Streaming or one-shot | Error semantics | Bypass? |
|---|---|---|---|---|---|---|
| Root `/mcp` gateway and scoped orchestrator gateway, all registered tools | `packages/mcp-server/src/index.ts:68` `export async function createMcpServer(` plus per-domain `server.tool` registrations, e.g. `packages/runtime/src/index.ts:3750` `registerFsTools(server, { workspace, ...(boundary ? { boundary } : {}) })` | Transport only: `packages/runtime/src/http-server.ts:1709` `function authorizeMcp(req: IncomingMessage, res: ServerResponse): boolean {`. No per-tool check. | No. Handlers are registered individually on each `McpServer`; `dispatchTool` is a separate in-process path. | One-shot MCP request/response. Results are `CallToolResult` content arrays. | Handlers return `{ content, isError }` or throw; transport turns throws into JSON-RPC errors. | In-process `dispatchTool` reaches handlers without the HTTP authorizer: `packages/runtime/src/index.ts:4416` `const tool = internal._registeredTools?.[name]`. Cron tool actions use it: `packages/runtime/src/cron-scheduler.ts:1047` `const result = await dispatchTool(action.tool, action.inputs ?? {})`. |
| `mcp_imported_call` | `packages/runtime/src/session-tools.ts:3792` `"mcp_imported_call",`; calls the proxy at `packages/runtime/src/session-tools.ts:3828` `const out = await mcpProxy.callTool(` | No per-call permission check of its own: `packages/runtime/src/mcp-app-host-tools.ts:15` `has no per-call permission check of its own, so`. Only transport auth applies. | Yes for imported MCP servers: `packages/runtime/src/mcp-proxy.ts:276` `async callTool(`. | One-shot; upstream `tools/call` is request/response. | Upstream errors are returned in-band as tool results; proxy failures surface as thrown errors or `isError` results. | `/mcp/imported/<id>` registers `CallToolRequestSchema` and calls the proxy directly, never the MCP tool: `packages/runtime/src/http-server.ts:2348` `const out = await proxy.callTool(importId, request.params.name, request.params.arguments ?? {})`. |
| `app_tool_call` | `packages/runtime/src/app-tools.ts:3091` `"app_tool_call",`; shared implementation `packages/runtime/src/app-tools.ts:823` `export async function performAppToolCall(` | App allowlist: `packages/runtime/src/app-tools.ts:752` `if (!effectiveAllowlist.includes(input.tool)) {`. Caller app is a declaration, not a security boundary: `packages/runtime/src/app-tools.ts:879` ` * TRUST MODEL: the daemon is local-trust.`. | Yes at the app layer: `packages/runtime/src/app-tools.ts:702` `async function dispatchAllowlistedAppTool(`. It branches to imported, bundled, or daemon tools. | One-shot. | Returns `errorResult` / `textResult`; daemon dispatch errors are wrapped. | Same underlying effects are reachable without the app allowlist. Imported tools via `deps.callImportedTool`: `packages/runtime/src/app-tools.ts:787` `const result = await deps.callImportedTool(rest.slice(0, slash), rest.slice(slash + 1), dispatchArgs)`. Bundled tools via `runTool`: `packages/runtime/src/app-tools.ts:799` `const output = await runTool({ tool: bundledTool, candidates: bundled.drivers, input: args })`. |
| `app_call` | `packages/runtime/src/app-tools.ts:3111` `"app_call",`; implementation `packages/runtime/src/app-tools.ts:950` `export async function performAppCall(` | Declared `requires` still applies, but trust is explicit: `packages/runtime/src/app-tools.ts:3118` `TRUST MODEL: the daemon is local-trust`. | No separate dispatcher; it starts a workflow: `packages/runtime/src/app-tools.ts:1045` `run = await runner.startFromFile({ path: ref.path, input: input.input, appId: provider.appId })`. | One-shot start; the workflow run continues asynchronously. | Returns an in-band error code/result; MCP wrapper turns it into `isError` content. | `workflow_run_file` starts the same file with no app identity check: `packages/runtime/src/orchestration-tools.ts:1158` `await workflowRunner.startFromFile(`. |
| `mcp_app_tool_call` | `packages/runtime/src/mcp-app-host-tools.ts:70` `"mcp_app_tool_call",`; service `packages/runtime/src/mcp-apps-host.ts:155` `async callTool(input: {` | Visibility allowlist only: `packages/runtime/src/mcp-apps-host.ts:171` `const appVisible = exists && !index.notAppVisibleTools.includes(tool)`. No per-call permission. | Upstream client call: `packages/runtime/src/mcp-apps-host.ts:186` `result = await client.callTool(tool, input.args ?? {})`. | One-shot. | Returns the upstream `CallToolResult` verbatim, or an in-band `{ isError: true, ... }`; MCP-level `isError` is never set (see module doc). | The same upstream tool can be reached via `mcp_imported_call` or the imported HTTP route without the app-UI visibility gate. |
| Workflow `tool` steps (`workflow_run_file`, `workflow_start`, app workflows) | `packages/runtime/src/workflow-tool-registry.ts:117` `execute[id] = async ({ input }) =>` | No per-step admission or approval gate. Human approval is a separate step kind, not a wrapper: `packages/runtime/src/workflow-runner.ts:1572` `human-resolved approval steps:`. | Yes: `packages/runtime/src/workflow-tool-registry.ts:118` `unwrapDispatchResult(await dispatchTool(id, (input ?? {}) as Record<string, unknown>))`. | One-shot per step; workflow itself is long-running. | Non-OK results are thrown: `packages/runtime/src/workflow-tool-registry.ts:87` `if (r.isError) throw new Error(`. | The dispatched daemon tool is independently reachable through `/mcp`; workflow has no gate that the direct call lacks. |
| `command_execute` | `packages/runtime/src/command-tools.ts:228` `"command_execute",` | Workspace command allowlist: `packages/runtime/src/command-tools.ts:278` `if (!isCommandAllowed(allowlistEntries, baseName, args ?? [])) {`; matcher `packages/runtime/src/command-allowlist.ts:146` `export function isCommandAllowed(`. | Yes: `packages/runtime/src/command-tools.ts:392` `const result = await runCommand({`. | One-shot; returns exit code, stdout, stderr, timeout flag. | Allowlist refusal throws before running: `packages/runtime/src/command-tools.ts:283` `throw new Error(`. | Direct `runCommand` callers skip the allowlist: cron at `packages/runtime/src/cron-scheduler.ts:857` `const result = await runCommand({`. `terminal_start` is a separate PTY path under a looser gate documented at `packages/runtime/src/command-allowlist.ts:158` `refuses any command outside the workspace allowlist,`. |
| Browser tools (`start_browser` and the browser session verbs) | `packages/runtime/src/browser-tools.ts:438` `"start_browser",`; adapter call `packages/runtime/src/browser-tools.ts:550` `const instance = await adapter.ensure({` | No approval gate beyond transport. Browser profile choice can refuse a personal/default profile in the provider. | Partly: `ensure` is the shared adapter seam `adapters/browser/src/types.ts:56` `ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance>`; implementation forwards to the provider `adapters/browser/src/providers/to-adapter-handle.ts:41` `async ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {`. Each verb still has its own handler. | Mostly one-shot control calls; screencast/events are streaming. | Tool errors become `isError` results; adapter/provider failures are wrapped. | A harness can drive its own browser entirely outside these tools. Daemon-owned browser still has no per-action authorization. |
| `fetch_page` | `packages/runtime/src/browser-tools.ts:963` `"fetch_page",` | None. | No. Calls global `fetch` directly: `packages/runtime/src/browser-tools.ts:981` `const res = await fetch(input.url, { signal: ac.signal, redirect: "follow" })`. | One-shot. | Returns `blocked` for anti-bot, `errResult` for HTTP and network errors. | Any harness has its own HTTP client; this tool cannot cover it. |
| `file_read`, `file_write`, `file_delete` | `packages/runtime/src/fs-tools.ts:98` `"file_read",`; `packages/runtime/src/fs-tools.ts:162` `"file_write",`; `packages/runtime/src/fs-tools.ts:239` `"file_delete",` | Boundary/anchor check only for app-spawned sessions: `packages/runtime/src/fs-tools.ts:91` `const boundary = opts.boundary`. | No. Direct fs calls through anchors, e.g. `packages/runtime/src/fs-tools.ts:171` `await writeFile(abs, content, "utf8")` and `packages/runtime/src/fs-tools.ts:244` `await rm(abs, { recursive: true, force: true })`. | One-shot. | Node fs errors throw, becoming MCP errors. | `command_execute` (allowlisted shell) can read/write/delete anything the daemon user can. Harness-internal file tools never touch these handlers. |

## 2. Harness-internal tool calls

The daemon does not own these calls. It sees them only if the harness
adapter emits stream events or asks for permission.

| Surface | What the daemon sees | Can it allow, deny, or hold before execution? | Citations | Limits |
|---|---|---|---|---|
| ACP harness permission requests | An `agent-prompt` stream event carrying the tool name, raw input, and tool-call id | Yes, only when the session was spawned with `permissionHold`. The daemon can hold, answer allow, or answer deny through `respondPermission`. | `packages/acp/src/client/index.ts:1379` `async requestPermission(params) {`; `packages/acp/src/client/index.ts:1384` `if (hold.permissionHold) {`; `packages/acp/src/client/index.ts:1259` `kind: "agent-prompt",`; runtime reply `packages/runtime/src/sessions.ts:6850` `const respond = rt.agentSession.respondPermission` | Sandbox spawns do not get hold mode: `packages/runtime/src/session-spawn.ts:5269` `...(input.permissionHold && input.sandbox === undefined ? { permissionHold: true } : {}),`. |
| ACP tool-call and tool-result stream events | Tool name, arguments, call id, status; persisted to the transcript | No. Observe-only; the call is already running. | `packages/runtime/src/sessions.ts:7589` `const trackToolCall = (rt: SessionRuntime, evt: AgentStreamEvent): void => {`; `packages/runtime/src/sessions.ts:7614` `const resolveToolCall = (rt: SessionRuntime, toolCallId?: string): void => {`; `packages/runtime/src/transcript-writer.ts:627` `case "tool-call": {`; `packages/runtime/src/transcript-writer.ts:671` `case "tool-result": {` | No pre-execution hook. |
| Session event bus | Permission request and resolution events only; no tool-call event type | No. It is an emit-only bus. | `packages/runtime/src/session-event-bus.ts:18` `export type SessionEventType =`; `packages/runtime/src/session-event-bus.ts:23` `"session:permission-request"`; `packages/runtime/src/session-event-bus.ts:24` `"session:permission-resolved"`; `packages/runtime/src/session-event-bus.ts:1264` `export function createSessionEventBus(): SessionEventBus {` | Consumers cannot answer a held permission through the bus; that goes through `respondPermission`. |
| Non-ACP harnesses | Whatever their adapter surfaces; the semantic hooks engine is explicitly blind to them | No, by design today | `packages/runtime/src/hooks-config.ts:48` ` * posture, blind to 3/10 non-ACP harnesses. Plane 2 ("blast-radius") is the` | Exact harness list NOT VERIFIED. |
| In-process daemon tool calls (workflow steps, cron) | The handler call itself | No hook is consulted on this path | `packages/runtime/src/hooks-config.ts:60` ` * posture, is invisible to in-process tools, and doesn't exist for the 3` | This is the main gap between the semantic hook engine and actual effects. |

### Existing semantic hook engine

The rule engine sits at the permission-request handler, not at a common
dispatcher:
`packages/runtime/src/session-event-bus.ts` has no tool-call event, and the
only decision point is
`packages/runtime/src/sessions.ts:7767` `const hookRules = loadHooksConfig(workspace)`,
`packages/runtime/src/sessions.ts:7768` `const { decision, rule } = decideRule(`.
The fallback is `rt.permissionHold ? "hold" : "allow"`:
`packages/runtime/src/sessions.ts:7771` `rt.permissionHold ? "hold" : "allow",`.
`deny` does not auto-deny:
`packages/runtime/src/sessions.ts:7776` `degrades to the same hold-for-human path`.
Plane 2 is not enforced by this seam:
`packages/runtime/src/hooks-config.ts:342` ` * needs the OS sandbox (Plane 2), which this seam doesn't enforce.`.
Entry points `decideRule` and `decide`:
`packages/runtime/src/hooks-config.ts:351` `export function decideRule(`,
`packages/runtime/src/hooks-config.ts:367` `export function decide(`.

## 3. Sandbox resources

Sandbox sessions allocate, attach, checkpoint, and tear down through
`createSandboxAgentSessionHost`:
`packages/sandbox/src/agent-session-host.ts:451` `export async function createSandboxAgentSessionHost(`.
The provider contract is:
`packages/sandbox/src/agent-session-host.ts:313` `export interface SandboxProvider {`.
Boot, optional connect, and stop are part of that handle, with stop at
`packages/sandbox/src/agent-session-host.ts:514` `async stop(): Promise<void> {`.

| Operation | Entry surface | Handler (cite) | Gate (cite) | Single choke point? | Error semantics | Bypass? |
|---|---|---|---|---|---|---|
| Allocate a sandbox session | `agent_start` with `sandbox` | Tool: `packages/runtime/src/agent-tools.ts:632` `"agent_start",`; spawn: `packages/runtime/src/agent-tools.ts:762` `const result = await spawnAgentSession(`; host boot `packages/runtime/src/session-spawn.ts:6202` `host = await createSandboxAgentSessionHost({` | Spawn authorization is scoped role/denyTools, not a routed per-action check: `packages/runtime/src/permissions.ts:79` `"session.spawn": {`; `packages/runtime/src/permissions.ts:82` `surfaces: ["agent_start", "cron_create (agent action)", "workflow_start", "app_run", "POST /sessions"],`; `packages/runtime/src/role.ts:88` `"agent_start",` | Yes for session boxes. | Boot failure raises `SandboxHostBootFailedError` (documented next to the call). | `sandbox_exec` boots without the session host, see next row. |
| Attach or reattach | Boot-time reattach pass; `sandbox_exec` with `sandboxId` | `packages/runtime/src/sandbox-reattach.ts:195` `export async function runSandboxReattachPass(opts: {`; host created at `packages/runtime/src/sandbox-reattach.ts:261` `host = await createSandboxAgentSessionHost({`; exec attach `packages/runtime/src/sandbox-exec.ts:316` `: await handle.provider.connect!(opts.sandboxId, spec, { env: {} })` | No approval gate. | Two paths: reattach host and direct exec connect. | Reattach failures are tallied and bounded, never throw: documented at `packages/runtime/src/sandbox-reattach.ts:192`. | Direct provider connect in `sandbox_exec` skips the session host. |
| Ephemeral exec box | `sandbox_exec` with no `sandboxId` | `packages/runtime/src/sandbox-exec.ts:525` `"sandbox_exec",`; `packages/runtime/src/sandbox-exec.ts:343` `booted = await handle.provider.boot(spec, { env: {} })` | No approval gate beyond transport. | No sessions. Direct provider boot. | One-shot; always stops the ephemeral box in `finally`. | Confirmed bypass of `createSandboxAgentSessionHost`: it calls `provider.boot` directly. Same effect through HTTP `POST /sandboxes/exec` NOT VERIFIED. |
| Checkpoint | Proxy triggers on turn end, timer, and teardown | `packages/runtime/src/sandbox-agent-session-proxy.ts:709` `export function createSandboxAgentSessionProxy(`; turn end `packages/runtime/src/sandbox-agent-session-proxy.ts:1283` `if (!closed && !detached && (opts.checkpoint?.onTurnEnd ?? true)) void runCheckpoint(turnsSent)`; interval `packages/runtime/src/sandbox-agent-session-proxy.ts:1049` `const periodicTick = async (): Promise<void> => {` | No gate. | Yes: `runCheckpoint` inside the proxy; checkpointer factory `packages/runtime/src/sandbox-delivery.ts:915` `export function createSandboxCheckpointer(` | Checkpoint failures are caught/logged on the periodic path; teardown checkpoint is awaited during close. | Trigger set is configurable: `packages/runtime/src/sandbox-delivery.ts:1004` the configurable trigger array at sandbox-delivery.ts:1004. A config can disable a checkpoint. |
| Teardown (close, kill, idle reap, shutdown) | `agent_kill`, idle reaper, daemon shutdown, reattach cleanup | `packages/runtime/src/sandbox-agent-session-proxy.ts:1304` `async close(closeOpts?: {`; pre-teardown hook `packages/runtime/src/sandbox-agent-session-proxy.ts:1372` `if (closeOpts?.daemonShutdown !== true) await opts.onBeforeTeardown?.()` | No approval gate; kill is the default. | Mostly one proxy `close`; host stop is `packages/sandbox/src/agent-session-host.ts:514` `async stop(): Promise<void> {`. | Teardown errors are surfaced/stamped; best-effort branches exist. | Direct provider removal in gc skips the proxy. |
| GC / orphan reap | Sandbox gc pass and orphan reaper | `packages/runtime/src/sandbox-gc.ts:130` `export async function reapGcEntry(`; `packages/runtime/src/sandbox-gc.ts:233` `export async function runSandboxGcPass(`; orphan `packages/runtime/src/sandbox-orphan-gc.ts:276` `export async function reapSandboxOrphan(` | No approval gate. | No; two independent reapers. | Provider removal at `packages/runtime/src/sandbox-gc.ts:156` `await handle.provider.remove(entry.sandboxId, { force: true })`; already-gone is treated as success (`packages/runtime/src/sandbox-gc.ts:150` comment). | Provider-level `remove` (`packages/sandbox-e2b/src/provider.ts:854` `async remove(sandboxId: string): Promise<void> {`) is reachable without the session proxy. |

Provider implementation for boot and connect:
`packages/sandbox-e2b/src/provider.ts:737` `async boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {`,
`packages/sandbox-e2b/src/provider.ts:744` `const sandbox = await Sandbox.create(template, {`,
`packages/sandbox-e2b/src/provider.ts:783` `async connect(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {`.

## 4. Worktree, browser, and provisioning resources

| Operation | Entry surface | Handler (cite) | Gate (cite) | Single choke point? | Error semantics | Bypass? |
|---|---|---|---|---|---|---|
| Worktree creation | `agent_start` with isolation, `worktree.provision`, CLI `worktree new` | Spawn path: `packages/runtime/src/session-spawn.ts:4562` `provisionWorktree({`; tool id `packages/worktree/src/tools/provision-worktree.tool.ts:10` `id: "worktree.provision",`; CLI wiring `packages/cli/src/commands/serve.ts:919` `provisionWorktree: makeWorktreeProvisioner(),` | Same spawn authorization as `agent_start` (no separate worktree approval). | Provisioner port, but multiple entry surfaces. | Spawn path treats provisioning failure asynchronously; CLI reports directly. | Direct CLI command and direct `worktree.provision` tool do not pass through `agent_start`'s spawn checks. |
| Worktree GC | `worktree_gc` | `packages/runtime/src/session-tools.ts:4625` `"worktree_gc",`; invoke `packages/runtime/src/session-tools.ts:4742` `runWorktreeGc({` | Dry run by default; `apply: true` is the only destructive opt-in (tool description). No approval gate. | Yes at the injected runner: `packages/runtime/src/session-tools.ts:780` `runWorktreeGc?: WorktreeGcRunner` | Returns plan or a job; background fallback with status polling. | none beyond needing the injected runner. |
| Branch GC | `branch_gc` | `packages/runtime/src/session-tools.ts:4799` `"branch_gc",`; `packages/runtime/src/session-tools.ts:4890` `const { job, promise } = branchGcJobs.start(async () => withBranchGcApplySummary(await runBranchGc(runInput)))` | Dry run by default; apply is explicit. No approval gate. | Engine: `packages/worktree/src/branch-gc.ts:1642` `export async function applyBranchGc(plan: BranchGcPlan, options: ApplyBranchGcOptions): Promise<BranchGcApplyResult> {` | Job/background semantics identical to worktree gc. | CLI and scheduler callers NOT VERIFIED. |
| Browser session allocation | `start_browser` | `packages/runtime/src/browser-tools.ts:438` `"start_browser",`; adapter ensure `packages/runtime/src/browser-tools.ts:550` `const instance = await adapter.ensure({` | No approval gate. Personal attach is explicit in adapter launch options. | Adapter `ensure`, then provider launch. | Tool error result. | Harness-owned browsers are outside the daemon. |
| Browser profile allocation | Chrome live provider; chrome provider | Dedicated profile dir `adapters/browser-chrome/src/live-launch.ts:35` `export function liveLaunchDataDir`; profile resolution `packages/browser-profiles/src/chrome-identity.ts:69` `export function resolveChromeProfile(` | Chrome provider refuses default/full profile: `adapters/browser-chrome/src/index.ts:5` ` * --remote-debugging-port there, so every launch gets a fresh dedicated`. | `liveLaunchDataDir` for the live provider; separate logic for chrome profiles. | Provider throws on refused profile. | Direct Chrome launch by a harness is not covered. |
| Heavy provisioning queue | Any provisioner that calls `provisionScheduler.acquire` | `packages/worktree/src/provision-scheduler.ts:351` `export const provisionScheduler = new ProvisionScheduler()`; acquire `packages/worktree/src/provision-scheduler.ts:227` `acquire(req: AcquireRequest): Promise<ProvisionLease> {`; call site `packages/worktree/src/provider/bodies/provision-worktree.body.ts:150` `lease = await provisionScheduler.acquire({` | Not an authorization gate; a concurrency/fairness queue. Default cap `packages/worktree/src/provision-scheduler.ts:28` `/** Default cap on concurrently running heavy segments. */`. Configured at `packages/cli/src/commands/worktree.ts:402` `provisionScheduler.configure(parseProvisionLimits(cfg?.worktrees))`. | Yes, one daemon-wide singleton. | Acquire can wait; queued work is cancellable. | Work done outside the singleton, if any, NOT VERIFIED. |

## 5. Narrowest choke points

1. Daemon MCP tools: there is no dispatcher. The narrowest shared point is
   the server factory `createMcpServer` plus the registration wrapper, not
   `dispatchTool`. `dispatchTool` is only the cron/routine path.
2. Imported MCP tools: `McpProxyRegistry.callTool` covers both
   `mcp_imported_call` and `/mcp/imported/<id>`.
3. App tools: `performAppToolCall` is shared by the MCP tool and the HTTP
   panel route for installed apps, but `mcp_app_tool_call` has its own
   `McpAppsHostService.callTool` and does not pass through it.
4. Shell effects: `runCommand` is the narrowest shared shell primitive,
   except for `terminal_start` (PTY) and direct `provision` / build spawns.
5. Sandbox session lifecycle: `createSandboxAgentSessionHost` covers
   allocate, attach, and stop for sessions. `sandbox_exec` bypasses it.
6. Worktree: `provisionWorktree` plus the `provisionScheduler` singleton,
   plus separate `worktree_gc` / `branch_gc` engines.
7. Browser: adapter `ensure` for daemon verbs; `liveLaunchDataDir` for the
   persistent live profile. Harness browsers are out of scope.
8. Harness tools: only the ACP permission request is a true pre-execution
   interposition point. Everything else is observation.

## 6. Confirmed bypasses

| Bypass | Evidence |
|---|---|
| Imported MCP HTTP route calls the proxy directly, skipping the MCP tool and its surface | `packages/runtime/src/http-server.ts:2348` `const out = await proxy.callTool(importId, request.params.name, request.params.arguments ?? {})` |
| In-process `dispatchTool` calls registered handlers without transport auth | `packages/runtime/src/index.ts:4416` `const tool = internal._registeredTools?.[name]` |
| `sandbox_exec` boots and connects providers without `createSandboxAgentSessionHost` | `packages/runtime/src/sandbox-exec.ts:343` `booted = await handle.provider.boot(spec, { env: {} })`; `packages/runtime/src/sandbox-exec.ts:316` `: await handle.provider.connect!(opts.sandboxId, spec, { env: {} })` |
| Cron tool actions bypass the MCP transport and the semantic hook seam | `packages/runtime/src/cron-scheduler.ts:1047` `const result = await dispatchTool(action.tool, action.inputs ?? {})` |
| Sandbox GC removes providers directly, bypassing the session proxy | `packages/runtime/src/sandbox-gc.ts:156` `await handle.provider.remove(entry.sandboxId, { force: true })` |
| `mcp_app_tool_call` bypasses the app `performAppToolCall` allowlist and dispatch | `packages/runtime/src/mcp-apps-host.ts:186` `result = await client.callTool(tool, input.args ?? {})` |
| `app_tool_call` imported/bundled branches bypass the daemon `dispatchTool` | `packages/runtime/src/app-tools.ts:787` `const result = await deps.callImportedTool(rest.slice(0, slash), rest.slice(slash + 1), dispatchArgs)`; `packages/runtime/src/app-tools.ts:799` `const output = await runTool({ tool: bundledTool, candidates: bundled.drivers, input: args })` |
| `workflow_run_file` starts a workflow without `app_call`'s app identity check | `packages/runtime/src/orchestration-tools.ts:1158` `await workflowRunner.startFromFile(` |
| Harness-internal tools are not interceptable, and the semantic engine is blind to in-process tools and non-ACP harnesses | `packages/runtime/src/hooks-config.ts:48`; `packages/runtime/src/hooks-config.ts:60` |

## 7. NOT VERIFIED

- Exact JSON-RPC error shape produced by the MCP SDK for thrown handler
  errors versus returned `isError` results.
- Whether any other component besides `sandbox-exec.ts` calls
  `provider.boot` or `provider.connect` directly.
- Whether `POST /sandboxes/exec` shares the `sandbox-exec` direct boot path.
- All callers of `applyBranchGc` outside the daemon tool.
- Whether the provisioning scheduler is used by every heavy provisioning
  path, including CLI and app builds.
- The complete list of non-ACP harnesses counted in the `3/10` comment.
- Any per-action permission enforcement for `mcp_imported_call`,
  `mcp_app_tool_call`, browser, fs, and worktree GC beyond the gates cited
  above.
