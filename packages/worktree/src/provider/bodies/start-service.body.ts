import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { startServiceTool } from "../../tools/start-service.tool.js"
import { resolveSupervisor } from "../../services/runtime.js"

export const startServiceBuiltin = implementTool(startServiceTool, async ({ input }) => {
  const { supervisor } = await resolveSupervisor({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    base: input.base,
    proxyPort: input.proxyPort,
  })
  if (!supervisor.get(input.script)) {
    throw new ToolError({
      code: "not_found",
      message: `no service "${input.script}" declared (type: "service") in ${input.base ?? "origin/main"}:agentproto.json`,
    })
  }
  return supervisor.start(input.script)
})
