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

/** Resolve the prospective list against the store plus itself before writing:
 *  an unknown nested id or a cycle is a save-time error, not a later throw on
 *  the spawn/rotation hot path. */
async function validateSave(list: ModelList): Promise<string | undefined> {
  const byId = new Map((await listModelLists()).map(existing => [existing.id, existing]))
  byId.set(list.id, list)
  try {
    explainModelList(list.id, { get: id => byId.get(id) })
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function registerModelListTools(server: McpServer): void {
  server.tool(
    "model_list_list",
    "List the user's model lists from `~/.agentproto/model-lists.json`. A " +
      "list is named data: include selectors (access-target vocabulary plus " +
      "price / context / route variant), exclude selectors that always win, " +
      "explicit `ids` pins, an ordering mode and a rotation strategy. The " +
      "a seed list selects models by the `price:zero` tag.",
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
        const list = input as ModelList
        const invalid = await validateSave(list)
        if (invalid) return errorText(`model_list_save failed: ${invalid}`)
        const saved = await saveModelList(list)
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
