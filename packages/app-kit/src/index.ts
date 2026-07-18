/**
 * @agentproto/app-kit — declare one or more agents (with their system
 * prompts) and the workflows they run in one TypeScript module, then
 * import them anywhere.
 *
 * A thin umbrella over AIP-42 `defineAgent` + AIP-15 `defineWorkflow`:
 *
 *   - `defineApp({ agents, workflows, attach })` cross-links agents and
 *     workflows (every workflow an agent lists must be bundled, and every
 *     bundled workflow must be listed by some agent), and carries any
 *     other AIP handles you `attach` (AIP-6 company, AIP-25 persona,
 *     AIP-47 role…). Returns a frozen `AppHandle`.
 *   - `handle.toMastraAgents(resolvers)` builds each agent into a Mastra
 *     agent whose `instructions` field is the real system prompt — the
 *     AGENT.md body (via `@agentproto/mastra`).
 *   - `handle.emit(dir)` writes the `.agents/<id>/AGENT.md` + shared
 *     `workflows/<id>/WORKFLOW.md` manifests the daemon / `agentproto-run`
 *     lane load.
 *
 * There is no `systemPrompt` field in AIP: the prompt is the AGENT.md
 * BODY (frontmatter is `.strict()`). So each agent carries an optional
 * `body`; omit it and the prompt composes from persona / boundaries /
 * traits, the way Guilde assembles an operator prompt from role + persona.
 *
 * `@mastra/core` is a peer dependency — install it in the host if you
 * call `toMastraAgent(s)`. `emit` has no Mastra dependency.
 */

export { defineApp, AppDefinitionError } from "./define-app.js"
export { emitApp } from "./emit.js"
export { refKey, stripOwner } from "./refs.js"
export type {
  AppDefinition,
  AppHandle,
  AgentEntry,
  DoctypeHandle,
  ToMastraAgentOptions,
  EmittedApp,
} from "./types.js"
