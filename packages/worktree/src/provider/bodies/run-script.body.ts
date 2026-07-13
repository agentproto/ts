import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { runScriptTool } from "../../tools/run-script.tool.js"
import { loadConfigFromBase, getScript } from "../../config.js"
import { hookEnv } from "../../env.js"
import { execShell } from "../../exec.js"

export const runScriptBuiltin = implementTool(runScriptTool, async ({ input }) => {
  const config = await loadConfigFromBase(input.repoRoot, input.base)
  const script = config ? getScript(config, input.script) : undefined
  if (!script) {
    throw new ToolError({
      code: "not_found",
      message: `no script "${input.script}" in ${input.base ?? "origin/main"}:agentproto.json`,
    })
  }
  const env = hookEnv({
    sourceCheckoutPath: input.repoRoot,
    worktreePath: input.worktreePath,
    branchName: input.branch,
  })
  const result = await execShell(script.command, input.worktreePath, { env })
  return { passed: result.exitCode === 0, ...result }
})
