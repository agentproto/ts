import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { serviceStatusSchema } from "./service.schema.js"

/**
 * AIP-14 contract: start a declared `type: "service"` script for a worktree.
 * Allocates the service's port (declared port if free, else ephemeral),
 * injects AGENTPROTO_PORT/URL + peer env, and registers its hostname with the
 * reverse proxy. Idempotent per worktree+name.
 */
export const startServiceTool = defineTool({
  id: "worktree.start-service",
  description:
    "Start a declared `scripts.<name>` service for a worktree as a supervised " +
    "long-running child process. Allocates a port, injects AGENTPROTO_PORT / " +
    "AGENTPROTO_URL and AGENTPROTO_SERVICE_<PEER>_PORT|URL for siblings, and " +
    "registers a `<script>--<branch>--<repo>.localhost` proxy route.",
  version: "0.1.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the source git repository root."),
    worktreePath: z.string().describe("Absolute path to the worktree."),
    branch: z.string().describe("The worktree's branch name."),
    script: z.string().describe("Name of the `type: \"service\"` script to start."),
    base: z.string().optional().describe("Ref whose committed agentproto.json is read. Default 'origin/main'."),
    proxyPort: z.number().int().min(1).max(65535).optional().describe("Reverse-proxy port used to build the service URL."),
  }),
  outputSchema: serviceStatusSchema,
  mutates: ["process:spawn"],
  approval: "auto",
  riskLevel: 1,
})
