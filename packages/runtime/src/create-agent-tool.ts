/**
 * `create_agent` — a daemon MCP tool that renders an AIP-42 `agent/v1`
 * AGENT.md for a slug into the caller's workspace `.agents/<slug>/AGENT.md`
 * (the canonical hand-written layout `loadAgent` / `self_inspect` read
 * first). Shares `renderAgentManifest` (`@agentproto/app`) with `emitApp`
 * and the `agentproto agent create` CLI verb, so every authoring path emits
 * an identical manifest.
 *
 * The workspace is injected at registration time (same pattern as
 * `registerSelfInspectTool`, self-inspect-tool.ts) — the agent supplies only
 * the logical slug, never a disk path. A write only happens when the manifest
 * is absent, unless `force: true`; a validation or already-exists failure is
 * returned as an MCP tool error.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { renderAgentManifest } from "@agentproto/app"

/** Default model stamped into a created manifest when the caller names none. */
export const DEFAULT_CREATED_AGENT_MODEL = "claude-sonnet-5"

export interface CreateAgentInput {
  /** Workspace root the `.agents/<id>/AGENT.md` manifest is written under. */
  readonly workspace: string
  /** Agent slug (AIP-42 id, `@owner/` prefix allowed). */
  readonly id: string
  readonly description?: string
  readonly model?: string
  /** Overwrite an existing manifest. Defaults to false. */
  readonly force?: boolean
}

export interface CreatedAgent {
  readonly id: string
  readonly path: string
  readonly contents: string
}

/**
 * Core logic, extracted for testability. Throws an `Error` whose message is a
 * user-facing diagnostic on an invalid slug/handle
 * (`renderAgentManifest` → `defineAgent`) or on an existing manifest without
 * `force`.
 */
export async function createAgentManifest(input: CreateAgentInput): Promise<CreatedAgent> {
  const description =
    input.description !== undefined && input.description.trim() !== ""
      ? input.description.trim()
      : `Agent ${input.id}.`
  const model =
    input.model !== undefined && input.model.trim() !== "" ? input.model.trim() : DEFAULT_CREATED_AGENT_MODEL

  const rendered = renderAgentManifest(
    {
      schema: "agent/v1" as const,
      id: input.id,
      description,
      model,
      tools: [],
      skills: [],
      workflows: [],
      routines: [],
    },
    "",
    { dir: input.workspace, layout: "canonical" },
  )

  if (input.force !== true && existsSync(rendered.path)) {
    throw new Error(
      `create_agent: ${rendered.path} already exists (pass force: true to overwrite).`,
    )
  }

  await mkdir(dirname(rendered.path), { recursive: true })
  await writeFile(rendered.path, rendered.contents, "utf8")
  return { id: rendered.id, path: rendered.path, contents: rendered.contents }
}

/** Register the `create_agent` MCP tool on `server`. The workspace is
 *  injected at registration time; the caller supplies only the slug. */
export function registerCreateAgentTool(
  server: McpServer,
  opts: { workspace: string },
): void {
  server.tool(
    "create_agent",
    "Create an AIP-42 agent manifest (agent/v1 AGENT.md) for a slug in this workspace's " +
      "`.agents/<id>/AGENT.md` layout. Writes only when absent unless force:true. Returns the " +
      "resolved path. Validation failures (bad slug/description) are tool errors.",
    {
      id: z.string().describe("Agent slug (AIP-42 id; an @owner/ prefix is allowed)."),
      description: z
        .string()
        .optional()
        .describe("One-paragraph purpose. Defaults to \"Agent <id>.\"."),
      model: z
        .string()
        .optional()
        .describe(`Model id string. Defaults to "${DEFAULT_CREATED_AGENT_MODEL}".`),
      force: z.boolean().optional().describe("Overwrite an existing manifest. Defaults to false."),
    },
    async input => {
      try {
        const created = await createAgentManifest({
          workspace: opts.workspace,
          id: input.id,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ id: created.id, path: created.path }) },
          ],
        }
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        }
      }
    },
  )
}
