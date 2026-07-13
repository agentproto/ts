import { implementTool } from "@agentproto/driver"
import { listServicesTool } from "../../tools/list-services.tool.js"
import { resolveSupervisor } from "../../services/runtime.js"

export const listServicesBuiltin = implementTool(listServicesTool, async ({ input }) => {
  const { supervisor } = await resolveSupervisor({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    base: input.base,
    proxyPort: input.proxyPort,
  })
  return { services: supervisor.list() }
})
