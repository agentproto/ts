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
 *   - `handle.emit(dir)` writes `.agentproto/agents/<id>/AGENT.md` + shared
 *     `.agentproto/workflows/<id>/WORKFLOW.md` manifests under an
 *     agentproto-owned base (not the shared root `.agents/`), plus a root
 *     `.agentproto/APP.md` index (always) and a root `WORKSPACE.md` when the
 *     app has a `workspace`.
 *   - `loadAppHandle(dir)` reads that `APP.md` back — plus every AGENT.md /
 *     WORKFLOW.md / WORKSPACE.md it references — and re-runs `defineApp` so
 *     the attachment invariant re-validates. The inverse of `emit`.
 *
 * An app may declare a home `workspace` (AIP-34 `defineWorkspace`, or a
 * `{ id, name, owner, storage? }` shorthand). Its `owner` is the tenant
 * (guild / user / org) and its `storage` the backing store (defaults to
 * local-fs) — the tenant/local-storage model AIP-34/35 already ship, so
 * app-kit reuses it rather than inventing tenant folders.
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
export { loadAppHandle, AppLoadError } from "./load-app.js"
export { refKey, stripOwner } from "./refs.js"
export type {
  AppDefinition,
  AppHandle,
  AgentEntry,
  DoctypeHandle,
  WorkspaceShorthand,
  WorkspaceInput,
  ToMastraAgentOptions,
  EmittedApp,
} from "./types.js"
