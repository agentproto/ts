/**
 * `model_roles` — read-only MCP tool listing every model role, the model it
 * resolves to right now, and which layer supplied it. The precedence itself
 * (input > workspace > daemon > built-in default) is defined once, in
 * `model-roles.ts`; this file only loads the layers and exposes the result.
 *
 * Workflow `tool` steps call it (the daemon's `dispatchTool` reaches every
 * root-`/mcp` tool) to resolve a role at RUN time — a workflow's own
 * `reviewModelSmall`-style input is passed as `inputs` so an explicit input
 * still wins, and the tool reports `source: "input"` for it.
 *
 * Registered on the root `/mcp` server only, next to `config_get`.
 */

import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { loadConfig, type AgentprotoConfig } from "./config.js"
import {
  DEFAULT_MODEL_ROLES,
  listModelRoles,
  normalizeModelRoleValue,
  type ModelRoleValue,
  type ResolvedModelRole,
} from "./model-roles.js"
import { resolveWorktreeQueryRoot } from "./worktree-status.js"

export interface ModelRolesInput {
  /** Narrow to these roles. Omit for every built-in + configured role. */
  roles?: string[] | undefined
  /** Explicit per-role values (layer 1) — e.g. a workflow's own inputs. */
  inputs?: Record<string, unknown> | undefined
  /** Repo whose `agentproto.json` `models` is the workspace layer. */
  repoRoot?: string | undefined
  /** Workspace slug (resolved to its path). The active workspace when both are omitted. */
  workspaceSlug?: string | undefined
}

export interface ModelRolesDeps {
  /** Defaults to the real `loadConfig`. */
  loadCfg?: () => Promise<AgentprotoConfig>
  /** Defaults to {@link resolveWorktreeQueryRoot}. */
  resolveRoot?: (input: { repoRoot?: string | undefined; workspaceSlug?: string | undefined }) => Promise<string | undefined>
}

export interface ModelRolesOutput {
  roles: ResolvedModelRole[]
  /** role → resolved model id, for a workflow `$steps.<id>.models["review.small"]`-style read. */
  models: Record<string, string>
  /** Directory whose `agentproto.json` supplied the workspace layer, when one was found. */
  workspaceRoot?: string
  precedence: readonly string[]
}

const PRECEDENCE = ["input", "workspace", "daemon", "default"] as const

/** `models` from `<root>/agentproto.json`; undefined when absent/unreadable/malformed. */
export async function loadWorkspaceModelRoles(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(root, "agentproto.json"), "utf8")) as unknown
    const models = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).models : undefined
    return models && typeof models === "object" && !Array.isArray(models)
      ? (models as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

async function defaultResolveRoot(input: {
  repoRoot?: string | undefined
  workspaceSlug?: string | undefined
}): Promise<string | undefined> {
  const r = await resolveWorktreeQueryRoot(input)
  return r.ok ? r.repoRoot : undefined
}

export async function modelRoles(input: ModelRolesInput, deps: ModelRolesDeps = {}): Promise<ModelRolesOutput> {
  const cfg = await (deps.loadCfg ?? loadConfig)()
  const workspaceRoot = await (deps.resolveRoot ?? defaultResolveRoot)({
    repoRoot: input.repoRoot,
    workspaceSlug: input.workspaceSlug,
  })
  const workspace = workspaceRoot ? await loadWorkspaceModelRoles(workspaceRoot) : undefined

  const explicit: Record<string, ModelRoleValue> = {}
  for (const [role, raw] of Object.entries(input.inputs ?? {})) {
    const entry = normalizeModelRoleValue(raw)
    if (entry) explicit[role] = entry
  }

  const roles = listModelRoles({ input: explicit, workspace, daemon: cfg.models }, input.roles)
  return {
    roles,
    models: Object.fromEntries(roles.map(r => [r.role, r.model])),
    ...(workspace && workspaceRoot ? { workspaceRoot } : {}),
    precedence: PRECEDENCE,
  }
}

export function registerModelRolesTools(server: McpServer, deps: ModelRolesDeps = {}): void {
  server.tool(
    "model_roles",
    "List model ROLES (review.small, review.large, review.pr, judge.session, …) — the one config for which " +
      "model a reviewer/judge uses — each with the model it resolves to and where that value came from. " +
      "Precedence, highest first: `input` (the `inputs` you pass, e.g. a workflow's explicit model input) > " +
      "`workspace` (the repo's `agentproto.json` `models`) > `daemon` (`~/.agentproto/config.json` `models`, " +
      "set via `config_set models.<role>`) > `default` (built-in table). A role no layer knows is omitted. " +
      `Built-in roles: ${Object.keys(DEFAULT_MODEL_ROLES).join(", ")}. Returns \`roles\` (role, model, source, ` +
      "route?, profile?) and a flat `models` map for use as a workflow step output.",
    {
      roles: z.array(z.string()).optional().describe("Only these roles. Omit for every built-in + configured role."),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe("Explicit role → model overrides (layer 1). Empty/undefined values are ignored."),
      repoRoot: z.string().optional().describe("Repo root whose agentproto.json `models` is the workspace layer. Wins over `workspaceSlug`."),
      workspaceSlug: z.string().optional().describe("Workspace slug. The active workspace when both are omitted."),
    },
    async args => ({
      content: [{ type: "text", text: JSON.stringify(await modelRoles(args, deps)) }],
    }),
  )
}
