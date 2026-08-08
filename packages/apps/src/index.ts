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
 */

export { codeTeam } from "./code-team/index.js"
export { contentTeam } from "./content-team/index.js"
export { mailTriage } from "./mail-triage/index.js"
