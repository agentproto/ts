import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/** AIP-14 contract: stop a running supervised service for a worktree. */
export const stopServiceTool = defineTool({
  id: "worktree.stop-service",
  description:
    "Stop a supervised service (SIGTERM) for a worktree and drop its reverse-" +
    "proxy route. A no-op (stopped: false) if the service isn't running.",
  version: "0.1.0",
  inputSchema: z.object({
    worktreePath: z.string().describe("Absolute path to the worktree."),
    script: z.string().describe("Name of the service to stop."),
  }),
  outputSchema: z.object({
    stopped: z.boolean().describe("Whether a running service was actually stopped."),
  }),
  mutates: ["process:spawn"],
  approval: "auto",
  riskLevel: 1,
})
