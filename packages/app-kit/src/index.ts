/**
 * @agentproto/app-kit — declare an agent (with its system prompt) and
 * its workflows in one TypeScript module, then import them anywhere.
 *
 * A thin umbrella over AIP-42 `defineAgent` + AIP-15 `defineWorkflow`:
 *
 *   - `defineApp({ agent, systemPrompt, workflows })` cross-links the two
 *     (every workflow the agent lists must be bundled, and vice versa),
 *     returning a frozen `AppHandle`.
 *   - `handle.toMastraAgent(resolvers)` turns the AGENT.md body into a
 *     real Mastra `instructions` field (via `@agentproto/mastra`).
 *   - `handle.emit(dir)` writes the `.agents/<id>/AGENT.md` + `WORKFLOW.md`
 *     manifests the daemon / `agentproto-run` lane load.
 *
 * `@mastra/core` is a peer dependency — install it in the host if you
 * call `toMastraAgent`. `emit` has no Mastra dependency.
 */

export { defineApp, AppDefinitionError } from "./define-app.js"
export { emitApp } from "./emit.js"
export { refKey, stripOwner } from "./refs.js"
export type {
  AppDefinition,
  AppHandle,
  ToMastraAgentOptions,
  EmittedApp,
} from "./types.js"
