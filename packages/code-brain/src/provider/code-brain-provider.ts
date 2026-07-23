import { defineDriver } from "@agentproto/driver"
import { askCodebaseBuiltin } from "./bodies/ask-codebase.body.js"

/**
 * AIP-30 PROVIDER for the `ask_codebase` TOOL contract. `kind: "builtin"` —
 * runs in-process and dispatches to the host-injected `ICodeBrainProvider`
 * on the tool context. Mirrors the worktree builtin provider
 * (`packages/worktree/src/provider/worktree-provider.ts:15`).
 *
 * This provider carries NO backend of its own — it is the pure, in-process
 * binding of the contract to its typed body. A concrete backend is supplied
 * at call time via `context.codeBrain`, or served by one of the `./mcp`,
 * `./http`, `./cli` surface projections.
 */
export const codeBrainProvider = defineDriver({
  id: "code-brain-builtin",
  name: "Code Brain (built-in)",
  description:
    "In-process dispatch of `ask_codebase` to a host-injected " +
    "ICodeBrainProvider. Backend-agnostic — the provider is supplied on the " +
    "tool context, so this binding names no code-intelligence engine.",
  version: "0.1.0",
  kind: "builtin",
  implements: [{ tool: "ask_codebase", version: "0.1.0" }],
  implementations: [askCodebaseBuiltin],
})
