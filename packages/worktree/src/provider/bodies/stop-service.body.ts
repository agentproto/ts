import { implementTool } from "@agentproto/driver"
import { stopServiceTool } from "../../tools/stop-service.tool.js"
import { getSupervisor } from "../../services/runtime.js"

export const stopServiceBuiltin = implementTool(stopServiceTool, async ({ input }) => {
  const supervisor = getSupervisor(input.worktreePath)
  if (!supervisor) return { stopped: false }
  const stopped = await supervisor.stop(input.script)
  return { stopped }
})
