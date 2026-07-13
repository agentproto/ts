import { defineDriver } from "@agentproto/driver"
import { provisionWorktreeBuiltin } from "./bodies/provision-worktree.body.js"
import { cleanupWorktreeBuiltin } from "./bodies/cleanup-worktree.body.js"
import { runGateBuiltin } from "./bodies/run-gate.body.js"
import { runScriptBuiltin } from "./bodies/run-script.body.js"
import { startServiceBuiltin } from "./bodies/start-service.body.js"
import { stopServiceBuiltin } from "./bodies/stop-service.body.js"
import { listServicesBuiltin } from "./bodies/list-services.body.js"

/**
 * AIP-30 PROVIDER for the three `worktree.*` TOOL contracts. `kind: "builtin"`
 * — runs in-process, shelling out to `git` / the caller's commands directly.
 * No subprocess-DRIVER indirection, no network hop.
 */
export const worktreeProvider = defineDriver({
  id: "worktree-builtin",
  name: "Git Worktree (built-in)",
  description:
    "In-process provision / gate / cleanup of git worktrees via direct git " +
    "and shell invocations. No sandboxing — the host owns the filesystem " +
    "and process boundary.",
  version: "0.1.0",
  kind: "builtin",
  implements: [
    { tool: "worktree.provision", version: "0.1.0" },
    { tool: "worktree.cleanup", version: "0.1.0" },
    { tool: "worktree.run-gate", version: "0.1.0" },
    { tool: "worktree.run-script", version: "0.1.0" },
    { tool: "worktree.start-service", version: "0.1.0" },
    { tool: "worktree.stop-service", version: "0.1.0" },
    { tool: "worktree.list-services", version: "0.1.0" },
  ],
  implementations: [
    provisionWorktreeBuiltin,
    cleanupWorktreeBuiltin,
    runGateBuiltin,
    runScriptBuiltin,
    startServiceBuiltin,
    stopServiceBuiltin,
    listServicesBuiltin,
  ],
})
