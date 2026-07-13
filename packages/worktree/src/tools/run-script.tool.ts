import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/**
 * AIP-14 contract: run a one-shot named `scripts.<name>` command from the
 * repo's committed `agentproto.json` inside a worktree, with the
 * `AGENTPROTO_*` context env injected. For long-running services use
 * `worktree.start-service` instead.
 */
export const runScriptTool = defineTool({
  id: "worktree.run-script",
  description:
    "Run a declared `scripts.<name>` command (from the base tree's " +
    "agentproto.json) inside `worktreePath`, injecting AGENTPROTO_* env, and " +
    "report pass/fail with captured stdout/stderr. For a `type: \"service\"` " +
    "script prefer `worktree.start-service`.",
  version: "0.1.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the source git repository root."),
    worktreePath: z.string().describe("Absolute path to the worktree to run in."),
    branch: z.string().describe("The worktree's branch name (for AGENTPROTO_BRANCH_NAME)."),
    script: z.string().describe("Name of the script under `scripts` to run."),
    base: z.string().optional().describe("Ref whose committed agentproto.json is read. Default 'origin/main'."),
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
