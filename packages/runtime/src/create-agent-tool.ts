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
 *
 * Grants: `grants` writes `actions.granted` (e.g. `["create_tool"]`). It is
 * opt-in and empty by default: a grant such as `create_tool` lets the agent
 * add code the daemon will run, an elevation nobody gets implicitly. Through
 * this verb a caller may only hand out a grant its OWN manifest holds (the
 * same daemon-resolved caller identity `create_tool` checks), so an agent
 * cannot mint a more privileged agent than itself; a call with no caller
 * identity cannot grant anything. The operator grants freely from the CLI
 * (`agentproto agent create --grant <action>`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { renderAgentManifest } from "@agentproto/app"
import { assertActionGranted, type CallerIdentityInput } from "./create-tool-tool.js"

/** Default model stamped into a created manifest when the caller names none. */
export const DEFAULT_CREATED_AGENT_MODEL = "claude-sonnet-5"

export interface CreateAgentInput extends CallerIdentityInput {
  /** Workspace root the `.agents/<id>/AGENT.md` manifest is written under. */
  readonly workspace: string
  /** Agent slug (AIP-42 id, `@owner/` prefix allowed). */
  readonly id: string
  readonly description?: string
  readonly model?: string
  /** Overwrite an existing manifest. Defaults to false. */
  readonly force?: boolean
  /** Actions written to `actions.granted`. Each must be held by the caller. */
  readonly grants?: readonly string[]
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

  const grants = normalizeGrants(input.grants)
  for (const grant of grants) {
    await assertActionGranted(
      {
        ...(input.callerAgentId !== undefined ? { agentId: input.callerAgentId } : {}),
        ...(input.callerAgentManifestPath !== undefined ? { manifestPath: input.callerAgentManifestPath } : {}),
        ...(input.callerSessionId !== undefined ? { sessionId: input.callerSessionId } : {}),
      },
      grant,
      input.workspace,
    )
  }

  const rendered = renderAgentManifest(
    {
      schema: "agent/v1" as const,
      id: input.id,
      description,
      model,
      tools: [],
      ...(grants.length > 0 ? { actions: { granted: [...grants] } } : {}),
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

/** Trim, drop duplicates, refuse an empty entry. */
function normalizeGrants(grants: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of grants ?? []) {
    const grant = raw.trim()
    if (grant === "") throw new Error("create_agent: an empty grant is not an action name.")
    if (!out.includes(grant)) out.push(grant)
  }
  return out
}

/** Register the `create_agent` MCP tool on `server`. The workspace and the
 *  daemon-resolved caller identity are injected at registration time; the
 *  caller supplies only the slug (and optional grants it already holds). */
export function registerCreateAgentTool(
  server: McpServer,
  opts: { workspace: string; agentId?: string; manifestPath?: string; sessionId?: string },
): void {
  server.tool(
    "create_agent",
    "Create an AIP-42 agent manifest (agent/v1 AGENT.md) for a slug in this workspace's " +
      "`.agents/<id>/AGENT.md` layout. Writes only when absent unless force:true. Returns the " +
      "resolved path. Validation failures (bad slug/description) are tool errors. `grants` " +
      "(default none) writes `actions.granted`; you can only grant actions your own manifest holds.",
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
      grants: z
        .array(z.string())
        .optional()
        .describe(
          "Actions to write to `actions.granted` (e.g. [\"create_tool\"]). Default: none. " +
            "Each must be granted to the calling agent's own manifest.",
        ),
    },
    async input => {
      try {
        const created = await createAgentManifest({
          workspace: opts.workspace,
          id: input.id,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.grants !== undefined ? { grants: input.grants } : {}),
          ...(opts.agentId !== undefined ? { callerAgentId: opts.agentId } : {}),
          ...(opts.manifestPath !== undefined ? { callerAgentManifestPath: opts.manifestPath } : {}),
          ...(opts.sessionId !== undefined ? { callerSessionId: opts.sessionId } : {}),
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
