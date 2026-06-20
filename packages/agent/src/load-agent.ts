/**
 * AIP-42: async agent loader with extends-chain validation.
 *
 * `defineAgent` is synchronous and cannot run depth/cycle checks that
 * require loading parent manifests from disk. `loadAgent` is the
 * recommended async entry point that wraps `agentVerbs.load` with
 * `validateExtendsChain` so every load site gets integrity checking
 * without callers wiring it manually.
 *
 * Standard workspace layout assumed for workspace inference:
 *   <workspace>/.agents/<id>/AGENT.md
 *
 * Pass `opts.workspace` explicitly when agents live elsewhere.
 */

import { dirname, join, resolve as resolvePath } from "node:path"
import { agentVerbs } from "./spec.js"
import { validateExtendsChain } from "./validate-extends-chain.js"
import type { AgentHandle } from "./types.js"

/**
 * Load an agent manifest from disk and validate its `extends` chain
 * (AIP-42: depth ≤ 5, no cycles). Throws before returning when a
 * violation is detected so the agent never enters execution with a
 * malformed inheritance chain.
 *
 * @param path     Absolute path to the AGENT.md file.
 * @param opts     `workspace` — root directory containing `.agents/`.
 *                 Derived from the standard path layout when omitted.
 */
export async function loadAgent(
  path: string,
  opts?: { workspace?: string },
): Promise<{ path: string; handle: AgentHandle; body: string }> {
  const result = await agentVerbs.load(path)
  const { handle } = result

  if (handle.extends != null) {
    const workspace =
      opts?.workspace ??
      // Infer from <workspace>/.agents/<id>/AGENT.md → go 3 dirs up.
      dirname(dirname(dirname(resolvePath(path))))

    await validateExtendsChain(handle, {
      async loadParent(ref) {
        if (typeof ref !== "string") return null
        try {
          const parentPath = join(workspace, ".agents", ref, "AGENT.md")
          const { handle: parent } = await agentVerbs.load(parentPath)
          return { id: parent.id, extends: parent.extends }
        } catch {
          return null
        }
      },
    })
  }

  return result
}
