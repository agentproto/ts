import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { serviceStatusSchema } from "./service.schema.js"

/**
 * AIP-14 contract: list every declared service for a worktree with its
 * resolved port / proxy URL and current run status. Resolves (allocating
 * ports for) the worktree's services on first call so declared-but-unstarted
 * services still appear.
 */
export const listServicesTool = defineTool({
  id: "worktree.list-services",
  description:
    "List the declared services for a worktree — each with its allocated " +
    "port, `*.localhost` proxy URL, and running/exited status.",
  version: "0.1.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the source git repository root."),
    worktreePath: z.string().describe("Absolute path to the worktree."),
    branch: z.string().describe("The worktree's branch name."),
    base: z.string().optional().describe("Ref whose committed agentproto.json is read. Default 'origin/main'."),
    proxyPort: z.number().int().min(1).max(65535).optional().describe("Reverse-proxy port used to build service URLs."),
  }),
  outputSchema: z.object({
    services: z.array(serviceStatusSchema),
  }),
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})
