import { mkdir, copyFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { implementTool } from "@agentproto/driver"
import { ToolError } from "@agentproto/tool"
import { provisionWorktreeTool } from "../../tools/provision-worktree.tool.js"
import { execGit, execShell } from "../../exec.js"
import { expandGlob } from "../../glob.js"

export const provisionWorktreeBuiltin = implementTool(
  provisionWorktreeTool,
  async ({ input }) => {
    const base = input.base ?? "origin/main"
    const branch = `wt/${input.slug}`
    const cwd = resolve(input.repoRoot, "..", "_worktrees", input.slug)

    await execGit(input.repoRoot, ["worktree", "add", "-b", branch, cwd, base])

    if (input.depsCmd) {
      const result = await execShell(input.depsCmd, cwd)
      if (result.exitCode !== 0) {
        throw new ToolError({
          code: "execution_failed",
          message: `depsCmd '${input.depsCmd}' failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        })
      }
    }

    for (const pattern of input.copyGlobs ?? []) {
      const matches = await expandGlob(input.repoRoot, pattern)
      for (const rel of matches) {
        const dest = join(cwd, rel)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(join(input.repoRoot, rel), dest)
      }
    }

    return { cwd, branch }
  },
)
