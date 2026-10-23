/**
 * MCP tools for model lists — `model_list_save`, `model_list_list`,
 * `model_list_delete`, `model_list_resolve`.
 *
 * Mirrors `user-preset-tools.ts`: the store is the single validation boundary
 * (`modelListSchema`), and `model_list_resolve` returns the same
 * `explainModelList` rows a CLI `--explain` prints.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { explainModelList, type ModelList } from "@agentproto/model-catalog/lists"
import {
  deleteModelList,
  getModelListSource,
  listModelLists,
  modelListSchema,
  saveModelList,
} from "./model-list-store.js"

function text(value: object): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

export function registerModelListTools(server: McpServer): void {
  server.tool(
    "model_list_list",
    "List the user's model lists from `~/.agentproto/model-lists.json`. A " +
      "list is named data: include selectors (access-target vocabulary plus " +
      "price / context / route variant), exclude selectors that always win, " +
      "explicit `ids` pins, an ordering mode and a rotation strategy. The " +
      "seed list `zero-cost` includes `tag:price:zero`.",
    {},
    async () => text({ lists: await listModelLists() }),
  )

  server.tool(
    "model_list_save",
    "Create or update (upsert by id) a model list. `id` must be lowercase " +
      "kebab-case. Selectors are OR-ed in `include`; any `exclude` match wins " +
      "over `include` and `ids`. `ids` pins match by exact id and need no " +
      "catalog entry. `order` is `listed` (default), `cheapest`, " +
      "`largest-context` or `newest`.",
    modelListSchema.shape,
    async input => {
      try {
        const saved = await saveModelList(input as ModelList)
        return text({ list: saved })
      } catch (err) {
        return errorText(
          `model_list_save failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  server.tool(
    "model_list_delete",
    "Delete a model list by id. Idempotent: a missing id returns " +
      "`{ deleted: false }`.",
    { id: z.string().describe("The model list id to delete.") },
    async ({ id }) => {
      try {
        return text({ deleted: await deleteModelList(id) })
      } catch (err) {
        return errorText(
          `model_list_delete failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  server.tool(
    "model_list_resolve",
    "Resolve a model list to its ordered, de-duplicated model ids and report " +
      "why each one is included (`via` is the matching selector or `ids`). " +
      "Throws for an unknown list id or a list cycle.",
    { id: z.string().describe("The model list id to resolve.") },
    async ({ id }) => {
      try {
        return text({ models: explainModelList(id, getModelListSource()) })
      } catch (err) {
        return errorText(
          `model_list_resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
