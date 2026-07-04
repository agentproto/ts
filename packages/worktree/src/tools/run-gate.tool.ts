import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/**
 * AIP-14 contract: run a caller-provided gate/check command inside a
 * directory (typically a provisioned worktree) and report pass/fail.
 * `cmd` is a trusted, developer-authored config value (same trust model as
 * a CI job's `script:` line), run through a shell so it may include flags.
 */
export const runGateTool = defineTool({
  id: "worktree.run-gate",
  description:
    "Run a gate command (e.g. 'pnpm test') inside `cwd` and report pass/fail " +
    "from its exit code, along with captured stdout/stderr.",
  version: "0.1.0",
  inputSchema: z.object({
    cwd: z.string().describe("Directory to run the command in."),
    cmd: z.string().describe("Shell command to run, e.g. 'pnpm test'."),
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  mutates: [],
  approval: "auto",
  riskLevel: 1,
})
