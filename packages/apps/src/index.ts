/**
 * @agentproto/apps — a home for ready-made agentproto apps: **teams** of
 * agents plus the workflows they run, each declared with
 * [`@agentproto/app-kit`](../app-kit).
 *
 * An app here is a plain `AppHandle`. Import one and use any subset of its
 * agents/workflows from your own host:
 *
 *   - in-process: `await codeTeam.toMastraAgents({ resolveModel })` and pick
 *     the agent(s) you want by id;
 *   - on disk: `await codeTeam.emit(dir)` to write the AGENT.md / WORKFLOW.md
 *     manifests for a runtime that loads from a workspace.
 *
 * Teams are generic (`@agentproto/…` ids, no product dependency), so any host
 * — including agentik-studio — can consume them. Each team lives in its own
 * folder (`code-team/`, `content-team/`) with `agents/` + `workflows/`, and is
 * re-exported here + as a subpath (`@agentproto/apps/<team>`).
 *
 * This package also carries five daemon-builtin panels (`sessions-panel`,
 * `agents-overview`, `bureau-sessions`, `session-story`, `live-session`) —
 * @agentproto/runtime's house-app-quality UI widgets. Unlike the teams
 * above they are NOT `AppHandle`s: `defineApp` requires a non-empty
 * `agents` array, and these are pure read-only viewers with no agent
 * behavior of their own. Each exports a `make<Name>App(ops)` factory
 * producing the `AgnoMcpApp` shape @agentproto/runtime mounts directly at
 * boot (see runtime's builtin-apps.ts) — no `app_install` step, and no
 * dependency on @agentproto/app-kit's agent/workflow bundling.
 */

export { codeTeam } from "./code-team/index.js"
export { contentTeam } from "./content-team/index.js"
export { mailTriage } from "./mail-triage/index.js"
export { mediaViewer } from "./media-viewer/index.js"
export { opsPanel } from "./ops-panel/index.js"
export { sessionViewer } from "./session-viewer/index.js"

export type { AgnoMcpApp } from "./mcp-app-types.js"
export { panelBridgeScript } from "./panel-bridge.js"
export { makeSessionsPanelApp } from "./sessions-panel/index.js"
export type { SessionsPanelOps, SessionsInput, SessionsOutput } from "./sessions-panel/index.js"
export { makeAgentsOverviewApp } from "./agents-overview/index.js"
export type { AgentsOverviewOps, AgentsOverviewInput, AgentsOverviewOutput } from "./agents-overview/index.js"
export { makeBureauSessionsApp } from "./bureau-sessions/index.js"
export type { BureauSessionsOps, BureauSessionsInput, BureauSessionsOutput } from "./bureau-sessions/index.js"
export { makeSessionStoryPanelApp } from "./session-story/index.js"
export type { SessionStoryOps, SessionStoryInput, SessionStoryOutput } from "./session-story/index.js"
export { makeLiveSessionApp } from "./live-session/index.js"
export type { LiveSessionOps, LiveSessionInput, LiveSessionOutput } from "./live-session/index.js"
