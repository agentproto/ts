/**
 * MCP tools for user-owned spawn presets ("favorites") — the MCP twin of the
 * `/user-presets` HTTP routes (`http-server.ts`, ~L3753). Registered like the
 * other preset tools (`harness-preset-tools.ts`): no host wiring beyond an
 * optional session registry, since the store reads/writes the fixed
 * `~/.agentproto/presets.json` directly.
 *
 * `userPresetSchema` (`user-presets.ts`) stays the single validation
 * boundary CLI, HTTP and MCP all go through — this file reuses its `.shape`
 * directly as the `user_preset_save` input, so a bad body is rejected by the
 * exact same rules on every surface (the MCP SDK enforces the shape before
 * the handler runs; the HTTP route enforces it via `saveUserPreset`'s own
 * `.parse()`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  deleteUserPreset,
  deriveRecentSpawnConfigs,
  getUserPreset,
  listUserPresets,
  saveUserPreset,
  userPresetSchema,
  type RecentSpawnConfig,
  type UserPreset,
} from "./user-presets.js"
import type { SessionsRegistry } from "./sessions.js"

function text(value: object): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

export interface UserPresetToolsDeps {
  /** Backs `user_preset_list({ includeRecent: true })` — only `.list()` is
   *  used, so a narrow stub is enough in tests. Omitted (e.g. a scoped
   *  orchestrator server with no registry wired) means `includeRecent` is
   *  accepted but always resolves an empty `recent` array rather than
   *  erroring. */
  registry?: Pick<SessionsRegistry, "list">
}

export function registerUserPresetTools(server: McpServer, deps: UserPresetToolsDeps = {}): void {
  const { registry } = deps

  // ── user_preset_list ────────────────────────────────────────────
  // Deliberately NOT built on `registerBuiltinTool` + `paginated()`: every
  // other list tool in this file returns one homogeneous array, but this one
  // returns `presets` plus an optional, non-paginated `recent` side list —
  // a shape `paginated()` has no hook for. Mirrors the HTTP route's own
  // unpaginated `{ presets: [...] }` envelope instead (a user's favorite
  // count is realistically small; GET /user-presets has no pagination
  // either).
  server.tool(
    "user_preset_list",
    "List the user's saved spawn presets (\"favorites\") from " +
      "`~/.agentproto/presets.json`. Each preset is a reusable, named " +
      "subset of the spawn/session config axes (adapter, model, route, " +
      "access, posture, effort, contextProfile, cwd, skills, bundles, " +
      "browser) plus `lastUsedAt` (ISO 8601), stamped the last time a spawn " +
      "resolved a `presetId` to it. Pass `includeRecent: true` to ALSO " +
      "return up to 5 distinct recent spawn configurations (adapter, model, " +
      "profileRef, cwd) derived from this host's own recent session " +
      "history, each marked `recent: true` — not persisted, a candidate " +
      "list for \"save as favorite\" rather than an actual preset.",
    {
      includeRecent: z
        .boolean()
        .optional()
        .describe("Also return up to 5 recent distinct spawn configs derived from session history."),
    },
    async ({ includeRecent }) => {
      const presets = await listUserPresets()
      const recent: RecentSpawnConfig[] | undefined = includeRecent
        ? deriveRecentSpawnConfigs(registry?.list() ?? [])
        : undefined
      return text({ presets, ...(recent ? { recent } : {}) })
    },
  )

  // ── user_preset_save ────────────────────────────────────────────
  // Upsert by id, same as POST /user-presets. The input shape IS
  // `userPresetSchema.shape` (not a redeclaration), so the MCP SDK's own
  // argument validation already enforces everything `saveUserPreset`'s
  // internal `.parse()` would — a bad body (e.g. an uppercase id) never
  // reaches the handler at all, same rejection either surface goes through.
  server.tool(
    "user_preset_save",
    "Create or update (upsert by id) a user spawn preset (\"favorite\"). " +
      "`id` must be lowercase kebab-case. Every other field is an optional " +
      "spawn/session config axis a future `agent_start({ presetId })` (or " +
      "`/sessions/agent`, `/sessions/chat`) resolves and applies at " +
      "lower precedence than the caller's own explicit fields. Editing an " +
      "existing preset without naming `lastUsedAt` preserves its current " +
      "stamp rather than clearing it.",
    userPresetSchema.shape,
    async input => {
      try {
        await saveUserPreset(input as UserPreset)
        const saved = await getUserPreset(input.id)
        return text({ preset: saved })
      } catch (err) {
        return errorText(`user_preset_save failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  // ── user_preset_delete ──────────────────────────────────────────
  server.tool(
    "user_preset_delete",
    "Delete a user spawn preset by id. Idempotent: a missing id returns " +
      "`{ deleted: false }`.",
    {
      id: z.string().describe("The preset id to delete."),
    },
    async ({ id }) => {
      try {
        const deleted = await deleteUserPreset(id)
        return text({ deleted })
      } catch (err) {
        return errorText(`user_preset_delete failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )
}
