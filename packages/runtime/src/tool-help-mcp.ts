/**
 * `tool_help` — the read side of the "schema is a contract, not the manual"
 * split (see `tool-help.ts`). A slimmed tool/field description ends with a
 * pointer like `Details: tool_help {name:"agent_start"}`; this is that call.
 *
 * Always-on (see `DEFAULT_ALWAYS_ON_TOOLS` in index.ts) and deliberately
 * tiny itself — the whole point is that a session doesn't pay for every
 * tool's long-form docs just to have this one available.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { extractHelpSection, getToolHelp, listToolHelpTopics } from "./tool-help.js"

export function registerToolHelpTool(server: McpServer): void {
  server.tool(
    "tool_help",
    "Long-form documentation for a tool — edge cases, field interactions, " +
      "examples that don't fit in its short schema description. Read-only.",
    {
      name: z.string().min(1).describe("Tool name, e.g. 'agent_start'."),
      topic: z
        .string()
        .optional()
        .describe("Optional `##` section heading within the doc to return instead of the full text."),
    },
    async ({ name, topic }) => {
      const doc = getToolHelp(name)
      if (!doc) {
        const topics = listToolHelpTopics()
        return {
          content: [
            {
              type: "text",
              text:
                `No help doc for "${name}". ` +
                (topics.length > 0
                  ? `Tools with docs: ${topics.join(", ")}.`
                  : "No tool docs are installed."),
            },
          ],
          isError: true,
        }
      }
      if (!topic) return { content: [{ type: "text", text: doc }] }

      const section = extractHelpSection(doc, topic)
      if (!section) {
        return {
          content: [
            {
              type: "text",
              text: `"${name}" has no "${topic}" section. Returning the full doc instead.\n\n${doc}`,
            },
          ],
        }
      }
      return { content: [{ type: "text", text: section }] }
    },
  )
}
