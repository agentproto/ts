import { implementTool } from "@agentproto/driver"
import { runGateTool } from "../../tools/run-gate.tool.js"
import { execShell } from "../../exec.js"

export const runGateBuiltin = implementTool(runGateTool, async ({ input }) => {
  const result = await execShell(input.cmd, input.cwd)
  return { passed: result.exitCode === 0, ...result }
})
